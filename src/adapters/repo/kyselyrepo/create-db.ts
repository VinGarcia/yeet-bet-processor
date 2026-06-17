import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { DB } from './schema.js'

/**
 * Builds a Kysely instance bound to a fresh `pg` connection pool.
 *
 * The caller owns the lifecycle: `db.destroy()` closes the underlying pool.
 */
export function createDb(connectionString: string): Kysely<DB> {
  const pool = new Pool({ connectionString })
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}
