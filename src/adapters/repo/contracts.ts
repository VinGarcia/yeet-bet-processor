import type { Wallet } from '../../core/entities.js'

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
}
