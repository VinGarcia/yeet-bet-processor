import type { Kysely } from 'kysely'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'

/**
 * Currencies the seeder is allowed to mint. Kept to a small, explicit set so a
 * typo on the CLI fails loudly instead of silently creating junk wallets.
 */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'BRL', 'GBP'] as const
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

export interface SeedOptions {
  /** How many wallet rows to create. */
  count: number
  /** Currency for every minted wallet. */
  currency: SupportedCurrency
  /** Lower bound (inclusive) of the initial balance, in integer minor units. */
  balanceMin: number
  /** Upper bound (inclusive) of the initial balance, in integer minor units. */
  balanceMax: number
  /** Fixed seed for the PRNG so repeated runs produce identical balances. */
  prngSeed: number
  /** Prefix for generated, deterministic user ids (`<prefix><index>`). */
  userPrefix: string
  /** Rows per bulk INSERT. Keeps statements bounded while seeding at scale. */
  chunkSize: number
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  count: 1000,
  currency: 'USD',
  balanceMin: 10_000,
  balanceMax: 1_000_000,
  prngSeed: 1,
  userPrefix: 'seed-user-',
  chunkSize: 1000,
}

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG. Given the same
 * 32-bit seed it always yields the same sequence, which is exactly what makes
 * the seeded data reproducible across machines and runs.
 */
function mulberry32(seed: number): number {
  let a = seed | 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Deterministic, stable user id for a given 1-based row index. */
export function userIdFor(index: number, opts: SeedOptions): string {
  return `${opts.userPrefix}${index}`
}

/**
 * Deterministic initial balance for a given 1-based row index. When the range
 * collapses to a single value the balance is fixed; otherwise it is drawn from
 * a per-index PRNG so the data is varied yet perfectly reproducible.
 */
export function balanceFor(index: number, opts: SeedOptions): number {
  if (opts.balanceMax <= opts.balanceMin) {
    return opts.balanceMin
  }
  const span = opts.balanceMax - opts.balanceMin + 1
  const r = mulberry32(opts.prngSeed + index)
  return opts.balanceMin + Math.floor(r * span)
}

export interface SeedResult {
  /** Wallet rows the run attempted to write (= `count`). */
  requested: number
}

/**
 * Bulk-creates `count` wallet rows with deterministic ids and balances.
 *
 * Balances are funded by DIRECT wallet inserts, never by emitting `win`
 * actions: a win is real game revenue and would inflate RTP (return-to-player)
 * metrics. Seed money is bootstrap liquidity, not winnings, so it must bypass
 * the transaction ledger entirely.
 *
 * Idempotent: ON CONFLICT (user_id, currency) DO NOTHING means re-running is a
 * no-op for already-seeded wallets — no errors, no duplicates, same final state.
 */
export async function seedWallets(db: Kysely<DB>, options: SeedOptions): Promise<SeedResult> {
  for (let start = 1; start <= options.count; start += options.chunkSize) {
    const end = Math.min(start + options.chunkSize - 1, options.count)
    const rows = []
    for (let index = start; index <= end; index++) {
      rows.push({
        user_id: userIdFor(index, options),
        currency: options.currency,
        balance: balanceFor(index, options),
      })
    }
    await db
      .insertInto('wallets')
      .values(rows)
      .onConflict((oc) => oc.columns(['user_id', 'currency']).doNothing())
      .execute()
  }

  return { requested: options.count }
}
