import { createHmac, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from './create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>

beforeAll(async () => {
  ctx = await createTestApp()
}, 60_000)

afterAll(() => ctx.close())

beforeEach(() => resetTestDB(ctx.db))

const USERS_URL = '/aggregator/takehome/reports/rtp/users'
const CASINO_URL = '/aggregator/takehome/reports/rtp/casino'

function signRaw(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex')
}

// POSTs a raw JSON body with a valid HMAC signature to the given report path.
async function postSignedTo(path: string, raw: string): Promise<Response> {
  return fetch(`${ctx.baseURL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `HMAC-SHA256 ${signRaw(TEST_SECRET, raw)}`,
    },
    body: raw,
  })
}

// A single seeded ledger row. Seeding directly lets a test control `created_at`
// and `rolledback`, which the /process path cannot set (it stamps `now()` and
// derives `rolledback` from rollbacks). Fresh random `id`/`action_id` per row.
type SeedTx = {
  userId: string
  currency: string
  type: 'bet' | 'win' | 'rollback'
  amount: number
  createdAt: string
  rolledback?: boolean
}

async function seedTx(rows: SeedTx[]): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO transactions
        (id, action_id, user_id, currency, game, game_id, type, amount, original_action_id, rolledback, created_at)
      VALUES
        (${randomUUID()}, ${randomUUID()}, ${r.userId}, ${r.currency}, ${'acceptance:test'},
         ${null}, ${r.type}, ${r.amount}, ${null}, ${r.rolledback ?? false}, ${r.createdAt})
    `.execute(ctx.db)
  }
}

type UserItem = {
  user_id: string
  currency: string
  rounds: number
  total_bet: number
  total_win: number
  rtp: number | null
  rolled_back_bet: number
  rolled_back_win: number
}
type CasinoItem = Omit<UserItem, 'user_id'>

// A window wide enough to contain every in-window seeded row below.
const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-31T23:59:59.999Z'
const MID = '2026-01-15T12:00:00.000Z'

describe('POST /reports/rtp/users (per-user RTP)', () => {
  it('aggregates per (user, currency), excluding reversed rows from the sums', async () => {
    await seedTx([
      // user-1 / USD: 2 live bets (1500), 1 live win (1400); a reversed bet (200)
      // and reversed win (100) excluded from the sums but surfaced separately; a
      // rollback row is ignored entirely (type not in bet/win).
      { userId: 'user-1', currency: 'USD', type: 'bet', amount: 1000, createdAt: MID },
      { userId: 'user-1', currency: 'USD', type: 'bet', amount: 500, createdAt: MID },
      { userId: 'user-1', currency: 'USD', type: 'win', amount: 1400, createdAt: MID },
      { userId: 'user-1', currency: 'USD', type: 'bet', amount: 200, createdAt: MID, rolledback: true },
      { userId: 'user-1', currency: 'USD', type: 'win', amount: 100, createdAt: MID, rolledback: true },
      { userId: 'user-1', currency: 'USD', type: 'rollback', amount: 0, createdAt: MID },
      // user-1 / EUR: a separate (user, currency) group.
      { userId: 'user-1', currency: 'EUR', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'user-1', currency: 'EUR', type: 'win', amount: 90, createdAt: MID },
      // user-2 / USD.
      { userId: 'user-2', currency: 'USD', type: 'bet', amount: 2000, createdAt: MID },
      { userId: 'user-2', currency: 'USD', type: 'win', amount: 1800, createdAt: MID },
    ])

    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM, to: TO }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: UserItem[]; cursor: string | null }

    // Ordered by (currency, user_id): EUR/user-1, USD/user-1, USD/user-2.
    expect(body.items.map((i) => [i.currency, i.user_id])).toEqual([
      ['EUR', 'user-1'],
      ['USD', 'user-1'],
      ['USD', 'user-2'],
    ])
    expect(body.cursor).toBeNull()

    const u1usd = body.items.find((i) => i.currency === 'USD' && i.user_id === 'user-1')!
    expect(u1usd.rounds).toBe(2)
    expect(u1usd.total_bet).toBe(1500)
    expect(u1usd.total_win).toBe(1400)
    expect(u1usd.rtp).toBeCloseTo(1400 / 1500, 10)
    expect(u1usd.rolled_back_bet).toBe(200)
    expect(u1usd.rolled_back_win).toBe(100)
  })

  it('returns rtp null when the denominator is 0 (only wins or only reversed bets)', async () => {
    await seedTx([
      // Only a live win → total_bet 0 → rtp null.
      { userId: 'wins-only', currency: 'USD', type: 'win', amount: 500, createdAt: MID },
      // Only a reversed bet → still total_bet 0 → rtp null, but rolled_back_bet set.
      { userId: 'reversed-only', currency: 'USD', type: 'bet', amount: 300, createdAt: MID, rolledback: true },
    ])

    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM, to: TO }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: UserItem[] }

    const winsOnly = body.items.find((i) => i.user_id === 'wins-only')!
    expect(winsOnly.rounds).toBe(0)
    expect(winsOnly.total_bet).toBe(0)
    expect(winsOnly.total_win).toBe(500)
    expect(winsOnly.rtp).toBeNull()

    const reversedOnly = body.items.find((i) => i.user_id === 'reversed-only')!
    expect(reversedOnly.rounds).toBe(0)
    expect(reversedOnly.total_bet).toBe(0)
    expect(reversedOnly.rtp).toBeNull()
    expect(reversedOnly.rolled_back_bet).toBe(300)
  })

  it('treats the window as half-open [from, to): from in, to out', async () => {
    const justBefore = '2026-01-09T23:59:59.999Z'
    const justInside = '2026-01-10T23:59:59.999Z'
    const from = '2026-01-10T00:00:00.000Z'
    const to = '2026-01-11T00:00:00.000Z'
    await seedTx([
      { userId: 'edge', currency: 'USD', type: 'bet', amount: 100, createdAt: from }, // == from, in
      { userId: 'edge', currency: 'USD', type: 'bet', amount: 100, createdAt: justInside }, // < to, in
      { userId: 'edge', currency: 'USD', type: 'bet', amount: 100, createdAt: to }, // == to, OUT (half-open)
      { userId: 'edge', currency: 'USD', type: 'bet', amount: 100, createdAt: justBefore }, // < from, out
    ])

    const res = await postSignedTo(USERS_URL, JSON.stringify({ from, to }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: UserItem[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.rounds).toBe(2)
    expect(body.items[0]!.total_bet).toBe(200)
  })

  // Two adjacent half-open windows (…to=T then from=T…) partition the timeline
  // with no overlap and no gap: a row stamped exactly at T lands in the second.
  it('adjacent half-open windows do not double-count a boundary row', async () => {
    const boundary = '2026-01-10T00:00:00.000Z'
    await seedTx([{ userId: 'seam', currency: 'USD', type: 'bet', amount: 100, createdAt: boundary }])

    const before = await postSignedTo(
      USERS_URL,
      JSON.stringify({ from: '2026-01-09T00:00:00.000Z', to: boundary }),
    )
    const after = await postSignedTo(
      USERS_URL,
      JSON.stringify({ from: boundary, to: '2026-01-11T00:00:00.000Z' }),
    )
    const beforeBody = (await before.json()) as { items: UserItem[] }
    const afterBody = (await after.json()) as { items: UserItem[] }
    expect(beforeBody.items).toHaveLength(0)
    expect(afterBody.items).toHaveLength(1)
    expect(afterBody.items[0]!.rounds).toBe(1)
  })

  it('returns empty items and a null cursor for a window with no rows', async () => {
    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM, to: TO }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], cursor: null })
  })

  it('paginates with a stable keyset cursor (no overlap, no gaps)', async () => {
    await seedTx([
      { userId: 'p-user-1', currency: 'USD', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'p-user-2', currency: 'USD', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'p-user-3', currency: 'USD', type: 'bet', amount: 100, createdAt: MID },
    ])

    const first = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM, to: TO, limit: 2 }))
    expect(first.status).toBe(200)
    const page1 = (await first.json()) as { items: UserItem[]; cursor: string | null }
    expect(page1.items.map((i) => i.user_id)).toEqual(['p-user-1', 'p-user-2'])
    expect(page1.cursor).toEqual(expect.any(String))

    const second = await postSignedTo(
      USERS_URL,
      JSON.stringify({ from: FROM, to: TO, limit: 2, cursor: page1.cursor }),
    )
    expect(second.status).toBe(200)
    const page2 = (await second.json()) as { items: UserItem[]; cursor: string | null }
    expect(page2.items.map((i) => i.user_id)).toEqual(['p-user-3'])
    expect(page2.cursor).toBeNull()
  })
})

describe('POST /reports/rtp/casino (casino-wide RTP)', () => {
  it('aggregates across users, grouped per currency', async () => {
    await seedTx([
      { userId: 'user-a', currency: 'USD', type: 'bet', amount: 1000, createdAt: MID },
      { userId: 'user-a', currency: 'USD', type: 'win', amount: 950, createdAt: MID },
      { userId: 'user-b', currency: 'USD', type: 'bet', amount: 2000, createdAt: MID },
      { userId: 'user-b', currency: 'USD', type: 'win', amount: 1900, createdAt: MID },
      { userId: 'user-a', currency: 'EUR', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'user-a', currency: 'EUR', type: 'win', amount: 90, createdAt: MID },
    ])

    const res = await postSignedTo(CASINO_URL, JSON.stringify({ from: FROM, to: TO }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: CasinoItem[]; cursor: string | null }

    expect(body.items.map((i) => i.currency)).toEqual(['EUR', 'USD'])
    expect(body.cursor).toBeNull()
    // No user_id on casino rows.
    expect(body.items[0]).not.toHaveProperty('user_id')

    const usd = body.items.find((i) => i.currency === 'USD')!
    expect(usd.rounds).toBe(2)
    expect(usd.total_bet).toBe(3000)
    expect(usd.total_win).toBe(2850)
    expect(usd.rtp).toBeCloseTo(0.95, 10)
  })

  it('paginates per currency with a keyset cursor', async () => {
    await seedTx([
      { userId: 'x', currency: 'AAA', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'x', currency: 'BBB', type: 'bet', amount: 100, createdAt: MID },
      { userId: 'x', currency: 'CCC', type: 'bet', amount: 100, createdAt: MID },
    ])

    const first = await postSignedTo(CASINO_URL, JSON.stringify({ from: FROM, to: TO, limit: 2 }))
    const page1 = (await first.json()) as { items: CasinoItem[]; cursor: string | null }
    expect(page1.items.map((i) => i.currency)).toEqual(['AAA', 'BBB'])
    expect(page1.cursor).toEqual(expect.any(String))

    const second = await postSignedTo(
      CASINO_URL,
      JSON.stringify({ from: FROM, to: TO, limit: 2, cursor: page1.cursor }),
    )
    const page2 = (await second.json()) as { items: CasinoItem[]; cursor: string | null }
    expect(page2.items.map((i) => i.currency)).toEqual(['CCC'])
    expect(page2.cursor).toBeNull()
  })
})

describe('POST /reports/rtp/* (auth & validation)', () => {
  it('rejects a missing HMAC signature with 403', async () => {
    const res = await fetch(`${ctx.baseURL}${USERS_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: TO }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid HMAC signature with 403', async () => {
    const raw = JSON.stringify({ from: FROM, to: TO })
    const res = await fetch(`${ctx.baseURL}${CASINO_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'HMAC-SHA256 deadbeef' },
      body: raw,
    })
    expect(res.status).toBe(403)
  })

  it('rejects a malformed `from` datetime with 400', async () => {
    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: 'not-a-date', to: TO }))
    expect(res.status).toBe(400)
  })

  it('rejects a missing `to` with 400', async () => {
    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM }))
    expect(res.status).toBe(400)
  })

  it('rejects from > to with 400', async () => {
    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: TO, to: FROM }))
    expect(res.status).toBe(400)
  })

  it('rejects a non-string cursor with 400', async () => {
    const res = await postSignedTo(USERS_URL, JSON.stringify({ from: FROM, to: TO, cursor: 123 }))
    expect(res.status).toBe(400)
  })
})
