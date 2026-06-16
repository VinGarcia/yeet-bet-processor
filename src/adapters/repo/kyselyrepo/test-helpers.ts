import type { Kysely } from 'kysely'
import type { DB } from './schema.js'

/**
 * Resets the test database between tests.
 *
 * No tables exist yet (slice 1), so this is a no-op.
 *
 * TODO: once tables exist, TRUNCATE every table with
 * `RESTART IDENTITY CASCADE` to give each test a clean, deterministic state.
 */
export async function resetTestDB(db: Kysely<DB>): Promise<void> {
  void db
  return Promise.resolve()
}
