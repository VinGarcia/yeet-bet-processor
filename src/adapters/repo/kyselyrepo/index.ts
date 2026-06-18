import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Selectable } from 'kysely'
import {
  RTP_DEFAULT_LIMIT,
  RTP_MAX_LIMIT,
  type Repo,
  type RtpReportPage,
  type RtpReportQuery,
} from '../contracts.js'
import type { CasinoRtpRow, UserActions, UserRtpRow, Wallet } from '../../../core/entities.js'
import { validateAction } from '../../../core/validators.js'
import { BadRequestError, InsufficientFundsError } from '../../../core/errors.js'
import type { DB, TransactionsTable } from './schema.js'

/**
 * The raw aggregate row a casino-wide RTP query returns. `count`/`sum` come back
 * from the driver as strings (Postgres `bigint`/`numeric`), converted to numbers
 * at the boundary — exact below 2^53, consistent with the rest of the repo.
 */
interface CasinoRtpDbRow {
  currency: string
  rounds: string
  total_bet: string
  total_win: string
  rolled_back_bet: string
  rolled_back_win: string
}
/** A per-user aggregate row: a {@link CasinoRtpDbRow} plus its `user_id`. */
interface UserRtpDbRow extends CasinoRtpDbRow {
  user_id: string
}

/** Clamps a caller-supplied page size to [1, RTP_MAX_LIMIT], defaulting it. */
function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return RTP_DEFAULT_LIMIT
  return Math.min(Math.max(limit, 1), RTP_MAX_LIMIT)
}

/**
 * Encodes the keyset (the last row's ordering columns) into an opaque base64url
 * cursor. The client echoes it back verbatim to fetch the next page; it never
 * needs to understand the shape, so we are free to change it later.
 */
function encodeCursor(keyset: Record<string, string>): string {
  return Buffer.from(JSON.stringify(keyset)).toString('base64url')
}

/** Decodes a casino cursor (`{ currency }`); a malformed token is a 400. */
function decodeCasinoCursor(cursor: string): { currency: string } {
  const obj = decodeCursor(cursor)
  if (typeof obj.currency === 'string') return { currency: obj.currency }
  throw new BadRequestError('invalid cursor')
}

/** Decodes a per-user cursor (`{ currency, userId }`); malformed → 400. */
function decodeUserCursor(cursor: string): { currency: string; userId: string } {
  const obj = decodeCursor(cursor)
  if (typeof obj.currency === 'string' && typeof obj.userId === 'string') {
    return { currency: obj.currency, userId: obj.userId }
  }
  throw new BadRequestError('invalid cursor')
}

/** Parses a base64url cursor into a string→string map; malformed → 400. */
function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    /* fall through to the shared error below */
  }
  throw new BadRequestError('invalid cursor')
}

/**
 * Maps a casino aggregate row to the domain entity, computing `rtp` here in app
 * code (not SQL): `totalWin / totalBet`, or `null` when there are no non-reversed
 * bets (an undefined ratio rather than a divide-by-zero).
 */
/**
 * The five RTP aggregate expressions shared by the per-user and casino-wide
 * reports. `rounds`/`total_bet`/`total_win` sum the live (non-reversed) rows;
 * `rolled_back_bet`/`rolled_back_win` surface the reversed amounts separately.
 * Identical in both reports, which differ only in their GROUP BY and keyset.
 */
const rtpAggregates = sql`
  count(*) FILTER (WHERE type = 'bet' AND NOT rolledback) AS rounds,
  coalesce(sum(amount) FILTER (WHERE type = 'bet' AND NOT rolledback), 0) AS total_bet,
  coalesce(sum(amount) FILTER (WHERE type = 'win' AND NOT rolledback), 0) AS total_win,
  coalesce(sum(amount) FILTER (WHERE type = 'bet' AND rolledback), 0) AS rolled_back_bet,
  coalesce(sum(amount) FILTER (WHERE type = 'win' AND rolledback), 0) AS rolled_back_win`

/**
 * The shared window predicate for both reports: a half-open `[from, to)` range
 * on `created_at` plus the `type IN ('bet', 'win')` filter. Half-open so two
 * adjacent windows (`…to = T` then `from = T…`) never double-count a row stamped
 * exactly at `T`. Each report appends its own keyset predicate after this.
 */
function rtpWindow(from: Date, to: Date) {
  return sql`created_at >= ${from} AND created_at < ${to} AND type IN ('bet', 'win')`
}

function mapCasinoRow(r: CasinoRtpDbRow): CasinoRtpRow {
  const totalBet = Number(r.total_bet)
  const totalWin = Number(r.total_win)
  return {
    currency: r.currency,
    rounds: Number(r.rounds),
    totalBet,
    totalWin,
    rtp: totalBet === 0 ? null : totalWin / totalBet,
    rolledBackBet: Number(r.rolled_back_bet),
    rolledBackWin: Number(r.rolled_back_win),
  }
}

/**
 * A `transactions` row in the camelCase domain shape, with `amount` as a JS
 * number (the driver returns the `bigint` as a string). {@link parseTxFromDB}
 * maps a stored snake_case row into this shape.
 */
export type Transaction = {
  id: string
  actionId: string
  userId: string
  currency: string
  game: string | null
  gameId: string | null
  type: string
  amount: number
  originalActionId: string | null
  rolledBack: boolean
}

/** Maps a stored `transactions` row to the camelCase {@link Transaction}. */
function parseTxFromDB(row: Selectable<TransactionsTable>): Transaction {
  return {
    id: row.id,
    actionId: row.action_id,
    userId: row.user_id,
    currency: row.currency,
    game: row.game,
    gameId: row.game_id,
    type: row.type,
    amount: Number(row.amount),
    originalActionId: row.original_action_id,
    rolledBack: row.rolledback,
  }
}

/**
 * Kysely-backed implementation of the {@link Repo} port. It owns all SQL/driver
 * concerns so the application core depends only on the abstraction.
 */
export class KyselyRepo implements Repo {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Runs a trivial query to confirm the database is reachable. Resolves on
   * success; lets the driver error propagate on failure so callers can react.
   */
  async checkConnection(): Promise<void> {
    await sql`select 1`.execute(this.db)
  }

  /**
   * Looks up a single wallet by its (`user_id`, `currency`) primary key and
   * translates the snake_case storage row into the camelCase domain entity.
   * Returns `undefined` when no wallet row exists.
   */
  async findWallet(userId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.db
      .selectFrom('wallets')
      .where('user_id', '=', userId)
      .where('currency', '=', currency)
      .selectAll()
      .executeTakeFirst()

    if (row === undefined) return undefined

    // `balance` is a Postgres `bigint` the driver returns as a string; convert
    // to a JS number here, at the adapter boundary (precision-safe below 2^53).
    return { userId: row.user_id, currency: row.currency, balance: Number(row.balance) }
  }

  /**
   * Applies a batch of actions (`bet` debits, `win` credits, `rollback`
   * reverses) in a single transaction:
   *
   *   1. Dedup by `actionId` in request order (first wins), assigning each
   *      unique action a fresh `txId`. Validity is the caller's contract
   *      (enforced by the core `validateAction`); the repo trusts it.
   *   2. Ensure-and-lock the wallet row: INSERT it at 0 if absent, else a no-op
   *      DO UPDATE that still takes the row lock, so concurrent same-user batches
   *      serialize here. Returns the current balance.
   *   3. ONE context SELECT gathers everything the in-order pass needs: this
   *      user's already-persisted batch rows (replays), any referenced originals
   *      (to reverse, or to detect a rollback-of-a-rollback), and any committed
   *      rollback already targeting a referenced original (to detect a double
   *      rollback).
   *   4. In-order pass against the locked balance, building the rows to insert:
   *      a `bet` debits (first to go below zero throws `InsufficientFundsError`),
   *      a `win` credits, a `rollback` reverses its original (OPPOSITE direction:
   *      a bet's rollback credits, a win's debits — a win clawback that overdraws
   *      throws `InsufficientFundsError` too). A rollback of a not-yet-seen
   *      original is RECORDED with amount 0 and no balance change (pre-rollback);
   *      the later original then becomes a NOOP (recorded, no balance effect).
   *      Double rollback and rollback-of-a-rollback throw `BadRequestError`.
   *   5. Bulk-insert the recorded rows; update the wallet only if it changed.
   *
   * An action against a non-existent wallet lazily creates it at 0, so a positive
   * bet still rejects via the per-step check (the created-at-0 row rolls back with
   * the transaction). The returned `transactions` are in request order (duplicates
   * included), each with its tx id — original for replays, fresh for new.
   */
  async processActions(
    userActions: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }> {
    const { userId, currency, game, gameId, actions } = userActions

    for (const action of actions) validateAction(action)

    // Dedup by actionId in request order, assigning each a fresh txId now.
    const seen = new Set<string>()
    const uniqueActions = actions
      .filter((a) => !seen.has(a.actionId) && seen.add(a.actionId))
      .map((a) => ({ ...a, txId: randomUUID() }))

    const batchActionIds = new Set(uniqueActions.map((a) => a.actionId))

    // The originals every rollback in this batch references. (Includes replayed
    // rollbacks' targets — harmless: a replayed rollback's target is already a
    // committed rollback target, so it only ever produces a correct noop.)
    const referencedOriginalIds = uniqueActions
      .filter((a) => a.action === 'rollback')
      .map((a) => a.originalActionId)

    // The action_ids of every rollback in this batch. Used to reject a
    // rollback-of-a-rollback regardless of the two rollbacks' order in the batch.
    const batchRollbackActionIds = new Set(
      uniqueActions.filter((a) => a.action === 'rollback').map((a) => a.actionId),
    )

    // Every id we need context for: this batch's action_ids (replay candidates)
    // plus the originals any rollback references.
    const lookupIds = [...new Set([...batchActionIds, ...referencedOriginalIds])]

    return this.db.transaction().execute(async (trx) => {
      // Ensure-and-lock the wallet row from start to prevent
      // issues with concurrent writes to the same rows.
      const wallet = await trx
        .insertInto('wallets')
        .values({ user_id: userId, currency, balance: 0 })
        .onConflict((oc) =>
          oc
            .columns(['user_id', 'currency'])
            .doUpdateSet({ balance: (eb) => eb.ref('wallets.balance') }),
        )
        .returning('balance')
        .executeTakeFirstOrThrow()
      const startBalance = Number(wallet.balance)

      // Pre-fetch transactions we need to properly validate business logic:
      // 1. All transactions that we received that might already exist on the DB
      // 2. All transactions that were rolled back by one of the actions in this batch
      // 3. All rollback transactions too, so we avoid rolling back the same actionId twice.
      const contextRows = await trx
        .selectFrom('transactions')
        .where('user_id', '=', userId)
        .where('currency', '=', currency)
        .where((eb) =>
          eb.or([
            eb('action_id', 'in', lookupIds),
            eb.and([eb('type', '=', 'rollback'), eb('original_action_id', 'in', lookupIds)]),
          ]),
        )
        .selectAll()
        .execute()

      // Index every already-committed row we fetched by actionId: a replay reads
      // back its `id` (original txId), and a rollback reads its referenced
      // original's `type`/`amount` to reverse the balance.
      const existingDbTransactions = new Map<string, Transaction>()
      for (const row of contextRows) {
        const tx = parseTxFromDB(row)
        existingDbTransactions.set(tx.actionId, tx)
      }

      // Originals reversed by a COMMITTED rollback (in a prior call); a non-null
      // originalActionId names the action a rollback reversed.
      const committedRollbackTargets = new Set(
        [...existingDbTransactions.values()].flatMap((tx) =>
          tx.originalActionId !== null ? [tx.originalActionId] : [],
        ),
      )

      // Every original cancelled by a rollback — committed, or ANYWHERE in this
      // batch (the batch's rollback targets are pre-populated up front). A bet/win
      // whose id is here is a NOOP: never applied to the balance, regardless of
      // whether its rollback comes before or after it in the request. This makes
      // [bet A, rollback A] and [rollback A, bet A] behave identically and removes
      // the apply-then-reverse path. See README "Rollback ordering".
      const rolledbackActionIds = new Set([...committedRollbackTargets, ...referencedOriginalIds])

      // In-order pass: maintain the running balance and the rows to insert, keyed
      // by actionId (unique per row). A row carries the per-action columns only —
      // the constant user/currency/game columns are filled at insert time from the
      // closure. The map also lets a rollback look up a same-batch original to
      // reject a rollback-of-a-rollback (its `type`).
      let balance = startBalance
      const rowsToInsert = new Map<
        string,
        {
          id: string
          actionId: string
          type: string
          amount: number
          originalActionId: string | null
          rolledBack: boolean
        }
      >()
      // Originals reversed so far (committed seed, grown per rollback). A rollback
      // of an already-reversed original is a 400 double-rollback. (Distinct from
      // rolledbackActionIds, which is the full pre-populated set used for noops.)
      const reversedOriginals = new Set(committedRollbackTargets)
      // Originals committed in a PRIOR call that a rollback in this batch reverses:
      // flagged with one batched UPDATE after the insert (no per-action round-trip).
      const priorCallOriginalsToFlag = new Set<string>()

      for (const action of uniqueActions) {
        // Replay: already persisted, never re-applied — keep its original txId.
        if (existingDbTransactions.has(action.actionId)) continue

        if (action.action === 'bet' || action.action === 'win') {
          // A bet/win cancelled by a rollback (committed, or anywhere in this
          // batch) is a NOOP: recorded for idempotency and flagged rolledBack, but
          // never applied to the balance — so request order doesn't matter and a
          // bet rolled back in the same batch never trips the per-step funds check.
          if (rolledbackActionIds.has(action.actionId)) {
            rowsToInsert.set(action.actionId, {
              id: action.txId,
              actionId: action.actionId,
              type: action.action,
              amount: action.amount,
              originalActionId: null,
              rolledBack: true,
            })
            continue
          }
          if (action.action === 'bet') {
            balance -= action.amount
            if (balance < 0) throw new InsufficientFundsError()
          } else {
            balance += action.amount
          }
          rowsToInsert.set(action.actionId, {
            id: action.txId,
            actionId: action.actionId,
            type: action.action,
            amount: action.amount,
            originalActionId: null,
            rolledBack: false,
          })
          continue
        }

        // If it gets here its a rollback action:
        const origId = action.originalActionId

        // Double rollback: this original was already reversed — committed, or by an
        // earlier rollback in this same batch.
        if (reversedOriginals.has(origId)) {
          throw new BadRequestError('original action has already been rolled back')
        }
        // Rollback-of-a-rollback: the referenced id is itself a rollback —
        // committed, or ANYWHERE in this batch (order-independent).
        const committedOriginal = existingDbTransactions.get(origId)
        if (committedOriginal?.type === 'rollback' || batchRollbackActionIds.has(origId)) {
          throw new BadRequestError('cannot roll back a rollback')
        }
        reversedOriginals.add(origId)

        // Rollback rows always store amount 0: the reversal reads the original's
        // amount, RTP ignores type='rollback' rows, and replays never recompute —
        // so the stored amount is never read back.
        rowsToInsert.set(action.actionId, {
          id: action.txId,
          actionId: action.actionId,
          type: action.action,
          amount: 0,
          originalActionId: origId,
          rolledBack: false,
        })

        // Reverse ONLY a prior-committed original: a same-batch one was noop'd
        // above (never applied), so there is nothing to undo. The committed
        // original is flagged via the one batched UPDATE after the insert.
        if (committedOriginal !== undefined) {
          if (committedOriginal.type === 'bet') {
            balance += committedOriginal.amount
          } else {
            balance -= committedOriginal.amount
            if (balance < 0) throw new InsufficientFundsError()
          }
          priorCallOriginalsToFlag.add(origId)
        }
      }

      // Bulk-insert the recorded rows (skip when an all-replay batch recorded none).
      // The constant user/currency/game columns come from the closure; only the
      // per-action fields vary, so we encode each row to its snake_case shape here.
      if (rowsToInsert.size > 0) {
        await trx
          .insertInto('transactions')
          .values(
            [...rowsToInsert.values()].map((row) => ({
              id: row.id,
              action_id: row.actionId,
              user_id: userId,
              currency,
              game: game ?? null,
              game_id: gameId ?? null,
              type: row.type,
              amount: row.amount,
              original_action_id: row.originalActionId,
              rolledback: row.rolledBack,
            })),
          )
          .execute()
      }

      // ONE batched UPDATE flips `rolledback` on prior-call originals reversed by
      // a rollback in this batch (same-batch originals were set in memory above).
      // Kept to a single statement to preserve the fixed-statement-count discipline.
      if (priorCallOriginalsToFlag.size > 0) {
        await trx
          .updateTable('transactions')
          .set({ rolledback: true })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .where('action_id', 'in', [...priorCallOriginalsToFlag])
          .execute()
      }

      // Persist only when the balance changed (an all-replay / all-noop batch
      // leaves it untouched). The DB CHECK(balance >= 0) stays as a backstop.
      if (balance !== startBalance) {
        await trx
          .updateTable('wallets')
          .set({ balance, updated_at: sql`now()` })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .execute()
      }

      // Response in request order (duplicates included): a replay keeps its
      // original txId, a new action the one generated above. `newTxByAction` is
      // keyed by every unique actionId (it's built from the dedup of `actions`),
      // so the `??` fallback always hits for a non-replay — the `!` is total.
      const newTxByAction = new Map(uniqueActions.map((a) => [a.actionId, a.txId]))
      const transactions = actions.map((a) => ({
        actionId: a.actionId,
        txId: existingDbTransactions.get(a.actionId)?.id ?? newTxByAction.get(a.actionId)!,
      }))

      return { balance, transactions }
    })
  }

  /**
   * Per-user RTP report. ONE windowed scan over `transactions` computes both the
   * non-reversed sums and the reversed sums in a single pass using FILTER
   * aggregates, so there is no second query or anti-join. The window predicate
   * (half-open `created_at` in `[from, to)`, `type IN ('bet','win')`) is applied
   * to the raw rows before grouping; the keyset predicate compares the group
   * key, so it can be
   * a plain row-value comparison on those same raw columns. We fetch `limit + 1`
   * rows to detect whether a further page exists.
   */
  async userRtpReport(query: RtpReportQuery): Promise<RtpReportPage<UserRtpRow>> {
    const limit = pageLimit(query.limit)
    const after = query.cursor === undefined ? undefined : decodeUserCursor(query.cursor)
    const keyset =
      after === undefined
        ? sql``
        : sql`AND (currency, user_id) > (${after.currency}, ${after.userId})`

    const { rows } = await sql<UserRtpDbRow>`
      SELECT
        user_id,
        currency,
        ${rtpAggregates}
      FROM transactions
      WHERE ${rtpWindow(query.from, query.to)}
        ${keyset}
      GROUP BY currency, user_id
      ORDER BY currency, user_id
      LIMIT ${limit + 1}
    `.execute(this.db)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const cursor =
      hasMore && last !== undefined
        ? encodeCursor({ currency: last.currency, userId: last.user_id })
        : null

    return { items: page.map((r) => ({ ...mapCasinoRow(r), userId: r.user_id })), cursor }
  }

  /**
   * Casino-wide RTP report: identical to {@link KyselyRepo.userRtpReport} but
   * grouped by `currency` only (RTP across different currencies cannot be summed
   * into one number) and keyset-paginated on `currency`.
   */
  async casinoRtpReport(query: RtpReportQuery): Promise<RtpReportPage<CasinoRtpRow>> {
    const limit = pageLimit(query.limit)
    const after = query.cursor === undefined ? undefined : decodeCasinoCursor(query.cursor)
    const keyset = after === undefined ? sql`` : sql`AND currency > ${after.currency}`

    const { rows } = await sql<CasinoRtpDbRow>`
      SELECT
        currency,
        ${rtpAggregates}
      FROM transactions
      WHERE ${rtpWindow(query.from, query.to)}
        ${keyset}
      GROUP BY currency
      ORDER BY currency
      LIMIT ${limit + 1}
    `.execute(this.db)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const cursor = hasMore && last !== undefined ? encodeCursor({ currency: last.currency }) : null

    return { items: page.map(mapCasinoRow), cursor }
  }
}
