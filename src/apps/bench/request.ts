/**
 * Builds the `/process` request bodies the benchmark fires. Kept tiny and pure
 * (no I/O, no randomness of its own) so `main` owns reproducibility via the
 * seeded RNG and a test can assert the exact wire shape.
 */

export interface BetBodyParams {
  /** Seeded wallet owner the bet is charged to. */
  userId: string
  /** Currency of the wallet/bet. */
  currency: string
  /** Bet size in integer minor units. */
  amount: number
  /** Unique idempotency key for this action (a UUID). */
  actionId: string
  /** Round identifier (a UUID). */
  gameId: string
}

/** A single-bet, finished `/process` payload for one seeded user. */
export function makeBetBody(p: BetBodyParams): {
  user_id: string
  currency: string
  game: string
  game_id: string
  finished: boolean
  actions: Array<Record<string, unknown>>
} {
  return {
    user_id: p.userId,
    currency: p.currency,
    game: 'bench:load',
    game_id: p.gameId,
    finished: true,
    actions: [{ action: 'bet', action_id: p.actionId, amount: p.amount }],
  }
}
