import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Repo } from '../contracts.js'
import type { UserActions, Wallet } from '../../../core/entities.js'
import { InsufficientFundsError } from '../../../core/errors.js'
import type { DB } from './schema.js'

/** Postgres SQLSTATE for a unique-violation (e.g. the `UNIQUE(action_id)`). */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `err` is a Postgres unique-violation. The `pg` driver surfaces it as
 * a `DatabaseError` carrying SQLSTATE `23505` on its `code` field; we duck-type
 * the shape rather than importing the driver's error class, keeping this check
 * resilient to how the error is wrapped on its way up.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
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
   * Applies a batch of bets in a single transaction:
   *
   *   1. SELECT existing rows for the batch's `action_id`s (idempotency map).
   *   2. The *new* bets (not already applied) each get a fresh `txId`.
   *   3. With new bets present, *ensure-and-lock* the wallet row via a no-op
   *      upsert (INSERT … ON CONFLICT DO UPDATE SET balance = wallets.balance
   *      RETURNING balance). This atomically creates the row at 0 if it is
   *      absent, takes a row lock either way (so concurrent first-bet batches
   *      for the same user serialize on it), and returns the current balance.
   *      We then apply each new bet IN REQUEST ORDER against a running balance;
   *      the first bet that would drive it below zero throws
   *      `InsufficientFundsError`, rolling the whole transaction back.
   *   4. Write the computed final balance and bulk-INSERT the new ledger rows.
   *      The DB `CHECK(balance >= 0)` stays as a backstop.
   *
   * Contract: a bet against a *non-existent* wallet lazily creates it at
   * balance 0, so any positive bet still rejects via the per-step check (and the
   * created-at-0 row is rolled back with the transaction). This removes the old
   * silent-debit-loss bug where a bare UPDATE matched zero rows for a new user
   * while the ledger insert still wrote, diverging wallet and ledger.
   *
   * With no new bets (all replays) it just reads the current balance — no lock,
   * no write. The returned `transactions` array is in request order: replays
   * carry their original `txId`, new bets carry the `id` generated here.
   */
  async processActions(
    input: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }> {
    const { userId, currency, actions } = input

    try {
      return await this.applyBatch(input)
    } catch (err) {
      // BUG 2 — concurrent submission of the SAME brand-new action_id. The
      // up-front idempotency SELECT is unlocked and the wallet row lock does not
      // cover the transactions table, so two concurrent requests can both treat
      // the action as new. The first commits its ledger row; the second's INSERT
      // hits UNIQUE(action_id) → 23505, which ABORTS that transaction (any
      // further statement on it would fail with "current transaction is
      // aborted"). So we let it roll back, then — in a FRESH transaction — re-read
      // the now-committed rows by action_id and return their ORIGINAL tx ids.
      // Semantics: the concurrent duplicate is treated as an idempotent REPLAY,
      // not a domain error, so the raw 23505 never leaks past this adapter.
      if (!isUniqueViolation(err)) throw err
      return this.readAsReplay(userId, currency, actions, err)
    }
  }

  /**
   * Re-reads a batch whose ledger inserts already committed (lost a concurrency
   * race on `UNIQUE(action_id)`) as a pure idempotent replay: in a fresh
   * transaction it maps every `action_id` to its committed original tx id and
   * reads the current wallet balance. Mirrors the all-replays path of
   * {@link applyBatch}, only sourcing the tx ids from the just-committed rows.
   */
  private async readAsReplay(
    userId: string,
    currency: string,
    actions: UserActions['actions'],
    cause: unknown,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }> {
    return this.db.transaction().execute(async (trx) => {
      const committed = await trx
        .selectFrom('transactions')
        .where(
          'action_id',
          'in',
          actions.map((a) => a.actionId),
        )
        .select(['id', 'action_id'])
        .execute()
      const txByAction = new Map(committed.map((row) => [row.action_id, row.id]))

      const wallet = await trx
        .selectFrom('wallets')
        .where('user_id', '=', userId)
        .where('currency', '=', currency)
        .select('balance')
        .executeTakeFirst()
      const balance = wallet === undefined ? 0 : Number(wallet.balance)

      const transactions = actions.map((a) => {
        const txId = txByAction.get(a.actionId)
        // In the concurrent-identical-replay case the racing writer has committed
        // every action_id in this batch, so each lookup hits. If one is still
        // missing, the 23505 was not a clean replay of these exact actions (e.g.
        // a partial overlap whose own batch rolled back atomically) — we cannot
        // honestly resolve it as a replay, so we surface the original violation
        // rather than fabricate or assert a tx id.
        if (txId === undefined) throw cause
        return { actionId: a.actionId, txId }
      })
      return { balance, transactions }
    })
  }

  /**
   * Applies the batch in a single transaction (the happy path). May throw
   * `InsufficientFundsError` (a deliberate rollback) or, when it loses a
   * concurrency race on `UNIQUE(action_id)`, a Postgres unique violation that
   * {@link processActions} translates into an idempotent replay.
   */
  private async applyBatch(
    input: UserActions,
  ): Promise<{ balance: number; transactions: { actionId: string; txId: string }[] }> {
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

      // 2. New bets are those not already applied; assign each a fresh tx id now
      // so the response mapping and the ledger insert share the same value. We
      // also dedupe by action_id WITHIN this batch, keeping only the first
      // occurrence: a duplicate action_id in one request is an idempotent replay
      // of itself, so both response slots must resolve to that one tx id and the
      // debit must happen once. Without this, both occurrences would pass the
      // (unlocked) idempotency SELECT, get distinct tx ids, debit twice, and then
      // collide on the UNIQUE(action_id) ledger insert (a raw 23505 → 500).
      const seen = new Set<string>()
      const newBets = actions
        .filter(
          (a) =>
            !appliedTxByAction.has(a.actionId) && !seen.has(a.actionId) && seen.add(a.actionId),
        )
        .map((a) => ({ ...a, txId: randomUUID() }))

      let balance: number
      if (newBets.length > 0) {
        // 3. Ensure-and-lock the wallet row in one statement: INSERT the row at
        // balance 0 if absent, else a no-op DO UPDATE (balance = wallets.balance)
        // that still takes the row lock. Either way we get a locked row back and
        // its current balance, so concurrent first-bet batches for the same user
        // serialize here instead of racing a row that does not exist yet.
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
        balance = Number(wallet.balance)

        // Apply each new bet in request order; the first one that overdraws the
        // wallet fails the whole request (a rollback, since we throw in-trx).
        for (const bet of newBets) {
          balance -= bet.amount
          if (balance < 0) throw new InsufficientFundsError()
        }

        // 4. Write the computed final balance, then bulk-insert the ledger rows.
        await trx
          .updateTable('wallets')
          .set({ balance, updated_at: sql`now()` })
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .execute()

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
      } else {
        // All replays: nothing to apply, just read the current balance. This
        // read is deliberately *unlocked* — with no new bets there is no write,
        // so there is nothing to serialize against and no need for a row lock.
        const wallet = await trx
          .selectFrom('wallets')
          .where('user_id', '=', userId)
          .where('currency', '=', currency)
          .select('balance')
          .executeTakeFirst()
        balance = wallet === undefined ? 0 : Number(wallet.balance)
      }

      // Build the response in request order: replay → original id, new → fresh.
      const newTxByAction = new Map(newBets.map((b) => [b.actionId, b.txId]))
      const transactions = actions.map((a) => ({
        actionId: a.actionId,
        // Invariant: every action is either a replay (in `appliedTxByAction`) or
        // new (in `newTxByAction`) — `newBets` is exactly the actions not in the
        // applied map — so one of the two lookups always hits. The `!` is thus
        // provably safe: the `??` falls through only for a new action, which is
        // guaranteed to be in `newTxByAction`.
        txId: appliedTxByAction.get(a.actionId) ?? newTxByAction.get(a.actionId)!,
      }))

      return { balance, transactions }
    })
  }
}
