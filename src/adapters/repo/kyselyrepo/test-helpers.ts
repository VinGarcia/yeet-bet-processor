import { sql, type Kysely } from 'kysely'
import type { DB } from './schema.js'

/** Truncates every table to give each test a clean state (schema must be migrated). */
export async function resetTestDB(db: Kysely<DB>): Promise<void> {
  await sql`TRUNCATE wallets, transactions RESTART IDENTITY CASCADE`.execute(db)
}
