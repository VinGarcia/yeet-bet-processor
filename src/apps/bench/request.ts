// Pure builder for the benchmark's `/process` bodies; `main` owns reproducibility.

export interface BetBodyParams {
  userId: string
  currency: string
  amount: number
  actionId: string
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
