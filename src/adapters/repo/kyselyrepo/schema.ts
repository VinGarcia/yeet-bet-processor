import type { ColumnType } from 'kysely'

/**
 * A user's balance in a single currency. `balance` is stored in the smallest
 * currency unit (an integer count) so money math stays exact.
 */
export interface WalletsTable {
  user_id: string
  currency: string
  // Stored as Postgres `bigint`/`int8`: the driver reads it back as a `string`
  // (to avoid precision loss), while inserts/updates accept a JS `number`. The
  // adapter converts the read back to a `number` at its boundary.
  balance: ColumnType<string, number, number>
  // Defaulted server-side and managed by the DB; never written by inserts.
  updated_at: ColumnType<Date, never, Date>
}

/**
 * Kysely database schema. Tables are added here as the data model grows.
 */
export interface DB {
  wallets: WalletsTable
}
