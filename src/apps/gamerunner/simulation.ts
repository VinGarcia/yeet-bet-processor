import type { Rng } from './rng.js'
import { uuidFrom } from './rng.js'

// Target global RTP. Wins are drawn so expected payout equals this fraction of
// the bet, making OBSERVED RTP converge here by LLN — not a "pay 95%" rule.
export const TARGET_RTP = 0.95

// Probability a round wins at all. Splitting "wins?" from "how much?" gives the
// payout real variance (most rounds pay 0, winners pay several × the bet).
export const WIN_PROBABILITY = 0.8

/** Actions one round emits: always a `bet`, a `win` only when the round wins. */
export interface Round {
  bet: { actionId: string; amount: number }
  win?: { actionId: string; amount: number }
}

/**
 * Generates one round. With probability `p` ({@link WIN_PROBABILITY}) the round
 * pays `bet * U`, `U` uniform on `[0, 2*TARGET_RTP/p]`; else nothing. Then
 * `E[payout] = p * bet * (TARGET_RTP/p) = bet * TARGET_RTP`, so expected RTP is
 * exactly {@link TARGET_RTP} with real variance. RNG draws happen in a FIXED
 * order (UUIDs, win coin, multiplier) for per-seed reproducibility.
 */
export function generateRound(rng: Rng, betAmount: number): Round {
  const betActionId = uuidFrom(rng)
  const winActionId = uuidFrom(rng)
  const round: Round = { bet: { actionId: betActionId, amount: betAmount } }

  if (rng() < WIN_PROBABILITY) {
    const maxMultiplier = (2 * TARGET_RTP) / WIN_PROBABILITY
    const multiplier = rng() * maxMultiplier
    const winAmount = Math.round(betAmount * multiplier)
    // Drop a 0 payout: `amount` must be a positive integer per validateAction.
    if (winAmount > 0) {
      round.win = { actionId: winActionId, amount: winAmount }
    }
  }

  return round
}

export interface BetRange {
  min: number
  max: number
}

export function drawBetAmount(rng: Rng, range: BetRange): number {
  if (range.max <= range.min) {
    return range.min
  }
  const span = range.max - range.min + 1
  return range.min + Math.floor(rng() * span)
}
