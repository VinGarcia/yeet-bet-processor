import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'
import { seedWallets, balanceFor, userIdFor, DEFAULT_SEED_OPTIONS, type SeedOptions } from './seed.js'

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>
let db: Kysely<DB>

const opts: SeedOptions = { ...DEFAULT_SEED_OPTIONS, count: 50, chunkSize: 7 }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  db = createDb(container.getConnectionUri())
  await migrate(db)
}, 60_000)

afterAll(async () => {
  await db.destroy()
  await container.stop()
})

beforeEach(() => resetTestDB(db))

async function walletCount(): Promise<number> {
  const row = await db
    .selectFrom('wallets')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

describe('seedWallets', () => {
  it('creates exactly `count` wallet rows with deterministic ids and balances', async () => {
    await seedWallets(db, opts)

    expect(await walletCount()).toBe(opts.count)

    const wallets = await db
      .selectFrom('wallets')
      .select(['user_id', 'currency', 'balance'])
      .orderBy('user_id')
      .execute()

    // Every row matches the deterministic derivation, independent of insert order.
    const byId = new Map(wallets.map((w) => [w.user_id, w]))
    for (let i = 1; i <= opts.count; i++) {
      const w = byId.get(userIdFor(i, opts))
      expect(w).toBeDefined()
      expect(w?.currency).toBe(opts.currency)
      expect(Number(w?.balance)).toBe(balanceFor(i, opts))
    }
  })

  it('is idempotent: a second run adds no rows, errors, or duplicates', async () => {
    await seedWallets(db, opts)
    const first = await db
      .selectFrom('wallets')
      .select(['user_id', 'balance'])
      .orderBy('user_id')
      .execute()

    await expect(seedWallets(db, opts)).resolves.toEqual({ requested: opts.count })

    expect(await walletCount()).toBe(opts.count)
    const second = await db
      .selectFrom('wallets')
      .select(['user_id', 'balance'])
      .orderBy('user_id')
      .execute()
    expect(second).toEqual(first)
  })

  it('supports a fixed balance when the range collapses to one value', async () => {
    const fixed: SeedOptions = { ...opts, balanceMin: 5000, balanceMax: 5000 }
    await seedWallets(db, fixed)

    const balances = await db.selectFrom('wallets').select('balance').execute()
    expect(balances).toHaveLength(fixed.count)
    expect(balances.every((b) => Number(b.balance) === 5000)).toBe(true)
  })
})
