import type { SignedClient } from './client.js'
import type { Rng } from './rng.js'
import { uuidFrom } from './rng.js'
import { drawBetAmount, generateRound, TARGET_RTP, type BetRange } from './simulation.js'

export interface RunOptions {
  /** Distinct users to play (must already be seeded). */
  users: number
  roundsPerUser: number
  currency: string
  betRange: BetRange
  /** User-id prefix; user `i` plays as `${userPrefix}${i}` (1-based). */
  userPrefix: string
  /** Acceptable absolute deviation of global RTP from the target. */
  tolerance: number
}

export interface RunResult {
  rounds: number
  totalBet: number
  totalWin: number
  observedRtp: number
  /** Spread of per-user RTPs, a sanity check that variance is present. */
  perUserRtp: { min: number; max: number; count: number }
  pass: boolean
  window: { from: string; to: string }
}

/**
 * Plays randomized rounds against the live endpoint, then checks observed global
 * RTP against {@link TARGET_RTP} within `tolerance`. Fully deterministic in the
 * injected `rng` so a seed reproduces byte-identical traffic.
 *
 * The report window is widened by 1s on each side: the ledger stamps
 * `created_at` server-side, so clock skew between this process and the DB could
 * otherwise drop boundary rows.
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
