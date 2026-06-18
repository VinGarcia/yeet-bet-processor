import type { SignedClient } from './client.js'
import type { Rng } from './rng.js'
import { uuidFrom } from './rng.js'
import { drawBetAmount, generateRound, TARGET_RTP, type BetRange } from './simulation.js'

/** Everything needed to drive one simulated run against a live endpoint. */
export interface RunOptions {
  /** Distinct users to play (must already be seeded with balances). */
  users: number
  /** Rounds each user plays. Total rounds = `users * roundsPerUser`. */
  roundsPerUser: number
  /** Currency every round is denominated in. */
  currency: string
  /** Inclusive bet-size bounds (integer minor units), drawn per round. */
  betRange: BetRange
  /** User-id prefix; user `i` plays as `${userPrefix}${i}` (1-based). */
  userPrefix: string
  /** Acceptable absolute deviation of the global RTP from the target. */
  tolerance: number
}

/** The outcome of a run, reported by the runner and asserted by the test. */
export interface RunResult {
  /** Total rounds (= bets) submitted. */
  rounds: number
  /** Sum of all live bets, from the casino RTP report. */
  totalBet: number
  /** Sum of all live wins, from the casino RTP report. */
  totalWin: number
  /** Observed global RTP (`totalWin / totalBet`) for the run currency. */
  observedRtp: number
  /** Spread of per-user RTPs, a sanity check that variance is present. */
  perUserRtp: { min: number; max: number; count: number }
  /** True iff `|observedRtp - TARGET_RTP| <= tolerance`. */
  pass: boolean
  /** The half-open time window `[from, to)` the report was queried over. */
  window: { from: string; to: string }
}

/**
 * Plays `users * roundsPerUser` randomized rounds against the live endpoint,
 * then queries the casino + per-user RTP reports for the run's time window and
 * checks the observed global RTP against {@link TARGET_RTP} within `tolerance`.
 *
 * The whole run is deterministic in `rng`: bet sizes, win coin-flips, win
 * multipliers and every `action_id`/`game_id` are drawn from it, so two runs
 * with the same seed submit byte-identical traffic. The RNG is injected (not a
 * module-global) so a test can pin a seed without monkey-patching.
 *
 * `now()` bounds the report window. We capture `from` before the first request
 * and `to` after the last, then widen by one second on each side so a clock
 * skew between this process and the DB's `now()` (the ledger stamps
 * `created_at` server-side) cannot drop boundary rows from the window.
 */
export async function runSimulation(
  client: SignedClient,
  rng: Rng,
  opts: RunOptions,
  now: () => Date = () => new Date(),
): Promise<RunResult> {
  const from = new Date(now().getTime() - 1000).toISOString()

  let submitted = 0
  for (let u = 1; u <= opts.users; u++) {
    const userId = `${opts.userPrefix}${u}`
    for (let r = 0; r < opts.roundsPerUser; r++) {
      const betAmount = drawBetAmount(rng, opts.betRange)
      const round = generateRound(rng, betAmount)
      const gameId = uuidFrom(rng)

      const actions: Array<Record<string, unknown>> = [
        { action: 'bet', action_id: round.bet.actionId, amount: round.bet.amount },
      ]
      if (round.win !== undefined) {
        actions.push({ action: 'win', action_id: round.win.actionId, amount: round.win.amount })
      }

      await client.process({
        user_id: userId,
        currency: opts.currency,
        game: 'gamerunner:rtp',
        game_id: gameId,
        finished: true,
        actions,
      })
      submitted++
    }
  }

  const to = new Date(now().getTime() + 1000).toISOString()

  const casino = (await client.casinoRtp(from, to)).find((c) => c.currency === opts.currency)
  const totalBet = casino?.total_bet ?? 0
  const totalWin = casino?.total_win ?? 0
  const observedRtp = totalBet > 0 ? totalWin / totalBet : 0

  const perUser = await client.usersRtp(from, to)
  const rtps = perUser.flatMap((u) => (u.rtp !== null ? [u.rtp] : []))
  const perUserRtp = {
    min: rtps.length > 0 ? Math.min(...rtps) : 0,
    max: rtps.length > 0 ? Math.max(...rtps) : 0,
    count: perUser.length,
  }

  return {
    rounds: submitted,
    totalBet,
    totalWin,
    observedRtp,
    perUserRtp,
    pass: Math.abs(observedRtp - TARGET_RTP) <= opts.tolerance,
    window: { from, to },
  }
}
