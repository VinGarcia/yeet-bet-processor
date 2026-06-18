import type { ColumnType } from 'kysely'

export interface WalletsTable {
  user_id: string
  currency: string
  // bigint: read back as a string (precision-safe), written as a number.
  balance: ColumnType<string, number, number>
  updated_at: ColumnType<Date, never, Date>
}

export interface TransactionsTable {
  id: string
  action_id: string
  user_id: string
  currency: string
  game: string | null
  game_id: string | null
  type: string
  amount: ColumnType<string, number, number>
  original_action_id: string | null
  // Denormalized: set true on an original once reversed, letting RTP skip a
  // rollback anti-join. Rollback rows stay false.
  rolledback: ColumnType<boolean, boolean | undefined, boolean>
  created_at: ColumnType<Date, never, Date>
}

export interface DB {
  wallets: WalletsTable
  transactions: TransactionsTable
}
