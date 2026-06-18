import { config as loadEnv } from 'dotenv'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import {
  seedWallets,
  DEFAULT_SEED_OPTIONS,
  SUPPORTED_CURRENCIES,
  type SeedOptions,
  type SupportedCurrency,
} from './seed.js'

loadEnv({ path: 'config.env' })

/** Reads `--flag=value` style CLI args into a lookup map. */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      flags.set(match[1], match[2])
    }
  }
  return flags
}

/** CLI flag wins over env var wins over default. */
function pick(flags: Map<string, string>, flag: string, env: string): string | undefined {
  return flags.get(flag) ?? process.env[env]
}

function toInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer, got: ${value}`)
  }
  return parsed
}

function resolveOptions(argv: string[]): SeedOptions {
  const flags = parseFlags(argv)

  const currency = (pick(flags, 'currency', 'SEED_CURRENCY') ??
    DEFAULT_SEED_OPTIONS.currency) as SupportedCurrency
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(
      `unsupported currency "${currency}"; expected one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    )
  }

  // `--balance` fixes both bounds to one value; `--min`/`--max` define a range.
  const fixed = pick(flags, 'balance', 'SEED_BALANCE')
  const balanceMin = toInt(
    fixed ?? pick(flags, 'min', 'SEED_MIN'),
    DEFAULT_SEED_OPTIONS.balanceMin,
    'balance min',
  )
  const balanceMax = toInt(
    fixed ?? pick(flags, 'max', 'SEED_MAX'),
    DEFAULT_SEED_OPTIONS.balanceMax,
    'balance max',
  )
  if (balanceMin < 0 || balanceMax < balanceMin) {
    throw new Error(`invalid balance range: min=${balanceMin} max=${balanceMax}`)
  }

  return {
    count: toInt(pick(flags, 'count', 'SEED_COUNT'), DEFAULT_SEED_OPTIONS.count, 'count'),
    currency,
    balanceMin,
    balanceMax,
    prngSeed: toInt(pick(flags, 'seed', 'SEED_SEED'), DEFAULT_SEED_OPTIONS.prngSeed, 'seed'),
    userPrefix: pick(flags, 'prefix', 'SEED_PREFIX') ?? DEFAULT_SEED_OPTIONS.userPrefix,
    chunkSize: toInt(pick(flags, 'chunk', 'SEED_CHUNK'), DEFAULT_SEED_OPTIONS.chunkSize, 'chunk'),
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2))
  const db = createDb(required('DATABASE_URL'))
  try {
    await migrate(db)
    const start = process.hrtime.bigint()
    const { requested } = await seedWallets(db, options)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    console.log(
      `seeded ${requested} ${options.currency} wallets ` +
        `(balance ${options.balanceMin}..${options.balanceMax}, seed=${options.prngSeed}) ` +
        `in ${ms.toFixed(0)}ms`,
    )
  } finally {
    await db.destroy()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
