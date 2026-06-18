import type { Rng } from './rng.js'
import { uuidFrom } from './rng.js'

/**
 * The target global return-to-player. Every round's win is drawn so that its
 * expected payout is exactly this fraction of the bet, which makes the OBSERVED
 * RTP converge here by the law of large numbers — never via a trivial
 * "always pay 95% of the bet" rule.
 */
export const TARGET_RTP = 0.95

/**
 * The probability that a round pays out at all. A losing round (prob `1 - p`)
 * pays nothing; a winning round (prob `p`) pays a randomized multiple of the
 * bet. Splitting "does it win?" from "how much?" is what gives the per-round
 * payout its variance (most rounds pay 0, winners pay several times the bet),
 * so the runner exercises convergence rather than a near-constant return.
 */
export const WIN_PROBABILITY = 0.8

/**
 * The two ledger actions a single simulated round emits: always a `bet`, and a
 * `win` ONLY when the round wins (a losing round emits no win action at all).
 * Amounts are integer minor units, matching the endpoint's contract.
 */
export interface Round {
  bet: { actionId: string; amount: number }
  win?: { actionId: string; amount: number }
}

/**
 * Generates one round for a given bet size.
 *
 * Distribution (documented in the README): with probability {@link WIN_PROBABILITY}
 * `p` the round wins and pays `bet * U`, where `U` is uniform on
 * `[0, 2 * TARGET_RTP / p]`; with probability `1 - p` it pays nothing. Then
 *
 *   E[payout] = p * E[bet * U] = p * bet * (TARGET_RTP / p) = bet * TARGET_RTP,
 *
 * so the expected RTP is exactly {@link TARGET_RTP} while the realized payout
 * carries real variance (zero on a loss, up to `2 * TARGET_RTP / p` × bet on a
 * win). The win amount is rounded to an integer minor unit; over many rounds the
 * sub-unit rounding is symmetric noise and does not bias the mean.
 *
 * Four RNG draws are consumed per round in a FIXED order (two per UUID's random
 * stream is variable, so UUIDs are drawn first, then the win coin, then the
 * multiplier) so the sequence is reproducible for a given seed.
 */
export function generateRound(rng: Rng, betAmount: number): Round {
  const betActionId = uuidFrom(rng)
  const winActionId = uuidFrom(rng)
  const round: Round = { bet: { actionId: betActionId, amount: betAmount } }

  if (rng() < WIN_PROBABILITY) {
    const maxMultiplier = (2 * TARGET_RTP) / WIN_PROBABILITY
    const multiplier = rng() * maxMultiplier
    const winAmount = Math.round(betAmount * multiplier)
    // A winning round always emits a win action; a 0 payout (multiplier ≈ 0) is
    // dropped because `amount` must be a positive integer per `validateAction`.
    if (winAmount > 0) {
      round.win = { actionId: winActionId, amount: winAmount }
    }
  }

  return round
}

/** Inclusive integer bet-size bounds, drawn uniformly per round. */
export interface BetRange {
  min: number
  max: number
}

/** Draws an integer bet amount in `[range.min, range.max]` from the RNG. */
export function drawBetAmount(rng: Rng, range: BetRange): number {
  if (range.max <= range.min) {
    return range.min
  }
  const span = range.max - range.min + 1
  return range.min + Math.floor(rng() * span)
}
