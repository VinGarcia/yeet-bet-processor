import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from './create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import { KyselyRepo } from '../../adapters/repo/kyselyrepo/index.js'
import type { UserActions, Wallet } from '../../core/entities.js'

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

describe('POST /aggregator/takehome/process (auth)', () => {
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

  // Per-step (in-order) rejection: with balance 150, a batch of [bet 100, bet
  // 100] overdraws at the SECOND bet. The whole request rejects with code 100
  // and rolls back: balance stays 150, no ledger rows. (With bets only this is
  // indistinguishable from a net check — 200 > 150 either way; the per-step vs
  // net distinction only becomes observable once wins interleave, in slice 3c.)
  it('rejects an in-order overdraw mid-batch with code 100 and rolls back', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 150 }] })

    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911004723919',
      actions: [
        { action: 'bet', action_id: 'a1111111-1111-4111-8111-111111111111', amount: 100 },
        { action: 'bet', action_id: 'b2222222-2222-4222-8222-222222222222', amount: 100 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(100)

    // Whole-request rollback: balance unchanged, no ledger rows.
    expect(await dbBalance(user, 'USD')).toBe(150)
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

  // BUG 1 — duplicate action_id WITHIN one batch. Two occurrences of the same
  // brand-new action_id in a single request must be deduped before applying:
  // the bet is debited ONCE, both response slots carry the SAME tx_id, and the
  // ledger holds exactly one row. (Before the fix both occurrences passed the
  // unlocked idempotency SELECT, got distinct tx_ids, debited twice, then
  // collided on UNIQUE(action_id) and surfaced a raw 23505 as HTTP 500.)
  it('dedupes a duplicate action_id within one batch: applied once, same tx_id', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const dupId = 'aaaa1111-2222-4333-8444-555566667777'
    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032913606999230',
      actions: [
        { action: 'bet', action_id: dupId, amount: 100 },
        { action: 'bet', action_id: dupId, amount: 100 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBe(200)

    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Debited once (1000 - 100), not twice.
    expect(payload.balance).toBe(900)
    // Both response slots refer to the same action and share one tx_id.
    expect(payload.transactions).toHaveLength(2)
    expect(payload.transactions[0]!.action_id).toBe(dupId)
    expect(payload.transactions[1]!.action_id).toBe(dupId)
    expect(payload.transactions[0]!.tx_id).toMatch(UUID_RE)
    expect(payload.transactions[1]!.tx_id).toBe(payload.transactions[0]!.tx_id)

    // Persisted: wallet debited once, exactly one ledger row.
    expect(await dbBalance(user, 'USD')).toBe(900)
    expect(await dbTxCount(user)).toBe(1)
  })
})

describe('POST /aggregator/takehome/process (new-user / missing-wallet path)', () => {
  // Regression for the silent-debit-loss bug: a new user (no seeded wallet) who
  // bets a positive amount must reject via the per-step check (would-be balance
  // 0 - amount < 0), and must NOT diverge wallet from ledger. The lazily-created
  // wallet row is rolled back with the transaction, leaving no orphan ledger row.
  it('rejects a new-user positive bet with code 100 and leaves no orphan state', async () => {
    const user = 'new|USDT|USD'
    await setup({ wallets: [] }) // no wallet seeded for this user

    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911004723920',
      actions: [
        { action: 'bet', action_id: 'c3333333-3333-4333-8333-333333333333', amount: 100 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(100)

    // No divergence: the rejected request leaves NO ledger row, and the wallet
    // is either absent or rolled back to 0 (never debited below the ledger).
    expect(await dbTxCount(user)).toBe(0)
    const balance = await dbBalance(user, 'USD')
    expect(balance === undefined || balance === 0).toBe(true)
  })

  // Proves the ensure-and-lock upsert actually persists a wallet row that did
  // not exist before. A zero-amount bet fits the would-be balance (0 - 0 = 0,
  // not < 0) so it commits — but the HTTP layer rejects amount <= 0, so we drive
  // the repo's processActions directly here to exercise the persistence path.
  // The wallet row must now exist at 0 (created by the upsert) and the ledger
  // must reflect exactly one row — wallet and ledger agree, no silent debit loss.
  it('lazily creates and persists the wallet row for a new user when the bet commits', async () => {
    const user = 'new2|USDT|USD'
    await setup({ wallets: [] })

    expect(await dbBalance(user, 'USD')).toBeUndefined() // no row before

    const repo = new KyselyRepo(ctx.db)
    const input: UserActions = {
      userId: user,
      currency: 'USD',
      game: 'acceptance:test',
      gameId: '1761032911004723921',
      actions: [
        { action: 'bet', actionId: 'd4444444-4444-4444-8444-444444444444', amount: 0 },
      ],
    }

    const result = await repo.processActions(input)
    expect(result.balance).toBe(0)
    expect(result.transactions).toHaveLength(1)

    // The upsert created and persisted the row; wallet == response == ledger.
    expect(await dbBalance(user, 'USD')).toBe(0)
    expect(await dbTxCount(user)).toBe(1)
  })

  // Concurrency / lost-update: two concurrent first-bet batches for the SAME
  // brand-new user must serialize on the (ensured) wallet row. With bet-only +
  // start-0 we cannot credit a balance to observe a numeric lost update, so we
  // prove the serialization itself: each batch is a zero-amount bet that commits,
  // fired concurrently against the repo. The ON CONFLICT ensure-and-lock means
  // the second batch waits on the row lock the first took, then sees that row —
  // so there is no duplicate-key crash and no double / lost wallet row. We drive
  // the repo directly (the HTTP layer rejects amount <= 0).
  it('serializes two concurrent first-bet batches for the same new user', async () => {
    const user = 'race|USDT|USD'
    await setup({ wallets: [] })

    const repo = new KyselyRepo(ctx.db)
    const mkInput = (actionId: string): UserActions => ({
      userId: user,
      currency: 'USD',
      game: 'acceptance:test',
      gameId: '1761032911004723922',
      actions: [{ action: 'bet', actionId, amount: 0 }],
    })

    const [r1, r2] = await Promise.all([
      repo.processActions(mkInput('e5555555-5555-4555-8555-555555555555')),
      repo.processActions(mkInput('f6666666-6666-4666-8666-666666666666')),
    ])

    // Both commit (zero-amount bets fit), with no duplicate-key crash from a
    // racing INSERT — the ON CONFLICT path serializes them on the wallet row.
    expect(r1.balance).toBe(0)
    expect(r2.balance).toBe(0)

    // Exactly one wallet row (at 0) and exactly two distinct ledger rows: no
    // lost update, no double-insert, no divergence.
    expect(await dbBalance(user, 'USD')).toBe(0)
    expect(await dbTxCount(user)).toBe(2)
  })

  // BUG 2 — concurrent submission of the SAME brand-new action_id. The up-front
  // idempotency SELECT is unlocked and the wallet lock does not cover the ledger,
  // so two parallel requests both treat the action as new. One commits; the
  // other's ledger insert hits UNIQUE(action_id) (23505), which aborts its
  // transaction — the adapter catches it and re-reads the committed row in a
  // fresh transaction, returning the ORIGINAL tx_id. Both requests succeed with
  // the SAME tx_id, the wallet is debited once, and exactly one ledger row
  // exists. We drive the repo directly and use amount 0 (the HTTP layer rejects
  // amount <= 0, and a positive first bet against a 0-balance new user would be
  // rejected), so the focus stays on the concurrent-duplicate resolution.
  it('resolves a concurrent identical new action_id as a replay (same tx_id, one row)', async () => {
    const user = 'race2|USDT|USD'
    await setup({ wallets: [] })

    const repo = new KyselyRepo(ctx.db)
    const actionId = 'cccc1111-2222-4333-8444-999988887777'
    const input: UserActions = {
      userId: user,
      currency: 'USD',
      game: 'acceptance:test',
      gameId: '1761032911004723923',
      actions: [{ action: 'bet', actionId, amount: 0 }],
    }

    const [r1, r2] = await Promise.all([repo.processActions(input), repo.processActions(input)])

    // Both succeed at balance 0 (no 23505 leaks out as an error).
    expect(r1.balance).toBe(0)
    expect(r2.balance).toBe(0)
    expect(r1.transactions).toHaveLength(1)
    expect(r2.transactions).toHaveLength(1)

    // Both carry the SAME (original) tx_id for the shared action_id.
    expect(r1.transactions[0]!.actionId).toBe(actionId)
    expect(r2.transactions[0]!.actionId).toBe(actionId)
    expect(r1.transactions[0]!.txId).toBe(r2.transactions[0]!.txId)
    expect(r1.transactions[0]!.txId).toMatch(UUID_RE)

    // Applied once: one wallet row at 0, exactly one ledger row.
    expect(await dbBalance(user, 'USD')).toBe(0)
    expect(await dbTxCount(user)).toBe(1)
  })
})

describe('POST /aggregator/takehome/process (win)', () => {
  // Scenario D: a bet and a win in one call apply in order; the win credits the
  // wallet. Final balance = start - 100 + 250 = start + 150.
  it('applies a bet and a win in the same call, in order', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74321901 }] })

    const betId = '7c8affbf-53fd-4fcc-b1ca-18118c5dd287'
    const winId = '86441c7a-560e-4501-b829-110af6a1b956'
    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032910488163506',
      actions: [
        { action: 'bet', action_id: betId, amount: 100 },
        { action: 'win', action_id: winId, amount: 250 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
      game_id: string
    }
    expect(payload.balance).toBe(74322051)
    expect(payload.game_id).toBe('1761032910488163506')
    expect(payload.transactions.map((t) => t.action_id)).toEqual([betId, winId])
    expect(payload.transactions[0]!.tx_id).toMatch(UUID_RE)
    expect(payload.transactions[1]!.tx_id).toMatch(UUID_RE)

    expect(await dbBalance(user, 'USD')).toBe(74322051)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Scenario F: bet then win across two separate calls. Each call credits/debits
  // independently; the second call sees the balance left by the first.
  it('applies a bet then a win across separate calls', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74322201 }] })

    const betRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911166149146',
      actions: [{ action: 'bet', action_id: '19bd35d5-50c3-4720-a402-145a46ab874c', amount: 100 }],
    })
    const betRes = await postSigned(betRaw)
    expect(betRes.status).toBe(200)
    expect(((await betRes.json()) as { balance: number }).balance).toBe(74322101)

    const winRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911166149146',
      actions: [{ action: 'win', action_id: 'dcafc246-24b6-458b-a823-f6e7ecd6e9c3', amount: 700 }],
    })
    const winRes = await postSigned(winRaw)
    expect(winRes.status).toBe(200)
    expect(((await winRes.json()) as { balance: number }).balance).toBe(74322801)

    expect(await dbBalance(user, 'USD')).toBe(74322801)
    expect(await dbTxCount(user)).toBe(2)
  })

  // In-order semantics are now OBSERVABLE: with a win after a bet, a per-step
  // check and a net-sum check DISAGREE. balance 50, [bet 100, win 200]: the bet
  // overdraws at step 1 (-50) so the whole request is rejected with code 100 and
  // rolls back — even though the net delta (+100) would leave a positive balance.
  // This is the test a net-only implementation cannot pass.
  it('rejects a batch whose bet overdraws before a later win, despite positive net', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032911004723999',
      actions: [
        { action: 'bet', action_id: 'a1111111-1111-4111-8111-111111111111', amount: 100 },
        { action: 'win', action_id: 'b2222222-2222-4222-8222-222222222222', amount: 200 },
      ],
    })

    const res = await postSigned(raw)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(100)

    // Whole request rolled back: nothing applied.
    expect(await dbBalance(user, 'USD')).toBe(50)
    expect(await dbTxCount(user)).toBe(0)
  })
})
