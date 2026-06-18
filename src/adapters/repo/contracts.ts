import type { CasinoRtpRow, UserActions, UserRtpRow, Wallet } from '../../core/entities.js'

export const RTP_DEFAULT_LIMIT = 100
/** Hard cap on an RTP page size; a larger `limit` is clamped to this. */
export const RTP_MAX_LIMIT = 1000

/** RTP query inputs. `from`/`to` bound `created_at` as a half-open `[from, to)` range. */
export interface RtpReportQuery {
  from: Date
  to: Date
  cursor?: string
  limit?: number
}

/** One page: `items` plus an opaque next-page `cursor`, or `null` when exhausted. */
export interface RtpReportPage<Row> {
  items: Row[]
  cursor: string | null
}

/** The Repo port: the core depends on this abstraction, not the driver. */
export interface Repo {
  checkConnection(): Promise<void>

  findWallet(userId: string, currency: string): Promise<Wallet | undefined>

  /**
   * Applies a batch atomically. Idempotent on `actionId` (replays reuse their
   * original `txId`). New actions apply in request order against a row-locked
   * balance; the first bet (or win clawback) below zero throws
   * `InsufficientFundsError` and rolls the whole batch back. A rollback reverses
   * its original in the opposite direction; one referencing a not-yet-seen
   * original makes that original a later noop (pre-rollback).
   */
  processActions(
    input: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }>

  /**
   * Per-user RTP over `[from, to)`, grouped by (`userId`, `currency`). Reversed
   * rows are excluded from the totals and surfaced separately. Keyset cursor on
   * (`currency`, `userId`).
   */
  userRtpReport(query: RtpReportQuery): Promise<RtpReportPage<UserRtpRow>>

  /**
   * Casino-wide RTP grouped by `currency` only (cross-currency RTP can't be
   * summed). Same reversed-exclusion and keyset pagination as {@link Repo.userRtpReport}.
   */
  casinoRtpReport(query: RtpReportQuery): Promise<RtpReportPage<CasinoRtpRow>>
}
