import { config as loadEnv } from 'dotenv'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import { parseFlags, pick, toInt, required } from '../../helpers/cli/flags.js'
import { seedWallets, type SupportedCurrency, SUPPORTED_CURRENCIES } from '../seed/seed.js'
import { mulberry32, uuidFrom } from '../gamerunner/rng.js'
import { makeBetBody } from './request.js'
import { runLoad, summarize, formatSummary } from './load.js'

loadEnv()

interface BenchConfig {
  users: number
  currency: SupportedCurrency
  concurrency: number
  totalRequests: number
  betAmount: number
  seed: number
  userPrefix: string
  baseURL: string
  hmacSecret: string
}

function resolveConfig(argv: string[]): BenchConfig {
  const flags = parseFlags(argv)

  const currency = (pick(flags, 'currency', 'BENCH_CURRENCY') ?? 'USD') as SupportedCurrency
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(
      `unsupported currency "${currency}"; expected one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    )
  }

  const concurrency = toInt(pick(flags, 'concurrency', 'BENCH_CONCURRENCY'), 50, 'concurrency')
  const totalRequests = toInt(pick(flags, 'requests', 'BENCH_REQUESTS'), 10_000, 'requests')
  const users = toInt(pick(flags, 'users', 'BENCH_USERS'), 1000, 'users')
  if (concurrency <= 0) throw new Error(`concurrency must be > 0, got ${concurrency}`)
  if (totalRequests <= 0) throw new Error(`requests must be > 0, got ${totalRequests}`)
  if (users <= 0) throw new Error(`users must be > 0, got ${users}`)

  return {
    users,
    currency,
    concurrency,
    totalRequests,
    betAmount: toInt(pick(flags, 'bet', 'BENCH_BET'), 10, 'bet'),
    seed: toInt(pick(flags, 'seed', 'BENCH_SEED'), 1, 'seed'),
    userPrefix: pick(flags, 'prefix', 'BENCH_PREFIX') ?? 'bench-user-',
    baseURL:
      pick(flags, 'url', 'BENCH_BASE_URL') ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
    hmacSecret: required('HMAC_SECRET'),
  }
}

async function main(): Promise<void> {
  const cfg = resolveConfig(process.argv.slice(2))

  // Worst-case headroom (all requests hit one user) so the funds guard never
  // trips: bet-only load, no wins to refund.
  const balance = cfg.totalRequests * cfg.betAmount + 1

  const db = createDb(required('DATABASE_URL'))
  try {
    await migrate(db)
    await seedWallets(db, {
      count: cfg.users,
      currency: cfg.currency,
      balanceMin: balance,
      balanceMax: balance,
      prngSeed: cfg.seed,
      userPrefix: cfg.userPrefix,
      chunkSize: 1000,
    })
  } finally {
    await db.destroy()
  }

  console.log(
    `benchmarking POST /aggregator/takehome/process\n` +
      `  users=${cfg.users} concurrency=${cfg.concurrency} ` +
      `requests=${cfg.totalRequests} bet=${cfg.betAmount} ${cfg.currency}`,
  )

  // One signed bet per request, round-robin across users with fresh UUIDs (from
  // the seeded RNG): no idempotency collisions, even load, reproducible per seed.
  const rng = mulberry32(cfg.seed)
  const result = await runLoad({
    url: `${cfg.baseURL}/aggregator/takehome/process`,
    secret: cfg.hmacSecret,
    concurrency: cfg.concurrency,
    totalRequests: cfg.totalRequests,
    makeBody: (i) =>
      makeBetBody({
        userId: `${cfg.userPrefix}${(i % cfg.users) + 1}`,
        currency: cfg.currency,
        amount: cfg.betAmount,
        actionId: uuidFrom(rng),
        gameId: uuidFrom(rng),
      }),
  })

  console.log(formatSummary(summarize(result)))
  process.exit(result.errors > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
