import { sql, type Kysely } from 'kysely'
import type { DB } from './schema.js'

/**
 * Resets the test database between tests by truncating every table, giving each
 * test a clean, deterministic state. Safe to call once the schema is migrated.
 */
export async function resetTestDB(db: Kysely<DB>): Promise<void> {
  await sql`TRUNCATE wallets RESTART IDENTITY CASCADE`.execute(db)
}
