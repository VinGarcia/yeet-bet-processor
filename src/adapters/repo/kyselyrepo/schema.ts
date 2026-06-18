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
 * Append-only ledger of processed actions. `action_id` is unique, which makes
 * inserts idempotent: a replayed action collides and is never applied twice.
 * `id` is the transaction id returned to the aggregator (generated in the app).
 */
export interface TransactionsTable {
  id: string
  action_id: string
  user_id: string
  currency: string
  game: string | null
  game_id: string | null
  type: string
  // Stored as Postgres `bigint`: read back as a `string`, written as a `number`.
  amount: ColumnType<string, number, number>
  original_action_id: string | null
  // Denormalized "this original was reversed" flag. Defaults to false at the DB;
  // set true on an original (bet/win) when a rollback reverses it (in memory for
  // a same-batch original, via a batched UPDATE for a prior-call one). Rollback
  // rows themselves stay false. Lets the RTP query skip a rollback anti-join.
  rolledback: ColumnType<boolean, boolean | undefined, boolean>
  // Defaulted server-side and managed by the DB; never written by inserts.
  created_at: ColumnType<Date, never, Date>
}

/**
 * Kysely database schema. Tables are added here as the data model grows.
 */
export interface DB {
  wallets: WalletsTable
  transactions: TransactionsTable
}
