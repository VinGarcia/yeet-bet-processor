import type { UserActions, Wallet } from '../../core/entities.js'

/**
 * The Repo port. Concrete implementations (e.g. the Kysely repo) satisfy this
 * interface so the application core depends on the abstraction, not the driver.
 */
export interface Repo {
  checkConnection(): Promise<void>

  /**
   * Returns the wallet for a user in a given currency, or `undefined` when no
   * wallet row exists.
   */
  findWallet(userId: string, currency: string): Promise<Wallet | undefined>

  /**
   * Applies a batch of actions (`bet` debits, `win` credits) atomically in a
   * single DB transaction. Idempotent on `actionId`: an action already persisted
   * is not re-applied and reuses its original `txId`. New actions are applied in
   * request order against a running balance read under a row lock; the first
   * `bet` that would drive the balance below zero throws `InsufficientFundsError`
   * and rolls the whole batch back (wins never overdraw).
   */
  processActions(
    input: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }>
}
