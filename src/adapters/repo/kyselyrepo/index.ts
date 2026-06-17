import { sql, type Kysely } from 'kysely'
import type { Repo } from '../contracts.js'
import type { Wallet } from '../../../core/entities.js'
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
}
