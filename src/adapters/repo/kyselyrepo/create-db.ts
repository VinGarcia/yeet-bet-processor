import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { DB } from './schema.js'

/** Kysely bound to a fresh `pg` pool; the caller owns the lifecycle (`db.destroy()`). */
export function createDb(connectionString: string): Kysely<DB> {
  const pool = new Pool({ connectionString })
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}
