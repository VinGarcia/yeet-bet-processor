import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Repo } from '../contracts.js'
import type { UserActions, Wallet } from '../../../core/entities.js'
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
   * Applies a batch of actions (`bet` debits, `win` credits) in a single
   * transaction:
   *
   *   1. Dedup by `actionId` in request order (first wins), assigning each
   *      unique action a fresh `txId`. Amount validity is the caller's contract
   *      (enforced by the core `validateAction`); the repo trusts it.
   *   2. Ensure-and-lock the wallet row: INSERT it at 0 if absent, else a no-op
   *      DO UPDATE that still takes the row lock, so concurrent same-user batches
   *      serialize here. Returns the current balance.
   *   3. In ONE statement, insert the not-yet-persisted actions and read back
   *      this user's already-persisted ones (replays).
   *   4. Apply only the new actions in request order against the locked balance:
   *      a `bet` debits and the first to go below zero throws
   *      `InsufficientFundsError` (rolling the batch back); a `win` credits.
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

    // Dedup by actionId in request order, assigning each a fresh txId now (shared
    // by the insert and the response). Postgres can't express our ordered,
    // per-step balance check, so a within-batch duplicate must collapse here or
    // it would debit twice against the single UNIQUE(action_id) ledger row.
    const seen = new Set<string>()
    const uniqueActions = actions
      .filter((a) => !seen.has(a.actionId) && seen.add(a.actionId))
      .map((a) => ({ ...a, txId: randomUUID() }))

    return this.db.transaction().execute(async (trx) => {
      // Ensure-and-lock the wallet row. The lock serializes concurrent same-user
      // batches, so a concurrently-submitted duplicate action_id is seen as an
      // existing replay below (step 3) instead of racing into a second row.
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

      // Insert the new actions and return this user's existing (replay) rows in
      // one statement: `existing` finds the replays; `ins` inserts only the rest
      // (a data-modifying CTE always runs to completion, even though the final
      // SELECT reads only `existing`). The first VALUES row casts the columns so
      // the CTE carries uuid/text/bigint types.
      const inputRows = sql.join(
        uniqueActions.map((a, i) =>
          i === 0
            ? sql`(${a.actionId}::uuid, ${a.txId}::uuid, ${a.action}::text, ${a.amount}::bigint)`
            : sql`(${a.actionId}, ${a.txId}, ${a.action}, ${a.amount})`,
        ),
      )

      const existingRows = await sql<{ action_id: string; id: string }>`
        WITH input(action_id, tx_id, type, amount) AS (
          VALUES ${inputRows}
        ),
        existing AS (
          SELECT action_id, id FROM transactions
          WHERE action_id IN (SELECT action_id FROM input)
            AND user_id = ${userId}
            AND currency = ${currency}
        ),
        ins AS (
          INSERT INTO transactions (id, action_id, user_id, currency, game, game_id, type, amount)
          SELECT tx_id, action_id, ${userId}, ${currency}, ${game ?? null}, ${gameId ?? null}, type, amount
            FROM input
          WHERE action_id NOT IN (SELECT action_id FROM existing)
        )
        SELECT action_id, id FROM existing
      `.execute(trx)

      // Map each replayed actionId to its original txId; everything else is new.
      const replayTxByAction = new Map(existingRows.rows.map((r) => [r.action_id, r.id]))

      // Apply only the new actions in request order against the locked balance.
      let balance = startBalance
      for (const action of uniqueActions) {
        if (replayTxByAction.has(action.actionId)) continue
        if (action.action === 'bet') {
          balance -= action.amount
          if (balance < 0) throw new InsufficientFundsError()
        } else {
          balance += action.amount
        }
      }

      // Persist only when the balance changed (an all-replay batch leaves it
      // untouched). The DB CHECK(balance >= 0) stays as a backstop.
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
        txId: replayTxByAction.get(a.actionId) ?? newTxByAction.get(a.actionId)!,
      }))

      return { balance, transactions }
    })
  }
}
