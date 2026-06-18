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

// Reads back a persisted ledger row by action_id so tests can assert the columns
// the RTP slice depends on (type, amount, original_action_id) actually landed —
// a row count alone can't catch a swapped or empty original_action_id.
async function dbTxRow(
  actionId: string,
): Promise<{ type: string; amount: number; originalActionId: string | null } | undefined> {
  const row = await ctx.db
    .selectFrom('transactions')
    .where('action_id', '=', actionId)
    .select(['type', 'amount', 'original_action_id'])
    .executeTakeFirst()
  return row === undefined
    ? undefined
    : { type: row.type, amount: Number(row.amount), originalActionId: row.original_action_id }
}

// Reads back the `rolledback` denormalization flag for a single action_id so
// tests can assert an original is marked reversed (the future RTP query filters
// on it instead of an anti-join). Returns undefined when the row is absent.
async function dbTxRolledback(actionId: string): Promise<boolean | undefined> {
  const row = await ctx.db
    .selectFrom('transactions')
    .where('action_id', '=', actionId)
    .select('rolledback')
    .executeTakeFirst()
  return row === undefined ? undefined : row.rolledback
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
      actions: [{ action: 'bet', action_id: 'c3333333-3333-4333-8333-333333333333', amount: 100 }],
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
  // not exist before. A `win` credits a brand-new (no-wallet) user, so it always
  // commits via the lazy-create upsert. We drive the repo directly for parity
  // with the concurrency cases below. The wallet row must now exist at 100
  // (created by the upsert) and the ledger must reflect exactly one row — wallet
  // and ledger agree, no divergence.
  it('lazily creates and persists the wallet row for a new user when an action commits', async () => {
    const user = 'new2|USDT|USD'
    await setup({ wallets: [] })

    expect(await dbBalance(user, 'USD')).toBeUndefined() // no row before

    const repo = new KyselyRepo(ctx.db)
    const input: UserActions = {
      userId: user,
      currency: 'USD',
      game: 'acceptance:test',
      gameId: '1761032911004723921',
      actions: [{ action: 'win', actionId: 'd4444444-4444-4444-8444-444444444444', amount: 100 }],
    }

    const result = await repo.processActions(input)
    expect(result.balance).toBe(100)
    expect(result.transactions).toHaveLength(1)

    // The upsert created and persisted the row; wallet == response == ledger.
    expect(await dbBalance(user, 'USD')).toBe(100)
    expect(await dbTxCount(user)).toBe(1)
  })

  // Concurrency / lost-update: two concurrent first-action batches for the SAME
  // brand-new user must serialize on the (ensured) wallet row. Each batch is a
  // distinct `win` of 100, fired concurrently against the repo. The ON CONFLICT
  // ensure-and-lock means the second batch waits on the row lock the first took,
  // then reads its committed balance — so a final balance of 200 proves no lost
  // update (neither credit clobbered the other) and there is no duplicate-key
  // crash.
  it('serializes two concurrent first-action batches for the same new user', async () => {
    const user = 'race|USDT|USD'
    await setup({ wallets: [] })

    const repo = new KyselyRepo(ctx.db)
    const mkInput = (actionId: string): UserActions => ({
      userId: user,
      currency: 'USD',
      game: 'acceptance:test',
      gameId: '1761032911004723922',
      actions: [{ action: 'win', actionId, amount: 100 }],
    })

    const [r1, r2] = await Promise.all([
      repo.processActions(mkInput('e5555555-5555-4555-8555-555555555555')),
      repo.processActions(mkInput('f6666666-6666-4666-8666-666666666666')),
    ])

    // Serialized on the wallet row: one batch sees 100, the other 200 — no lost
    // update, no duplicate-key crash from a racing INSERT.
    expect(Math.min(r1.balance, r2.balance)).toBe(100)
    expect(Math.max(r1.balance, r2.balance)).toBe(200)

    // Exactly one wallet row (at 200) and exactly two distinct ledger rows.
    expect(await dbBalance(user, 'USD')).toBe(200)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Concurrent submission of the SAME brand-new action_id. Both requests
  // serialize on the ensured wallet row; the second sees the first's committed
  // ledger row as an existing replay and returns its ORIGINAL tx_id. The action
  // applies exactly once: same tx_id, one ledger row, a single 100 credit (no
  // double-apply, no UNIQUE(action_id) violation leaking out). Driven directly to
  // fire the two calls concurrently.
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
      actions: [{ action: 'win', actionId, amount: 100 }],
    }

    const [r1, r2] = await Promise.all([repo.processActions(input), repo.processActions(input)])

    // Applied once: both observe the single 100 credit, no error leaks out.
    expect(r1.balance).toBe(100)
    expect(r2.balance).toBe(100)
    expect(r1.transactions).toHaveLength(1)
    expect(r2.transactions).toHaveLength(1)

    // Both carry the SAME (original) tx_id for the shared action_id.
    expect(r1.transactions[0]!.actionId).toBe(actionId)
    expect(r2.transactions[0]!.actionId).toBe(actionId)
    expect(r1.transactions[0]!.txId).toBe(r2.transactions[0]!.txId)
    expect(r1.transactions[0]!.txId).toMatch(UUID_RE)

    // Applied once: one wallet row at 100, exactly one ledger row.
    expect(await dbBalance(user, 'USD')).toBe(100)
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
    payload.transactions.forEach((t) => expect(t.tx_id).toMatch(UUID_RE))

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

describe('POST /aggregator/takehome/process (rollback)', () => {
  // Scenario G: bet then rollback that bet across two calls. The rollback of a
  // bet CREDITS the amount back (opposite of the original), restoring the
  // balance, and returns a tx_id of its own.
  it('credits back a bet when its rollback arrives after it (scenario G)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74322001 }] })

    const betId = '4dbcbf1d-bcf6-43e9-9a62-7d3c0f3c6486'
    const betRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761034000123456789',
      actions: [{ action: 'bet', action_id: betId, amount: 100 }],
    })
    const betRes = await postSigned(betRaw)
    expect(betRes.status).toBe(200)
    expect(((await betRes.json()) as { balance: number }).balance).toBe(74321901)

    const rbId = 'c9a9c3a7-e9e8-4f5a-9fdf-1d8a377d1b8f'
    const rbRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761034000123456789',
      actions: [{ action: 'rollback', action_id: rbId, original_action_id: betId }],
    })
    const rbRes = await postSigned(rbRaw)
    expect(rbRes.status).toBe(200)
    const payload = (await rbRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Bet credited back: balance restored to its pre-bet value.
    expect(payload.balance).toBe(74322001)
    expect(payload.transactions).toHaveLength(1)
    expect(payload.transactions[0]!.action_id).toBe(rbId)
    expect(payload.transactions[0]!.tx_id).toMatch(UUID_RE)

    expect(await dbBalance(user, 'USD')).toBe(74322001)
    // bet row + rollback row.
    expect(await dbTxCount(user)).toBe(2)
    // The rollback row persists the columns the RTP slice derives "reversed" from.
    expect(await dbTxRow(rbId)).toEqual({
      type: 'rollback',
      amount: 0,
      originalActionId: betId,
    })
  })

  // Scenario I: a rollback that references a not-yet-seen bet is RECORDED (no
  // balance change now), and when the bet later arrives it becomes a NOOP (no
  // deduct) — yet still returns a tx_id. Both across separate calls.
  it('records a pre-rollback and noops the later bet (scenario I)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74321821 }] })

    const origId = '27710aca-60f9-4259-a9bb-26f75cd05917'
    const rbId = '65d57850-5ee3-418b-b1b0-b4975242efcf'
    const rbRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032915476894301',
      actions: [{ action: 'rollback', action_id: rbId, original_action_id: origId }],
    })
    const rbRes = await postSigned(rbRaw)
    expect(rbRes.status).toBe(200)
    const rb = (await rbRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Pre-rollback recorded, no balance change.
    expect(rb.balance).toBe(74321821)
    expect(rb.transactions[0]!.action_id).toBe(rbId)
    expect(rb.transactions[0]!.tx_id).toMatch(UUID_RE)
    expect(await dbBalance(user, 'USD')).toBe(74321821)
    expect(await dbTxCount(user)).toBe(1)
    // Pre-rollback row persists original_action_id even before the original exists.
    expect(await dbTxRow(rbId)).toEqual({
      type: 'rollback',
      amount: 0,
      originalActionId: origId,
    })

    const betRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032915476894301',
      actions: [{ action: 'bet', action_id: origId, amount: 100 }],
    })
    const betRes = await postSigned(betRaw)
    expect(betRes.status).toBe(200)
    const bet = (await betRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // The bet is noop'd: no deduct, but it still returns a tx_id and is recorded.
    expect(bet.balance).toBe(74321821)
    expect(bet.transactions[0]!.action_id).toBe(origId)
    expect(bet.transactions[0]!.tx_id).toMatch(UUID_RE)
    expect(await dbBalance(user, 'USD')).toBe(74321821)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Scenario J: two rollbacks (for a future bet and a future win) arrive before
  // either exists. Both are recorded with no balance change; the later bet and
  // win both noop, leaving the balance untouched. All four return tx_ids.
  it('records two pre-rollbacks and noops the later bet+win (scenario J)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 74321821 }] })

    const origBetId = 'a2fd2ce9-5184-48b6-bdde-f6ba05d32e01'
    const origWinId = '7e4ad25b-b2c2-4eb7-b38e-63e7ddcdab52'
    const rb1Id = '12af93e7-f208-46f1-9399-4c1668fdd675'
    const rb2Id = '85762689-2ab3-40d6-a7cd-e3babb53ae06'
    const rbRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566632',
      actions: [
        { action: 'rollback', action_id: rb1Id, original_action_id: origBetId },
        { action: 'rollback', action_id: rb2Id, original_action_id: origWinId },
      ],
    })
    const rbRes = await postSigned(rbRaw)
    expect(rbRes.status).toBe(200)
    const rb = (await rbRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(rb.balance).toBe(74321821)
    expect(rb.transactions.map((t) => t.action_id)).toEqual([rb1Id, rb2Id])
    rb.transactions.forEach((t) => expect(t.tx_id).toMatch(UUID_RE))
    expect(await dbTxCount(user)).toBe(2)

    const bwRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566632',
      actions: [
        { action: 'bet', action_id: origBetId, amount: 100 },
        { action: 'win', action_id: origWinId, amount: 250 },
      ],
    })
    const bwRes = await postSigned(bwRaw)
    expect(bwRes.status).toBe(200)
    const bw = (await bwRes.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Both noop'd: no net effect on the balance.
    expect(bw.balance).toBe(74321821)
    expect(bw.transactions.map((t) => t.action_id)).toEqual([origBetId, origWinId])
    bw.transactions.forEach((t) => expect(t.tx_id).toMatch(UUID_RE))
    expect(await dbBalance(user, 'USD')).toBe(74321821)
    expect(await dbTxCount(user)).toBe(4)
  })

  // Same-batch [bet A, rollback A]: the bet is cancelled by its rollback, so it is
  // noop'd (never applied) rather than applied-then-reversed. Net zero, both rows.
  it('noops a bet cancelled by a rollback in the same batch (net zero)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = '11111111-aaaa-4aaa-8aaa-111111111111'
    const rbId = '22222222-bbbb-4bbb-8bbb-222222222222'
    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566700',
      actions: [
        { action: 'bet', action_id: betId, amount: 100 },
        { action: 'rollback', action_id: rbId, original_action_id: betId },
      ],
    })
    const res = await postSigned(raw)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(payload.balance).toBe(1000)
    expect(payload.transactions.map((t) => t.action_id)).toEqual([betId, rbId])
    payload.transactions.forEach((t) => expect(t.tx_id).toMatch(UUID_RE))
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Behavior decision (README "Rollback ordering"): a bet that WOULD overdraw is
  // NOT rejected when the same batch rolls it back — the bet is noop'd (never
  // applied), so the per-step funds check never sees it. Balance 50, [bet 100,
  // rollback bet]: net zero, both rows recorded, no insufficient-funds error.
  it('noops an overdrawing bet that is rolled back in the same batch (no 100 error)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const betId = 'a0000000-1111-4111-8111-a00000000001'
    const rbId = 'a0000000-2222-4222-8222-a00000000002'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566800',
        actions: [
          { action: 'bet', action_id: betId, amount: 100 },
          { action: 'rollback', action_id: rbId, original_action_id: betId },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(payload.balance).toBe(50)
    expect(payload.transactions.map((t) => t.action_id)).toEqual([betId, rbId])
    // Both rows recorded; the bet landed noop'd (rolledback=true), never applied.
    expect(await dbBalance(user, 'USD')).toBe(50)
    expect(await dbTxCount(user)).toBe(2)
    expect(await dbTxRolledback(betId)).toBe(true)
  })

  // The noop of a rolled-back overdrawing bet must not block a later VALID bet in
  // the same batch: balance 50, [bet 100 (rolled back → noop), rollback, bet 30].
  // The 100 never debits; the 30 applies → balance 20.
  it('noops a rolled-back overdrawing bet but still applies a later valid bet', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const betA = 'a1000000-1111-4111-8111-a10000000001'
    const rb = 'a1000000-2222-4222-8222-a10000000002'
    const betB = 'a1000000-3333-4333-8333-a10000000003'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566801',
        actions: [
          { action: 'bet', action_id: betA, amount: 100 },
          { action: 'rollback', action_id: rb, original_action_id: betA },
          { action: 'bet', action_id: betB, amount: 30 },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { balance: number }).balance).toBe(20)
    expect(await dbBalance(user, 'USD')).toBe(20)
    expect(await dbTxCount(user)).toBe(3)
    expect(await dbTxRolledback(betA)).toBe(true)
    expect(await dbTxRolledback(betB)).toBe(false)
  })

  // Same-batch [rollback A, bet A]: the rollback is recorded first (pre), then
  // the bet noops in the same pass. Net zero, both return tx_ids.
  it('records a rollback then noops its bet within one batch (net zero)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = '33333333-cccc-4ccc-8ccc-333333333333'
    const rbId = '44444444-dddd-4ddd-8ddd-444444444444'
    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566701',
      actions: [
        { action: 'rollback', action_id: rbId, original_action_id: betId },
        { action: 'bet', action_id: betId, amount: 100 },
      ],
    })
    const res = await postSigned(raw)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(payload.balance).toBe(1000)
    expect(payload.transactions.map((t) => t.action_id)).toEqual([rbId, betId])
    payload.transactions.forEach((t) => expect(t.tx_id).toMatch(UUID_RE))
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Rollback of a WIN claws back (DEBITS) the credited amount. With funds to
  // cover it, the balance decreases by the win amount.
  it('debits back a win when its rollback arrives after it (clawback)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const winId = '55555555-eeee-4eee-8eee-555555555555'
    const winRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566702',
      actions: [{ action: 'win', action_id: winId, amount: 200 }],
    })
    const winRes = await postSigned(winRaw)
    expect(winRes.status).toBe(200)
    expect(((await winRes.json()) as { balance: number }).balance).toBe(1200)

    const rbId = '66666666-ffff-4fff-8fff-666666666666'
    const rbRaw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566702',
      actions: [{ action: 'rollback', action_id: rbId, original_action_id: winId }],
    })
    const rbRes = await postSigned(rbRaw)
    expect(rbRes.status).toBe(200)
    const payload = (await rbRes.json()) as { balance: number }
    // Win clawed back: 1200 - 200.
    expect(payload.balance).toBe(1000)
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // A win clawback that would drive the balance below zero is rejected with the
  // SAME insufficient-funds domain code (100) as a bet, rolling the whole batch
  // back. The win must be COMMITTED for the clawback to debit (a same-batch win is
  // noop'd, never credited): call 1 commits win 100 (→150) then bet 130 (→20);
  // call 2's rollback-of-win debits 100 → 20 - 100 = -80 < 0 → reject.
  it('rejects a committed-win clawback overdraw with code 100 and rolls the batch back', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const winId = '77777777-1111-4111-8111-777777777777'
    const betId = '88888888-2222-4222-8222-888888888888'
    const rbId = '99999999-3333-4333-8333-999999999999'

    // Call 1: commit the win and a bet, leaving balance 20.
    const call1 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566703',
        actions: [
          { action: 'win', action_id: winId, amount: 100 },
          { action: 'bet', action_id: betId, amount: 130 },
        ],
      }),
    )
    expect(call1.status).toBe(200)
    expect(await dbBalance(user, 'USD')).toBe(20)

    // Call 2: clawing back the committed win debits 100 → 20 - 100 = -80 < 0.
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566703',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: winId }],
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(100)

    // Call 2 rolled back: balance and ledger unchanged from call 1.
    expect(await dbBalance(user, 'USD')).toBe(20)
    expect(await dbTxCount(user)).toBe(2)
  })

  // A second, DISTINCT rollback targeting an original that already has a
  // committed rollback is rejected with 400 (double rollback).
  it('rejects a double rollback (distinct id, same original) with 400', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
    const rb1Id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    const rb2Id = 'cccccccc-3333-4333-8333-cccccccccccc'

    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566704',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    const rb1 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566704',
        actions: [{ action: 'rollback', action_id: rb1Id, original_action_id: betId }],
      }),
    )
    expect(rb1.status).toBe(200)
    expect(await dbBalance(user, 'USD')).toBe(1000)

    const rb2 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566704',
        actions: [{ action: 'rollback', action_id: rb2Id, original_action_id: betId }],
      }),
    )
    expect(rb2.status).toBe(400)
    // Unchanged: balance still restored, only bet + first rollback persisted.
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // A rollback whose original_action_id points at a rollback row is rejected
  // with 400 (rollback-of-rollback).
  it('rejects a rollback-of-a-rollback with 400', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'dddddddd-1111-4111-8111-dddddddddddd'
    const rb1Id = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee'
    const rb2Id = 'ffffffff-3333-4333-8333-ffffffffffff'

    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566705',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566705',
        actions: [{ action: 'rollback', action_id: rb1Id, original_action_id: betId }],
      }),
    )
    // Now roll back the rollback itself.
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566705',
        actions: [{ action: 'rollback', action_id: rb2Id, original_action_id: rb1Id }],
      }),
    )
    expect(res.status).toBe(400)
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // Same-batch rollback-of-a-rollback, inner rollback LATER in the batch:
  // [rollback R2→R1, rollback R1→A]. R2 targets R1 (a rollback) → 400 even though
  // R1 is processed after R2 (detection is order-independent). Whole batch rolls back.
  it('rejects a same-batch rollback-of-a-rollback when the inner rollback comes later', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const aId = 'd1000000-1111-4111-8111-d10000000001'
    const r1Id = 'd1000000-2222-4222-8222-d10000000002'
    const r2Id = 'd1000000-3333-4333-8333-d10000000003'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566810',
        actions: [
          { action: 'rollback', action_id: r2Id, original_action_id: r1Id },
          { action: 'rollback', action_id: r1Id, original_action_id: aId },
        ],
      }),
    )
    expect(res.status).toBe(400)
    expect(await dbTxCount(user)).toBe(0)
  })

  // Same-batch rollback-of-a-rollback, inner rollback EARLIER in the batch:
  // [bet A, rollback R1→A, rollback R2→R1] → 400.
  it('rejects a same-batch rollback-of-a-rollback when the inner rollback comes first', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const aId = 'd2000000-1111-4111-8111-d20000000001'
    const r1Id = 'd2000000-2222-4222-8222-d20000000002'
    const r2Id = 'd2000000-3333-4333-8333-d20000000003'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566811',
        actions: [
          { action: 'bet', action_id: aId, amount: 100 },
          { action: 'rollback', action_id: r1Id, original_action_id: aId },
          { action: 'rollback', action_id: r2Id, original_action_id: r1Id },
        ],
      }),
    )
    expect(res.status).toBe(400)
    expect(await dbTxCount(user)).toBe(0)
  })

  // Replaying a rollback action_id returns its original tx_id and does NOT
  // reverse twice (idempotency holds for rollbacks too).
  it('is idempotent on a replayed rollback: same tx_id, no double reverse', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = '01111111-1111-4111-8111-011111111111'
    const rbId = '02222222-2222-4222-8222-022222222222'

    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566706',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    const rb1 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566706',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betId }],
      }),
    )
    expect(rb1.status).toBe(200)
    const first = (await rb1.json()) as { transactions: { tx_id: string }[] }
    const originalTxId = first.transactions[0]!.tx_id
    expect(await dbBalance(user, 'USD')).toBe(1000)

    const rb2 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032916227566706',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betId }],
      }),
    )
    expect(rb2.status).toBe(200)
    const second = (await rb2.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Replay: same tx_id, balance not reversed a second time.
    expect(second.balance).toBe(1000)
    expect(second.transactions[0]!.tx_id).toBe(originalTxId)
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
  })

  // P1 — cross-call double rollback after a pre-rollback/noop. Call 1 records a
  // pre-rollback of A; call 2's bet A noops (no debit); call 3 is a SECOND,
  // distinct rollback of the same A. Even though A was never applied (it was
  // pre-rolled then noop'd), A already has a committed rollback, so the second
  // rollback is a double rollback → 400. Balance never moved; only the first
  // rollback row and the noop'd bet row persist.
  it('rejects a second rollback of a pre-rolled, noop\'d original with 400 (double rollback)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'aa100000-1111-4111-8111-aa1000000001'
    const rb1Id = 'aa100000-2222-4222-8222-aa1000000002'
    const rb2Id = 'aa100000-3333-4333-8333-aa1000000003'

    // Call 1: pre-rollback of A (A does not exist yet).
    const rb1 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000001',
        actions: [{ action: 'rollback', action_id: rb1Id, original_action_id: betId }],
      }),
    )
    expect(rb1.status).toBe(200)
    expect(await dbBalance(user, 'USD')).toBe(1000)

    // Call 2: bet A arrives — noop'd by the pre-rollback, no debit.
    const bet = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000001',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    expect(bet.status).toBe(200)
    expect(((await bet.json()) as { balance: number }).balance).toBe(1000)
    expect(await dbTxRolledback(betId)).toBe(true)

    // Call 3: a second, distinct rollback of the already-rolled-back A → 400.
    const rb2 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000001',
        actions: [{ action: 'rollback', action_id: rb2Id, original_action_id: betId }],
      }),
    )
    expect(rb2.status).toBe(400)

    // Unchanged: balance still 1000, only the pre-rollback and the noop'd bet
    // persisted (the rejected second rollback wrote nothing).
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2)
    expect(await dbTxRow(rb2Id)).toBeUndefined()
  })

  // P2 — a pre-rolled WIN starves later funds in the same batch. Call 1 records a
  // pre-rollback of win W. In call 2 the balance is only 50; the batch is
  // [win W, bet 120]. W is noop'd by the pre-rollback so it credits NOTHING, so
  // the bet overdraws (50 - 120 < 0) → code 100, and the WHOLE batch rolls back.
  // (Were W credited, 50 + 200 - 120 = 130 would be fine — proving the win was
  // genuinely noop'd, not applied.)
  it('rolls back the batch with code 100 when a pre-rolled win starves a later bet', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 50 }] })

    const winId = 'bb100000-1111-4111-8111-bb1000000001'
    const rbId = 'bb100000-2222-4222-8222-bb1000000002'
    const betId = 'bb100000-3333-4333-8333-bb1000000003'

    // Call 1: pre-rollback of the win.
    const rb = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000002',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: winId }],
      }),
    )
    expect(rb.status).toBe(200)
    expect(await dbBalance(user, 'USD')).toBe(50)

    // Call 2: the win noops (no credit), so the bet overdraws → code 100.
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000002',
        actions: [
          { action: 'win', action_id: winId, amount: 200 },
          { action: 'bet', action_id: betId, amount: 120 },
        ],
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(((await res.json()) as { code: number }).code).toBe(100)

    // Whole batch rolled back: balance untouched, neither the win nor the bet
    // row persisted — only the pre-rollback from call 1 remains.
    expect(await dbBalance(user, 'USD')).toBe(50)
    expect(await dbTxCount(user)).toBe(1)
    expect(await dbTxRow(winId)).toBeUndefined()
    expect(await dbTxRow(betId)).toBeUndefined()
  })

  // P3 — an idempotent rollback replay mixed with a fresh bet in one batch. Call
  // 1 commits bet A and rolls it back (balance restored). Call 2 re-sends that
  // rollback PLUS a fresh bet: the replayed rollback is skipped (no second
  // reverse, original tx_id returned), and the fresh bet applies exactly once.
  it('replays a rollback and applies a fresh bet in the same batch', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betA = 'cc100000-1111-4111-8111-cc1000000001'
    const rbId = 'cc100000-2222-4222-8222-cc1000000002'
    const betB = 'cc100000-3333-4333-8333-cc1000000003'

    // Call 1: bet A then its rollback — balance back to 1000.
    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000003',
        actions: [{ action: 'bet', action_id: betA, amount: 100 }],
      }),
    )
    const rb1 = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000003',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betA }],
      }),
    )
    expect(rb1.status).toBe(200)
    const originalRbTxId = ((await rb1.json()) as { transactions: { tx_id: string }[] })
      .transactions[0]!.tx_id
    expect(await dbBalance(user, 'USD')).toBe(1000)

    // Call 2: replay the rollback + a fresh bet B (30).
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000003',
        actions: [
          { action: 'rollback', action_id: rbId, original_action_id: betA },
          { action: 'bet', action_id: betB, amount: 30 },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // The replayed rollback keeps its original tx_id (no second reverse); only the
    // fresh bet moved the balance: 1000 - 30.
    expect(payload.balance).toBe(970)
    expect(payload.transactions.map((t) => t.action_id)).toEqual([rbId, betB])
    expect(payload.transactions[0]!.tx_id).toBe(originalRbTxId)
    expect(payload.transactions[1]!.tx_id).toMatch(UUID_RE)

    // Persisted: bet A + rollback + fresh bet B = 3 rows; the fresh bet applied once.
    expect(await dbBalance(user, 'USD')).toBe(970)
    expect(await dbTxCount(user)).toBe(3)
    expect(await dbTxRow(betB)).toEqual({ type: 'bet', amount: 30, originalActionId: null })
  })

  // P4 — a noop'd original and an INDEPENDENT fresh bet in the same batch. Call 1
  // pre-rolls A. Call 2 is [bet A, bet B]: A is noop'd by the pre-rollback (no
  // debit), but the unrelated bet B still applies exactly once.
  it('noops a pre-rolled original yet applies an independent fresh bet in the same batch', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betA = 'dd100000-1111-4111-8111-dd1000000001'
    const rbId = 'dd100000-2222-4222-8222-dd1000000002'
    const betB = 'dd100000-3333-4333-8333-dd1000000003'

    // Call 1: pre-rollback of A.
    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000004',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betA }],
      }),
    )

    // Call 2: A noops, B (a distinct, un-rolled-back bet) applies.
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000004',
        actions: [
          { action: 'bet', action_id: betA, amount: 100 },
          { action: 'bet', action_id: betB, amount: 40 },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    // Only B debited: 1000 - 40.
    expect(payload.balance).toBe(960)
    expect(payload.transactions.map((t) => t.action_id)).toEqual([betA, betB])

    // Persisted: A noop'd (rolledback=true), B applied once (rolledback=false).
    expect(await dbBalance(user, 'USD')).toBe(960)
    expect(await dbTxCount(user)).toBe(3) // rollback + bet A (noop) + bet B
    expect(await dbTxRolledback(betA)).toBe(true)
    expect(await dbTxRolledback(betB)).toBe(false)
    expect(await dbTxRow(betB)).toEqual({ type: 'bet', amount: 40, originalActionId: null })
  })

  // P5 — one batch that is BOTH a rollback-of-a-rollback AND a double rollback:
  // [rollback R1→A, rollback R2→A, rollback R3→R1]. R2 targets the same original
  // A as R1 (double rollback) and R3 targets a rollback action (rollback-of-a-
  // rollback). Either alone is a 400; together the whole batch is rejected and
  // nothing persists.
  it('rejects a batch that is both a double rollback and a rollback-of-a-rollback with 400', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const aId = 'ee100000-1111-4111-8111-ee1000000001'
    const r1Id = 'ee100000-2222-4222-8222-ee1000000002'
    const r2Id = 'ee100000-3333-4333-8333-ee1000000003'
    const r3Id = 'ee100000-4444-4444-8444-ee1000000004'

    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000005',
        actions: [
          { action: 'rollback', action_id: r1Id, original_action_id: aId },
          { action: 'rollback', action_id: r2Id, original_action_id: aId },
          { action: 'rollback', action_id: r3Id, original_action_id: r1Id },
        ],
      }),
    )
    expect(res.status).toBe(400)

    // Whole batch rejected: nothing persisted, balance untouched.
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(0)
  })

  // P6 — replaying an APPLIED-then-ROLLED-BACK bet is an idempotent REPLAY, not a
  // noop. Call 1 commits bet A (debits). Call 2 rolls A back (credits). Call 3
  // re-sends bet A: because A already has a committed ledger row, it is a replay —
  // it returns A's ORIGINAL tx_id and does NOT touch the balance again. (A noop
  // would mint a fresh tx_id for A; a replay reuses the original one.)
  it('replays an applied-then-rolled-back bet idempotently (original tx_id, no balance change)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betA = 'ff100000-1111-4111-8111-ff1000000001'
    const rbId = 'ff100000-2222-4222-8222-ff1000000002'

    // Call 1: bet A debits 100 → 900, capture its tx_id.
    const bet = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000006',
        actions: [{ action: 'bet', action_id: betA, amount: 100 }],
      }),
    )
    expect(bet.status).toBe(200)
    const originalBetTxId = ((await bet.json()) as { transactions: { tx_id: string }[] })
      .transactions[0]!.tx_id
    expect(await dbBalance(user, 'USD')).toBe(900)

    // Call 2: rollback A credits 100 back → 1000.
    const rb = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000006',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betA }],
      }),
    )
    expect(rb.status).toBe(200)
    expect(await dbBalance(user, 'USD')).toBe(1000)

    // Call 3: re-send bet A — idempotent replay, original tx_id, no balance change.
    const replay = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032918000000006',
        actions: [{ action: 'bet', action_id: betA, amount: 100 }],
      }),
    )
    expect(replay.status).toBe(200)
    const payload = (await replay.json()) as {
      balance: number
      transactions: { action_id: string; tx_id: string }[]
    }
    expect(payload.balance).toBe(1000)
    expect(payload.transactions[0]!.action_id).toBe(betA)
    // Replay reuses the ORIGINAL bet tx_id (a noop would mint a fresh one).
    expect(payload.transactions[0]!.tx_id).toBe(originalBetTxId)

    // Persisted: no new row, balance still 1000; A's row keeps its committed shape.
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(2) // bet A + rollback
    expect(await dbTxRow(betA)).toEqual({ type: 'bet', amount: 100, originalActionId: null })
  })

  // Controller: a rollback missing `original_action_id` is a bad request (400).
  it('rejects a rollback with no original_action_id with 400', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const raw = JSON.stringify({
      user_id: user,
      currency: 'USD',
      game: 'acceptance:test',
      game_id: '1761032916227566707',
      actions: [{ action: 'rollback', action_id: '0a111111-1111-4111-8111-0a1111111111' }],
    })
    const res = await postSigned(raw)
    expect(res.status).toBe(400)
  })
})

describe('POST /aggregator/takehome/process (rolledback denormalization)', () => {
  // (a) A rollback of an original committed in a PRIOR call flips that original's
  // `rolledback` flag to true (via the batched UPDATE), while the rollback row
  // itself stays rolledback=false with amount=0.
  it('flips rolledback=true on a prior-call original when its rollback arrives', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'a0000000-1111-4111-8111-a00000000001'
    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000001',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    // Before the rollback the original is not reversed.
    expect(await dbTxRolledback(betId)).toBe(false)

    const rbId = 'a0000000-2222-4222-8222-a00000000002'
    const rbRes = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000001',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betId }],
      }),
    )
    expect(rbRes.status).toBe(200)

    // Original now flagged reversed; rollback row stays unflagged with amount 0.
    expect(await dbTxRolledback(betId)).toBe(true)
    expect(await dbTxRolledback(rbId)).toBe(false)
    expect(await dbTxRow(rbId)).toEqual({ type: 'rollback', amount: 0, originalActionId: betId })
  })

  // (b1) Same-batch [bet A, rollback A]: A is cancelled by a rollback later in the
  // same batch, so it is noop'd (never applied) and its row lands rolledback=true.
  it('flips rolledback=true on a same-batch bet cancelled by a later rollback ([bet, rollback])', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'b0000000-1111-4111-8111-b00000000001'
    const rbId = 'b0000000-2222-4222-8222-b00000000002'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000002',
        actions: [
          { action: 'bet', action_id: betId, amount: 100 },
          { action: 'rollback', action_id: rbId, original_action_id: betId },
        ],
      }),
    )
    expect(res.status).toBe(200)

    expect(await dbTxRolledback(betId)).toBe(true)
    expect(await dbTxRolledback(rbId)).toBe(false)
    expect(await dbTxRow(rbId)).toEqual({ type: 'rollback', amount: 0, originalActionId: betId })
  })

  // (b2) Same-batch [rollback A, bet A] (pre-rollback/noop path): the rollback is
  // recorded first, then the later original noops — and the noop'd original row
  // must still land with rolledback=true.
  it("flips rolledback=true on a same-batch noop'd original ([rollback, bet])", async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'c0000000-1111-4111-8111-c00000000001'
    const rbId = 'c0000000-2222-4222-8222-c00000000002'
    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000003',
        actions: [
          { action: 'rollback', action_id: rbId, original_action_id: betId },
          { action: 'bet', action_id: betId, amount: 100 },
        ],
      }),
    )
    expect(res.status).toBe(200)

    expect(await dbTxRolledback(betId)).toBe(true)
    expect(await dbTxRolledback(rbId)).toBe(false)
  })

  // (b3) Pre-rollback across calls: rollback recorded in call 1, original arrives
  // (noop'd) in call 2 — the noop'd original row still lands rolledback=true.
  it("flips rolledback=true on a noop'd original arriving in a later call", async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const betId = 'd0000000-1111-4111-8111-d00000000001'
    const rbId = 'd0000000-2222-4222-8222-d00000000002'
    await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000004',
        actions: [{ action: 'rollback', action_id: rbId, original_action_id: betId }],
      }),
    )
    const betRes = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000004',
        actions: [{ action: 'bet', action_id: betId, amount: 100 }],
      }),
    )
    expect(betRes.status).toBe(200)

    expect(await dbTxRolledback(betId)).toBe(true)
    expect(await dbTxRolledback(rbId)).toBe(false)
  })

  // (e) A non-UUID action_id is rejected with a clean 4xx (validateAction's UUID
  // check), never a raw Postgres 500 from the uuid column rejecting the insert.
  it('rejects a non-UUID action_id with a 4xx (not 500)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000005',
        actions: [{ action: 'bet', action_id: 'not-a-uuid', amount: 100 }],
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    // Nothing applied.
    expect(await dbBalance(user, 'USD')).toBe(1000)
    expect(await dbTxCount(user)).toBe(0)
  })

  // (e') A non-UUID original_action_id on a rollback is likewise a clean 4xx.
  it('rejects a non-UUID original_action_id with a 4xx (not 500)', async () => {
    const user = '8|USDT|USD'
    await setup({ wallets: [{ userId: user, currency: 'USD', balance: 1000 }] })

    const res = await postSigned(
      JSON.stringify({
        user_id: user,
        currency: 'USD',
        game: 'acceptance:test',
        game_id: '1761032917000000006',
        actions: [
          {
            action: 'rollback',
            action_id: 'e0000000-2222-4222-8222-e00000000002',
            original_action_id: 'nope',
          },
        ],
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
