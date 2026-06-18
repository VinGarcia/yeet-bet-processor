/** A user's balance in one currency. `balance` is in minor units (integer) so money math stays exact. */
export interface Wallet {
  userId: string
  currency: string
  balance: number
}

export interface BetAction {
  action: 'bet'
  actionId: string
  amount: number
}

export interface WinAction {
  action: 'win'
  actionId: string
  amount: number
}

/**
 * Reverses a prior `bet`/`win` referenced by `originalActionId`, in the OPPOSITE
 * direction (a bet's rollback credits, a win's debits). Carries no `amount` — it
 * is derived from the original. One arriving before its original makes that later
 * original a noop (pre-rollback).
 */
export interface RollbackAction {
  action: 'rollback'
  actionId: string
  originalActionId: string
}

// Discriminated on `action`; bet/win amounts are always > 0 (direction is the variant).
export type Action = BetAction | WinAction | RollbackAction

/** A batch of actions for one user/currency, processed in request order. */
export interface UserActions {
  userId: string
  currency: string
  game?: string
  gameId?: string
  actions: Action[]
}

/**
 * One casino-wide RTP row, per `currency` over a window. Totals and `rtp` EXCLUDE
 * reversed rows; the clawed-back amounts are surfaced separately so they don't
 * pollute headline RTP. `rtp` is `totalWin / totalBet`, or `null` when totalBet is 0.
 */
export interface CasinoRtpRow {
  currency: string
  rounds: number
  totalBet: number
  totalWin: number
  rtp: number | null
  rolledBackBet: number
  rolledBackWin: number
}

/** A {@link CasinoRtpRow} additionally grouped by `userId`. */
export interface UserRtpRow extends CasinoRtpRow {
  userId: string
}
