import type { BetAction, Wallet } from '../../core/entities.js'

/**
 * Input to {@link Repo.processActions}: the player/currency the batch applies
 * to, the optional game context echoed back, and the ordered list of bets.
 */
export interface ProcessActionsInput {
  userId: string
  currency: string
  game?: string
  gameId?: string
  actions: BetAction[]
}

/**
 * Result of processing a batch: the wallet balance after the net debit and one
 * entry per input action (in request order) mapping its `actionId` to the
 * ledger row `txId` (the original id for idempotent replays).
 */
export interface ProcessActionsResult {
  balance: number
  transactions: { actionId: string; txId: string }[]
  gameId?: string
}

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
   * Applies a batch of bets atomically in a single DB transaction. Idempotent
   * on `actionId`: an action already persisted is not re-applied and reuses its
   * original `txId`. If the wallet cannot cover the net debit of the new bets
   * the whole transaction rolls back (throws `InsufficientFundsError`).
   */
  processActions(input: ProcessActionsInput): Promise<ProcessActionsResult>
}
