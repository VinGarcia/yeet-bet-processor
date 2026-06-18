import { config as loadEnv } from 'dotenv'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import { parseFlags, pick, toInt, toFloat, required } from '../../helpers/cli/flags.js'
import { seedWallets, type SupportedCurrency, SUPPORTED_CURRENCIES } from '../seed/seed.js'
import { SignedClient } from './client.js'
import { mulberry32 } from './rng.js'
import { runSimulation, type RunOptions } from './runner.js'
import { TARGET_RTP } from './simulation.js'

loadEnv({ path: 'config.env' })

interface ResolvedConfig extends RunOptions {
  /** The validated currency, kept narrow so the seeder accepts it directly. */
  currency: SupportedCurrency
  seed: number
  balance: number
  baseURL: string
  hmacSecret: string
}

function resolveConfig(argv: string[]): ResolvedConfig {
  const flags = parseFlags(argv)

  const currency = (pick(flags, 'currency', 'GR_CURRENCY') ?? 'USD') as SupportedCurrency
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(
      `unsupported currency "${currency}"; expected one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    )
  }

  const betMin = toInt(pick(flags, 'bet-min', 'GR_BET_MIN'), 10, 'bet-min')
  const betMax = toInt(pick(flags, 'bet-max', 'GR_BET_MAX'), 100, 'bet-max')
  if (betMin <= 0 || betMax < betMin) {
    throw new Error(`invalid bet range: min=${betMin} max=${betMax}`)
  }

  return {
    users: toInt(pick(flags, 'users', 'GR_USERS'), 50, 'users'),
    roundsPerUser: toInt(pick(flags, 'rounds', 'GR_ROUNDS'), 200, 'rounds'),
    currency,
    betRange: { min: betMin, max: betMax },
    userPrefix: pick(flags, 'prefix', 'GR_PREFIX') ?? 'gr-user-',
    tolerance: toFloat(pick(flags, 'tolerance', 'GR_TOLERANCE'), 0.01, 'tolerance'),
    seed: toInt(pick(flags, 'seed', 'GR_SEED'), 1, 'seed'),
    // A balance large enough that an unlucky early streak cannot bankrupt a user
    // before the run completes; sized off the worst-case bet and round count.
    balance: toInt(pick(flags, 'balance', 'GR_BALANCE'), 0, 'balance'),
    baseURL: pick(flags, 'url', 'GR_BASE_URL') ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
    hmacSecret: required('HMAC_SECRET'),
  }
}

async function main(): Promise<void> {
  const cfg = resolveConfig(process.argv.slice(2))

  // Default starting balance: cover every round at the max bet plus headroom, so
  // a cold streak never trips the non-negative-balance guard mid-run.
  const balance = cfg.balance > 0 ? cfg.balance : cfg.roundsPerUser * cfg.betRange.max * 3

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

  const client = new SignedClient(cfg.baseURL, cfg.hmacSecret)
  const rng = mulberry32(cfg.seed)

  console.log(
    `running ${cfg.users} users × ${cfg.roundsPerUser} rounds = ` +
      `${cfg.users * cfg.roundsPerUser} rounds (seed=${cfg.seed}, target RTP=${TARGET_RTP})`,
  )

  const result = await runSimulation(client, rng, cfg)

  console.log('')
  console.log(`rounds submitted : ${result.rounds}`)
  console.log(`total bet        : ${result.totalBet}`)
  console.log(`total win        : ${result.totalWin}`)
  console.log(`observed RTP     : ${result.observedRtp.toFixed(4)} (target ${TARGET_RTP})`)
  console.log(
    `per-user RTP     : ${result.perUserRtp.count} users, ` +
      `min ${result.perUserRtp.min.toFixed(3)}, max ${result.perUserRtp.max.toFixed(3)}`,
  )
  console.log(`tolerance        : ±${cfg.tolerance}`)
  console.log('')
  console.log(
    result.pass ? 'PASS: global RTP within tolerance' : 'FAIL: global RTP outside tolerance',
  )

  process.exit(result.pass ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
