/**
 * A user's balance in a single currency, expressed in the domain's camelCase
 * shape. `balance` is in the smallest currency unit (an integer count) so money
 * math stays exact. Adapters translate the storage row (snake_case) to/from
 * this entity at their boundary.
 */
export interface Wallet {
  userId: string
  currency: string
  balance: number
}

/**
 * A single bet within a process request, in the camelCase domain shape.
 * `amount` is a positive integer in the smallest currency unit; it debits the
 * wallet and may overdraw (rejected per-step).
 */
export interface BetAction {
  action: 'bet'
  actionId: string
  amount: number
}

/**
 * A single win within a process request, in the camelCase domain shape.
 * `amount` is a positive integer in the smallest currency unit; it credits the
 * wallet and never overdraws.
 */
export interface WinAction {
  action: 'win'
  actionId: string
  amount: number
}

/**
 * A single rollback within a process request, in the camelCase domain shape. It
 * reverses a prior `bet` or `win` referenced by `originalActionId` — the
 * direction is the OPPOSITE of the original (a bet's rollback credits, a win's
 * debits). It carries NO `amount`: the amount is derived from the referenced
 * original. A rollback that arrives before its original is recorded so the
 * later original becomes a noop (pre-rollback).
 */
export interface RollbackAction {
  action: 'rollback'
  actionId: string
  originalActionId: string
}

/**
 * A single action to apply, discriminated on `action`. For `bet`/`win` the
 * direction (debit vs credit) is encoded by the variant, not by the sign of
 * `amount` (always > 0); a `rollback` reverses the original it references.
 */
export type Action = BetAction | WinAction | RollbackAction

/**
 * A batch of actions to apply for one user/currency, with the optional game
 * context the caller echoes back. `actions` are processed in request order.
 */
export interface UserActions {
  userId: string
  currency: string
  game?: string
  gameId?: string
  actions: Action[]
}

/**
 * One row of a casino-wide RTP report, aggregated per `currency` over a time
 * window. RTP and the totals deliberately EXCLUDE reversed rows (those whose
 * `rolledback` flag is true); the reversed amounts are surfaced separately in
 * `rolledBackBet`/`rolledBackWin` so a reader can see what was clawed back
 * without it polluting the headline RTP.
 *
 * `rounds` is the count of non-reversed `bet` rows in the window (one bet = one
 * round). `rtp` is `totalWin / totalBet`, or `null` when `totalBet` is 0 (no
 * non-reversed bets — an undefined ratio). All amounts are integer minor units.
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

/**
 * One row of a per-user RTP report: a {@link CasinoRtpRow} additionally grouped
 * by `userId`, so the aggregate is per (`userId`, `currency`).
 */
export interface UserRtpRow extends CasinoRtpRow {
  userId: string
}
