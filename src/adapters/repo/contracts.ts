import type { CasinoRtpRow, UserActions, UserRtpRow, Wallet } from '../../core/entities.js'

/** Default page size for an RTP report when the caller omits `limit`. */
export const RTP_DEFAULT_LIMIT = 100
/** Hard cap on an RTP report page size; a larger `limit` is clamped to this. */
export const RTP_MAX_LIMIT = 1000

/**
 * Inputs for an RTP report query. `from`/`to` bound the window on `created_at`
 * as a half-open range `[from, to)` (`from` inclusive, `to` exclusive), so two
 * adjacent windows never double-count a boundary row. `cursor` is the opaque
 * keyset token returned by a prior page
 * (decode/encode is the adapter's concern). `limit` is the page size, defaulted
 * to {@link RTP_DEFAULT_LIMIT} and clamped to {@link RTP_MAX_LIMIT}.
 */
export interface RtpReportQuery {
  from: Date
  to: Date
  cursor?: string
  limit?: number
}

/**
 * One page of an RTP report: the `items` for this page and an opaque `cursor`
 * to fetch the next page, or `null` when the result set is exhausted.
 */
export interface RtpReportPage<Row> {
  items: Row[]
  cursor: string | null
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
   * Applies a batch of actions (`bet` debits, `win` credits, `rollback`
   * reverses) atomically in a single DB transaction. Idempotent on `actionId`:
   * an action already persisted is not re-applied and reuses its original
   * `txId`. New actions are applied in request order against a running balance
   * read under a row lock; the first `bet` (or win clawback) that would drive
   * the balance below zero throws `InsufficientFundsError` and rolls the whole
   * batch back (wins never overdraw). A `rollback` reverses its referenced
   * original in the opposite direction; one referencing a not-yet-seen original
   * is recorded so that original later becomes a noop (pre-rollback).
   */
  processActions(
    input: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }>

  /**
   * Per-user RTP report over `[from, to)`, grouped by (`userId`, `currency`).
   * Reversed rows (`rolledback = true`) are excluded from `rounds`/`totalBet`/
   * `totalWin` and surfaced separately in `rolledBackBet`/`rolledBackWin`. Pages
   * via a keyset cursor on (`currency`, `userId`); the page `cursor` is `null`
   * once exhausted.
   */
  userRtpReport(query: RtpReportQuery): Promise<RtpReportPage<UserRtpRow>>

  /**
   * Casino-wide RTP report over `[from, to)`, grouped by `currency` only (RTP of
   * different currencies cannot be summed into one). Same reversed-exclusion and
   * keyset-on-`currency` pagination as {@link Repo.userRtpReport}.
   */
  casinoRtpReport(query: RtpReportQuery): Promise<RtpReportPage<CasinoRtpRow>>
}
