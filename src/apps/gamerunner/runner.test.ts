import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, TEST_SECRET } from '../api/create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import { seedWallets } from '../seed/seed.js'
import { SignedClient } from './client.js'
import { mulberry32 } from './rng.js'
import { runSimulation } from './runner.js'
import { drawBetAmount, generateRound, TARGET_RTP } from './simulation.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>

beforeAll(async () => {
  ctx = await createTestApp()
}, 60_000)

afterAll(() => ctx.close())

beforeEach(() => resetTestDB(ctx.db))

describe('runSimulation (deterministic RTP convergence)', () => {
  it('converges to ~95% global RTP over a real run and reports a clean pass', async () => {
    const users = 20
    const roundsPerUser = 400
    const currency = 'USD' as const
    const userPrefix = 'gr-test-'

    await seedWallets(ctx.db, {
      count: users,
      currency,
      // Large fixed balance so no cold streak trips the non-negative guard.
      balanceMin: 50_000_000,
      balanceMax: 50_000_000,
      prngSeed: 1,
      userPrefix,
      chunkSize: 1000,
    })

    const client = new SignedClient(ctx.baseURL, TEST_SECRET)
    const result = await runSimulation(client, mulberry32(42), {
      users,
      roundsPerUser,
      currency,
      betRange: { min: 10, max: 100 },
      userPrefix,
      tolerance: 0.02,
    })

    expect(result.rounds).toBe(users * roundsPerUser)
    expect(result.totalBet).toBeGreaterThan(0)
    // The headline assertion: the OBSERVED RTP lands near the 95% target.
    expect(result.observedRtp).toBeGreaterThan(TARGET_RTP - 0.02)
    expect(result.observedRtp).toBeLessThan(TARGET_RTP + 0.02)
    expect(result.pass).toBe(true)
    // Per-user RTPs must show real spread (variance), not a constant 0.95.
    expect(result.perUserRtp.count).toBe(users)
    expect(result.perUserRtp.max - result.perUserRtp.min).toBeGreaterThan(0.05)
  }, 120_000)

  it('is deterministic: the same seed reproduces the same observed totals', async () => {
    const opts = {
      users: 5,
      roundsPerUser: 50,
      currency: 'USD' as const,
      betRange: { min: 10, max: 100 },
      userPrefix: 'gr-det-',
      tolerance: 1,
    }
    const seedWalletsForRun = async (): Promise<void> => {
      await resetTestDB(ctx.db)
      await seedWallets(ctx.db, {
        count: opts.users,
        currency: opts.currency,
        balanceMin: 50_000_000,
        balanceMax: 50_000_000,
        prngSeed: 1,
        userPrefix: opts.userPrefix,
        chunkSize: 1000,
      })
    }
    const client = new SignedClient(ctx.baseURL, TEST_SECRET)

    await seedWalletsForRun()
    const first = await runSimulation(client, mulberry32(7), opts)
    await seedWalletsForRun()
    const second = await runSimulation(client, mulberry32(7), opts)

    expect(second.totalBet).toBe(first.totalBet)
    expect(second.totalWin).toBe(first.totalWin)
    expect(second.observedRtp).toBe(first.observedRtp)
  }, 120_000)
})

describe('generateRound (distribution shape)', () => {
  it('has expected per-round payout ≈ TARGET_RTP × bet over many draws', () => {
    const rng = mulberry32(123)
    const bet = 100
    const n = 200_000
    let totalBet = 0
    let totalWin = 0
    for (let i = 0; i < n; i++) {
      const round = generateRound(rng, bet)
      totalBet += round.bet.amount
      totalWin += round.win?.amount ?? 0
    }
    expect(totalWin / totalBet).toBeGreaterThan(TARGET_RTP - 0.01)
    expect(totalWin / totalBet).toBeLessThan(TARGET_RTP + 0.01)
  })

  it('drawBetAmount stays within the inclusive range', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 10_000; i++) {
      const amount = drawBetAmount(rng, { min: 10, max: 20 })
      expect(amount).toBeGreaterThanOrEqual(10)
      expect(amount).toBeLessThanOrEqual(20)
    }
  })
})
