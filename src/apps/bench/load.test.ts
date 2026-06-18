import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from '../api/create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import { seedWallets } from '../seed/seed.js'
import { mulberry32, uuidFrom } from '../gamerunner/rng.js'
import { makeBetBody } from './request.js'
import { runLoad, summarize, percentile, formatSummary } from './load.js'

describe('percentile (nearest-rank)', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 0.5)).toBe(0)
  })

  it('picks the nearest-rank value for known percentiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 0.5)).toBe(5)
    expect(percentile(sorted, 0.95)).toBe(10)
    expect(percentile(sorted, 0.99)).toBe(10)
    expect(percentile(sorted, 1)).toBe(10)
  })
})

describe('summarize', () => {
  it('computes throughput and orders percentiles', () => {
    const s = summarize({ ok: 4, errors: 0, latenciesMs: [10, 20, 30, 40], wallMs: 1000 })
    expect(s.totalRequests).toBe(4)
    expect(s.throughput).toBeCloseTo(4, 5) // 4 requests / 1s
    expect(s.latency.p50).toBeLessThanOrEqual(s.latency.p95)
    expect(s.latency.p95).toBeLessThanOrEqual(s.latency.p99)
    expect(s.latency.p99).toBeLessThanOrEqual(s.latency.max)
  })

  it('counts errors and never divides by zero on an empty run', () => {
    const s = summarize({ ok: 0, errors: 0, latenciesMs: [], wallMs: 0 })
    expect(s.throughput).toBe(0)
    expect(s.latency.max).toBe(0)
  })
})

describe('runLoad (with a fake transport)', () => {
  it('drives exactly totalRequests and signs each raw body', async () => {
    let calls = 0
    const seen: string[] = []
    const result = await runLoad(
      {
        url: 'http://x/process',
        secret: 'test',
        concurrency: 8,
        totalRequests: 100,
        makeBody: (i) => ({ i }),
      },
      (_url, init) => {
        calls++
        expect(init.headers.authorization).toMatch(/^HMAC-SHA256 [0-9a-f]{64}$/)
        seen.push(init.body)
        return Promise.resolve({ ok: true })
      },
    )
    expect(calls).toBe(100)
    expect(result.ok).toBe(100)
    expect(result.errors).toBe(0)
    expect(result.latenciesMs).toHaveLength(100)
    expect(new Set(seen).size).toBe(100) // each request body is distinct
  })

  it('counts non-ok responses and thrown transport errors as errors', async () => {
    // index → outcome: 'ok' | 'not-ok' | 'throw'. Two of each non-ok kind.
    const outcomes: Array<'ok' | 'not-ok' | 'throw'> = [
      'ok',
      'not-ok',
      'throw',
      'ok',
      'not-ok',
      'throw',
    ]
    const result = await runLoad(
      {
        url: 'http://x/process',
        secret: 'test',
        concurrency: 4,
        totalRequests: outcomes.length,
        makeBody: (i) => ({ i }),
      },
      (_url, init) => {
        const { i } = JSON.parse(init.body) as { i: number }
        const outcome = outcomes[i]
        if (outcome === 'throw') throw new Error('boom')
        return Promise.resolve({ ok: outcome === 'ok' })
      },
    )
    expect(result.ok).toBe(2) // 2 'ok'
    expect(result.errors).toBe(4) // 2 'not-ok' + 2 'throw'
  })
})

describe('benchmark harness against the live app (smoke)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>

  beforeAll(async () => {
    ctx = await createTestApp()
  }, 60_000)

  afterAll(() => ctx.close())

  beforeEach(() => resetTestDB(ctx.db))

  it('runs real signed load and emits percentile metrics', async () => {
    const users = 10
    const currency = 'USD' as const
    const prefix = 'bench-test-'
    await seedWallets(ctx.db, {
      count: users,
      currency,
      balanceMin: 10_000_000,
      balanceMax: 10_000_000,
      prngSeed: 1,
      userPrefix: prefix,
      chunkSize: 1000,
    })

    const rng = mulberry32(7)
    const totalRequests = 50
    const result = await runLoad({
      url: `${ctx.baseURL}/aggregator/takehome/process`,
      secret: TEST_SECRET,
      concurrency: 8,
      totalRequests,
      makeBody: (i) =>
        makeBetBody({
          userId: `${prefix}${(i % users) + 1}`,
          currency,
          amount: 10,
          actionId: uuidFrom(rng),
          gameId: uuidFrom(rng),
        }),
    })

    const summary = summarize(result)
    expect(summary.totalRequests).toBe(totalRequests)
    expect(summary.ok).toBe(totalRequests) // all signed bets accepted
    expect(summary.errors).toBe(0)
    expect(summary.throughput).toBeGreaterThan(0)
    expect(summary.latency.p50).toBeGreaterThan(0)
    expect(summary.latency.p99).toBeGreaterThanOrEqual(summary.latency.p50)
    expect(formatSummary(summary)).toContain('throughput')
  }, 60_000)
})
