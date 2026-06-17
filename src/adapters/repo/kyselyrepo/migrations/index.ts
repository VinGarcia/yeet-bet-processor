import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import type { DB } from '../schema.js'

/**
 * Creates the `wallets` table: a per-user, per-currency balance ledger.
 *
 * `balance` is a non-negative integer (smallest currency unit). The check
 * constraint enforces the invariant at the storage layer so no code path can
 * drive a wallet negative. The primary key is (`user_id`, `currency`).
 */
const createWallets: Migration = {
  async up(db: Kysely<DB>): Promise<void> {
    await db.schema
      .createTable('wallets')
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('currency', 'text', (col) => col.notNull())
      .addColumn('balance', 'bigint', (col) =>
        col
          .notNull()
          .defaultTo(0)
          .check(sql`balance >= 0`),
      )
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint('wallets_pkey', ['user_id', 'currency'])
      .execute()
  },

  async down(db: Kysely<DB>): Promise<void> {
    await db.schema.dropTable('wallets').execute()
  },
}

/**
 * Creates the `transactions` table: an append-only ledger of processed actions.
 *
 * `action_id` is `UNIQUE`, which is the idempotency key — a replayed action
 * collides on insert and is never applied twice. `amount` is a non-negative
 * integer in the smallest currency unit. The (`user_id`, `created_at`) index
 * supports per-user ledger reads.
 */
const createTransactions: Migration = {
  async up(db: Kysely<DB>): Promise<void> {
    await db.schema
      .createTable('transactions')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('action_id', 'uuid', (col) => col.notNull().unique())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('currency', 'text', (col) => col.notNull())
      .addColumn('game', 'text')
      .addColumn('game_id', 'text')
      .addColumn('type', 'text', (col) =>
        col.notNull().check(sql`type in ('bet', 'win', 'rollback')`),
      )
      .addColumn('amount', 'bigint', (col) => col.notNull())
      .addColumn('original_action_id', 'uuid')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()

    await db.schema
      .createIndex('transactions_user_created_idx')
      .on('transactions')
      .columns(['user_id', 'created_at'])
      .execute()
  },

  async down(db: Kysely<DB>): Promise<void> {
    await db.schema.dropTable('transactions').execute()
  },
}

/**
 * All migrations, keyed by name. Keys are lexicographically ordered so the
 * Migrator applies them in sequence. Add new migrations with the next prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_create_wallets': createWallets,
  '002_create_transactions': createTransactions,
}

// In-code provider: returns the `migrations` object directly. Avoids
// FileMigrationProvider, which resolves paths on disk and is brittle under ESM.
const provider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  },
}

/**
 * Runs all pending migrations to latest. Throws if any migration errored.
 */
export async function migrate(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({ db, provider })
  const { error, results } = await migrator.migrateToLatest()

  const failed = results?.find((result) => result.status === 'Error')
  if (failed !== undefined) {
    throw new Error(`migration failed: ${failed.migrationName}`, { cause: error })
  }
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error('migration failed', { cause: error })
  }
}
