import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import type { DB } from '../schema.js'

// `wallets`: per-(user, currency) balance. The CHECK enforces non-negativity at
// the storage layer so no code path can drive a wallet negative.
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

// `transactions`: append-only ledger. `action_id` is UNIQUE — the idempotency
// key, so a replay collides on insert and is never applied twice.
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
      // Denormalized: set true on an original once reversed, so RTP can filter
      // `rolledback = false` instead of an anti-join against rollback rows at scale.
      .addColumn('rolledback', 'boolean', (col) => col.notNull().defaultTo(false))
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
 * Partial index for the RTP windowed aggregate: a `created_at` range scan
 * filtered to `type IN ('bet','win')`, skipping rollback rows. It does NOT make
 * a huge-window per-user aggregate cheap (that scans every matching row); a
 * production system would maintain a rollup — an accepted limitation here.
 */
const createRtpIndex: Migration = {
  async up(db: Kysely<DB>): Promise<void> {
    await sql`
      CREATE INDEX transactions_rtp_window_idx
        ON transactions (created_at)
        WHERE type IN ('bet', 'win')
    `.execute(db)
  },

  async down(db: Kysely<DB>): Promise<void> {
    await sql`DROP INDEX transactions_rtp_window_idx`.execute(db)
  },
}

// Lexicographically ordered keys; the Migrator applies them in sequence.
export const migrations: Record<string, Migration> = {
  '001_create_wallets': createWallets,
  '002_create_transactions': createTransactions,
  '003_create_rtp_index': createRtpIndex,
}

// In-code provider, avoiding FileMigrationProvider (brittle path resolution under ESM).
const provider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  },
}

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
