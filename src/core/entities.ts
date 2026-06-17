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
 * A single action to apply, discriminated on `action`. The direction (debit vs
 * credit) is encoded by the variant, not by the sign of `amount` (always > 0).
 * `rollback` is a future slice and not modelled yet.
 */
export type Action = BetAction | WinAction

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
