import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from './create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'

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

describe('POST /aggregator/takehome/process', () => {
  it('rejects a request with no Authorization header with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

    expect(res.status).toBe(403)
    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(403)
    expect(typeof payload.message).toBe('string')
  })

  it('accepts a request with a valid signature with 200', async () => {
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

    // This body carries no `actions`, so it is a balance-only request: the user
    // has no seeded wallet here, so the balance is 0. The assertion's purpose is
    // that a valid signature is accepted (200) and yields a well-formed body.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 0 })
  })

  it('rejects a request with a tampered signature with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const signature = signRaw(TEST_SECRET, body)
    const tampered = signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${tampered}`,
      },
      body,
    })

    expect(res.status).toBe(403)
  })

  it('rejects a request with a malformed Authorization header with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'HMAC-SHA256 nothex',
      },
      body,
    })

    expect(res.status).toBe(403)
  })

  it('rejects a valid signature over a malformed JSON body with 400', async () => {
    const body = '{"user_id":"8|USDT|USD",'
    const signature = signRaw(TEST_SECRET, body)
    const res = await fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}`,
      },
      body,
    })

    expect(res.status).toBe(400)
  })
})
