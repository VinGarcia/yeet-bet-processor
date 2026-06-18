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

// Driver returns count/sum as strings (Postgres bigint/numeric); converted to
// numbers at the boundary — exact below 2^53.
interface CasinoRtpDbRow {
  currency: string
  rounds: string
  total_bet: string
  total_win: string
  rolled_back_bet: string
  rolled_back_win: string
}
interface UserRtpDbRow extends CasinoRtpDbRow {
  user_id: string
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return RTP_DEFAULT_LIMIT
  return Math.min(Math.max(limit, 1), RTP_MAX_LIMIT)
}

// Opaque base64url keyset cursor: the client echoes it back verbatim, so its
// shape stays private and changeable.
function encodeCursor(keyset: Record<string, string>): string {
  return Buffer.from(JSON.stringify(keyset)).toString('base64url')
}

function decodeCasinoCursor(cursor: string): { currency: string } {
  const obj = decodeCursor(cursor)
  if (typeof obj.currency === 'string') return { currency: obj.currency }
  throw new BadRequestError('invalid cursor')
}

function decodeUserCursor(cursor: string): { currency: string; userId: string } {
  const obj = decodeCursor(cursor)
  if (typeof obj.currency === 'string' && typeof obj.userId === 'string') {
    return { currency: obj.currency, userId: obj.userId }
  }
  throw new BadRequestError('invalid cursor')
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    /* fall through to the shared error below */
  }
  throw new BadRequestError('invalid cursor')
}

// RTP aggregates shared by both reports; non-reversed rows feed the live sums,
// reversed amounts are surfaced separately. The reports differ only in GROUP BY.
const rtpAggregates = sql`
  count(*) FILTER (WHERE type = 'bet' AND NOT rolledback) AS rounds,
  coalesce(sum(amount) FILTER (WHERE type = 'bet' AND NOT rolledback), 0) AS total_bet,
  coalesce(sum(amount) FILTER (WHERE type = 'win' AND NOT rolledback), 0) AS total_win,
  coalesce(sum(amount) FILTER (WHERE type = 'bet' AND rolledback), 0) AS rolled_back_bet,
  coalesce(sum(amount) FILTER (WHERE type = 'win' AND rolledback), 0) AS rolled_back_win`

// Shared window predicate. Half-open [from, to) so two adjacent windows never
// double-count a row stamped exactly at the boundary.
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

// A `transactions` row in the camelCase domain shape (amount as JS number).
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

/** Kysely-backed {@link Repo} implementation; owns all SQL/driver concerns. */
export class KyselyRepo implements Repo {
  constructor(private readonly db: Kysely<DB>) {}

  async checkConnection(): Promise<void> {
    await sql`select 1`.execute(this.db)
  }

  async findWallet(userId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.db
      .selectFrom('wallets')
      .where('user_id', '=', userId)
      .where('currency', '=', currency)
      .selectAll()
      .executeTakeFirst()

    if (row === undefined) return undefined

    // bigint comes back as a string; Number is precision-safe below 2^53.
    return { userId: row.user_id, currency: row.currency, balance: Number(row.balance) }
  }

  /**
   * Applies a batch of actions atomically in one transaction:
   *
   *   1. Dedup by `actionId` (first wins), assigning each a fresh `txId`.
   *   2. Ensure-and-lock the wallet: INSERT at 0 if absent, else a no-op DO
   *      UPDATE that still takes the row lock, so concurrent same-user batches
   *      serialize here.
   *   3. ONE context SELECT: replayed rows, referenced originals, and any
   *      committed rollback targeting them (for double-rollback detection).
   *   4. In-order pass over the locked balance: bet debits, win credits,
   *      rollback reverses its original in the OPPOSITE direction. A rollback of
   *      a not-yet-seen original is recorded (amount 0, no balance change) and
   *      the later original becomes a NOOP — so order doesn't matter. Double
   *      rollback / rollback-of-a-rollback throw `BadRequestError`.
   *   5. Bulk-insert the rows; update the wallet only if the balance changed.
   *
   * Returned `transactions` are in request order (duplicates included): replays
   * keep their original txId, new actions get the fresh one.
   */
  async processActions(
    userActions: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }> {
    const { userId, currency, game, gameId, actions } = userActions

    for (const action of actions) validateAction(action)

    // Dedup by actionId (first wins), assigning each a fresh txId now.
    const seen = new Set<string>()
    const uniqueActions = actions
      .filter((a) => !seen.has(a.actionId) && seen.add(a.actionId))
      .map((a) => ({ ...a, txId: randomUUID() }))

    const batchActionIds = new Set(uniqueActions.map((a) => a.actionId))

    const referencedOriginalIds = uniqueActions
      .filter((a) => a.action === 'rollback')
      .map((a) => a.originalActionId)

    // Used to reject a rollback-of-a-rollback regardless of in-batch order.
    const batchRollbackActionIds = new Set(
      uniqueActions.filter((a) => a.action === 'rollback').map((a) => a.actionId),
    )

    const lookupIds = [...new Set([...batchActionIds, ...referencedOriginalIds])]

    return this.db.transaction().execute(async (trx) => {
      // Ensure-and-lock the wallet row up front: the no-op DO UPDATE still takes
      // the row lock, serializing concurrent same-user batches.
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

      // Indexed by actionId: replays read back their original txId; rollbacks
      // read their original's type/amount to reverse the balance.
      const existingDbTransactions = new Map<string, Transaction>()
      for (const row of contextRows) {
        const tx = parseTxFromDB(row)
        existingDbTransactions.set(tx.actionId, tx)
      }

      // Originals reversed by a rollback committed in a prior call.
      const committedRollbackTargets = new Set(
        [...existingDbTransactions.values()].flatMap((tx) =>
          tx.originalActionId !== null ? [tx.originalActionId] : [],
        ),
      )

      // Every original cancelled by a rollback (committed or anywhere in this
      // batch). A bet/win here is a NOOP — never applied to the balance — so
      // [bet A, rollback A] and [rollback A, bet A] behave identically and the
      // apply-then-reverse path is gone. See README "Rollback ordering".
      const rolledbackActionIds = new Set([...committedRollbackTargets, ...referencedOriginalIds])

      // In-order pass: running balance + rows to insert, keyed by actionId.
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
      // Originals reversed so far; a second reversal is a 400 double-rollback.
      const reversedOriginals = new Set(committedRollbackTargets)
      // Prior-call originals this batch reverses, flagged via one batched UPDATE.
      const priorCallOriginalsToFlag = new Set<string>()

      for (const action of uniqueActions) {
        // Replay: already persisted, never re-applied — keep its original txId.
        if (existingDbTransactions.has(action.actionId)) continue

        if (action.action === 'bet' || action.action === 'win') {
          // NOOP: a bet/win cancelled by a rollback is recorded for idempotency
          // and flagged rolledBack but never applied, so a same-batch rollback
          // never trips the funds check and order doesn't matter.
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

        // Rollback action.
        const origId = action.originalActionId

        // Double rollback: this original was already reversed.
        if (reversedOriginals.has(origId)) {
          throw new BadRequestError('original action has already been rolled back')
        }
        // Rollback-of-a-rollback: the referenced id is itself a rollback.
        const committedOriginal = existingDbTransactions.get(origId)
        if (committedOriginal?.type === 'rollback' || batchRollbackActionIds.has(origId)) {
          throw new BadRequestError('cannot roll back a rollback')
        }
        reversedOriginals.add(origId)

        // Rollback rows store amount 0: the reversal reads the original's amount,
        // RTP ignores type='rollback' rows, so this amount is never read back.
        rowsToInsert.set(action.actionId, {
          id: action.txId,
          actionId: action.actionId,
          type: action.action,
          amount: 0,
          originalActionId: origId,
          rolledBack: false,
        })

        // Reverse ONLY a prior-committed original; a same-batch one was noop'd
        // above, so there is nothing to undo.
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

      // Bulk-insert recorded rows; constant columns come from the closure.
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

      // ONE batched UPDATE flips `rolledback` on prior-call originals reversed
      // here. The denormalized flag lets RTP exclude reversed rows without a join.
      if (priorCallOriginalsToFlag.size > 0) {
        await trx
          .updateTable('transactions')
          .set({ rolledback: true })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .where('action_id', 'in', [...priorCallOriginalsToFlag])
          .execute()
      }

      // Persist only when the balance changed (all-replay/all-noop leaves it).
      if (balance !== startBalance) {
        await trx
          .updateTable('wallets')
          .set({ balance, updated_at: sql`now()` })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .execute()
      }

      // Response in request order. `newTxByAction` is keyed by every unique
      // actionId, so the `??` fallback always hits for a non-replay — `!` is total.
      const newTxByAction = new Map(uniqueActions.map((a) => [a.actionId, a.txId]))
      const transactions = actions.map((a) => ({
        actionId: a.actionId,
        txId: existingDbTransactions.get(a.actionId)?.id ?? newTxByAction.get(a.actionId)!,
      }))

      return { balance, transactions }
    })
  }

  /**
   * Per-user RTP report. ONE windowed scan computes live and reversed sums in a
   * single pass via FILTER aggregates — no second query or anti-join. Keyset
   * pagination on `(currency, user_id)`; `limit + 1` rows detect a next page.
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
   * Casino-wide RTP report: like {@link KyselyRepo.userRtpReport} but grouped by
   * `currency` only (RTP across currencies can't be summed) and keyset-paginated
   * on `currency`.
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
