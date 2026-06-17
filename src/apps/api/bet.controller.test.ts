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

// POSTs a raw JSON body with a valid HMAC signature over those exact bytes.
async function postSigned(raw: string): Promise<Response> {
  return fetch(`${ctx.baseURL}/aggregator/takehome/process`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `HMAC-SHA256 ${signRaw(TEST_SECRET, raw)}`,
    },
    body: raw,
  })
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

// Reads back the persisted balance for a user/currency (number at the boundary).
async function dbBalance(userId: string, currency: string): Promise<number | undefined> {
  const row = await ctx.db
    .selectFrom('wallets')
    .where('user_id', '=', userId)
    .where('currency', '=', currency)
    .select('balance')
    .executeTakeFirst()
  return row === undefined ? undefined : Number(row.balance)
}

// Counts persisted ledger rows for a user (idempotency must not double-insert).
async function dbTxCount(userId: string): Promise<number> {
  const rows = await ctx.db
    .selectFrom('transactions')
    .where('user_id', '=', userId)
    .select('id')
    .execute()
  return rows.length
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('POST /aggregator/takehome/process (bet)', () => {
  // Scenario C: a single bet reduces the balance by the bet amount and returns
  // a transaction for it, the new balance, and the echoed game_id.
  it('applies a single bet, debits the wallet, and returns the transaction', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const actionId = '3b42f070-dab5-4d6c-8bc6-7241b68f00bd'
    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032910245540510',
      finished: true,
      actions: [{ action: 'bet', action_id: actionId, amount: 100 }],
    })

    const res = await postSigned(raw)
    expect(res.status).toBe(200)

    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
      game_id: string
    }
    expect(payload.balance).toBe(900)
    expect(payload.game_id).toBe('1761032910245540510')
    expect(payload.transactions).toHaveLength(1)
    expect(payload.transactions[0]!.action_id).toBe(actionId)
    expect(payload.transactions[0]!.tx_id).toMatch(UUID_RE)

    // Persisted state: wallet debited, exactly one ledger row.
    expect(await dbBalance(user, 'USD')).toBe(900)
    expect(await dbTxCount(user)).toBe(1)
  })

  // Scenario E: a bet that would drive the balance below zero is rejected with
  // the domain code 100, and the whole request rolls back (no balance change,
  // no ledger row written).
  it('rejects an over-balance bet with code 100 and rolls the request back', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911004723918',
      finished: true,
      actions: [
        { action: 'bet', action_id: '6c1e98e8-8e93-4856-b6ef-8b2ddc6c4cbc', amount: 74322202 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(100)
    expect(payload.message).toBe('Player has not enough funds to process an action')

    // Nothing applied: balance untouched, no ledger row.
    expect(await dbBalance(user, 'USD')).toBe(50)
    expect(await dbTxCount(user)).toBe(0)
  })

  // Scenario H: a duplicate action_id across calls must not apply twice. The
  // replay returns the original tx_id; a new action in the same batch applies
  // once. Final balance reflects only the two distinct bets.
  it('is idempotent on action_id: replay returns original tx_id, only new bets apply', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74322151 }] })

    const firstId = 'f61c5eba-fb26-4070-89b5-c3a2edf54c02'
    const firstRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032913606999220',
      actions: [{ action: 'bet', action_id: firstId, amount: 100 }],
    })

    const firstRes = await postSigned(firstRaw)
    expect(firstRes.status).toBe(200)
    const first = (await firstRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(first.balance).toBe(74322051)
    expect(first.transactions).toHaveLength(1)
    const originalTxId = first.transactions[0]!.tx_id
    expect(originalTxId).toMatch(UUID_RE)

    // Re-send the same bet plus a brand new one; only the new one should apply.
    const secondId = 'd94b2fa5-e87f-4d8e-9a01-4a443ed5c11c'
    const secondRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032913606999220',
      actions: [
        { action: 'bet', action_id: firstId, amount: 100 },
        { action: 'bet', action_id: secondId, amount: 50 },
      ],
    })

    const secondRes = await postSigned(secondRaw)
    expect(secondRes.status).toBe(200)
    const second = (await secondRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(second.balance).toBe(74322001)
    expect(second.transactions).toHaveLength(2)
    // Order preserved; the replayed action keeps its original tx_id.
    expect(second.transactions[0]).toEqual({ action_id: firstId, tx_id: originalTxId })
    expect(second.transactions[1]!.action_id).toBe(secondId)
    expect(second.transactions[1]!.tx_id).toMatch(UUID_RE)
    expect(second.transactions[1]!.tx_id).not.toBe(originalTxId)

    // Persisted: only two distinct ledger rows, final balance correct.
    expect(await dbBalance(user, 'USD')).toBe(74322001)
    expect(await dbTxCount(user)).toBe(2)
  })
})
