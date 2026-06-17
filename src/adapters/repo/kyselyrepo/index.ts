import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { ProcessActionsInput, ProcessActionsResult, Repo } from '../contracts.js'
import type { Wallet } from '../../../core/entities.js'
import { InsufficientFundsError } from '../../../core/errors.js'
import type { DB } from './schema.js'

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
   * Applies a batch of bets in a single transaction with a fixed number of
   * statements regardless of batch size:
   *
   *   1. SELECT existing rows for the batch's `action_id`s (idempotency map).
   *   2. Debit the wallet by the net amount of the *new* bets, guarded by
   *      `balance >= net` so a short wallet matches 0 rows and rolls back.
   *   3. Bulk-INSERT one ledger row per new bet.
   *
   * The returned `transactions` array is in request order: replays carry their
   * original `txId`, new bets carry the `id` generated here.
   */
  async processActions(input: ProcessActionsInput): Promise<ProcessActionsResult> {
    const { userId, currency, game, gameId, actions } = input

    return this.db.transaction().execute(async (trx) => {
      // 1. Map already-persisted action_ids to their original tx id.
      const existing = await trx
        .selectFrom('transactions')
        .where(
          'action_id',
          'in',
          actions.map((a) => a.actionId),
        )
        .select(['id', 'action_id'])
        .execute()
      const appliedTxByAction = new Map(existing.map((row) => [row.action_id, row.id]))

      // New bets are those not already applied; assign each a fresh tx id now so
      // the response mapping and the ledger insert share the same value.
      const newBets = actions
        .filter((a) => !appliedTxByAction.has(a.actionId))
        .map((a) => ({ ...a, txId: randomUUID() }))
      const net = newBets.reduce((sum, b) => sum + b.amount, 0)

      // 2. Debit the wallet by the net of new bets. The `balance >= net` guard
      // means an insufficient (or missing) wallet matches 0 rows and the whole
      // transaction rolls back. When net is 0 (all replays) just read balance.
      let balance: number
      if (net > 0) {
        const debited = await trx
          .updateTable('wallets')
          .set({ balance: sql`balance - ${net}`, updated_at: sql`now()` })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .where(sql<boolean>`balance >= ${net}`)
          .returning('balance')
          .executeTakeFirst()
        if (debited === undefined) throw new InsufficientFundsError()
        balance = Number(debited.balance)
      } else {
        const wallet = await trx
          .selectFrom('wallets')
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .select('balance')
          .executeTakeFirst()
        balance = wallet === undefined ? 0 : Number(wallet.balance)
      }

      // 3. Bulk-insert the new ledger rows in one statement.
      if (newBets.length > 0) {
        await trx
          .insertInto('transactions')
          .values(
            newBets.map((b) => ({
              id: b.txId,
              action_id: b.actionId,
              user_id: userId,
              currency,
              game: game ?? null,
              game_id: gameId ?? null,
              type: b.action,
              amount: b.amount,
              original_action_id: null,
            })),
          )
          .execute()
      }

      // Build the response in request order: replay → original id, new → fresh.
      const newTxByAction = new Map(newBets.map((b) => [b.actionId, b.txId]))
      const transactions = actions.map((a) => ({
        actionId: a.actionId,
        txId: appliedTxByAction.get(a.actionId) ?? newTxByAction.get(a.actionId)!,
      }))

      return { balance, transactions, gameId }
    })
  }
}
