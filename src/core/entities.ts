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
 * `amount` is a positive integer in the smallest currency unit. `win` and
 * `rollback` actions are future slices and not modelled yet.
 */
export interface BetAction {
  action: 'bet'
  actionId: string
  amount: number
}
