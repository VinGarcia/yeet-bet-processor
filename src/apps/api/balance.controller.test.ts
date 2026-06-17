import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from './create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import type { Wallet } from '../../core/entities.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>

beforeAll(async () => {
  ctx = await createTestApp()
}, 60_000)

afterAll(() => ctx.close())

beforeEach(() => resetTestDB(ctx.db))

// Self-contained signature over the exact raw body string we send. Uses Node's
// crypto directly so the test is correct independent of our impl.
function signRaw(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex')
}

// Seeds wallet rows for the test. Takes domain entities and translates each to
// the snake_case storage row at the insert boundary, mirroring the adapter.
async function setup(args: { wallets: Wallet[] }): Promise<void> {
  if (args.wallets.length > 0) {
    await ctx.db
      .insertInto('wallets')
      .values(
        args.wallets.map((w) => ({ user_id: w.userId, currency: w.currency, balance: w.balance })),
      )
      .execute()
  }
}

describe('POST /aggregator/takehome/process (balance lookup)', () => {
  it('returns the wallet balance for a balance-only request', async () => {
    await setup({
      wallets: [{ userId: '8|USDT|USD', currency: 'USD', balance: 74322001 }],
    })

    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const signature = signRaw(TEST_SECRET, body)
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}`,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 74322001 })
  })

  it('returns balance 0 for a user with no wallet', async () => {
    await setup({ wallets: [] })

    const body = '{"user_id":"9|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const signature = signRaw(TEST_SECRET, body)
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}`,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 0 })
  })
})
