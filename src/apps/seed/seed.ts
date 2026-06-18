import type { Kysely } from 'kysely'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'

// Explicit allowlist so a CLI typo fails loudly instead of minting junk wallets.
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'BRL', 'GBP'] as const
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

export interface SeedOptions {
  count: number
  currency: SupportedCurrency
  /** Inclusive initial-balance bounds, in integer minor units. */
  balanceMin: number
  balanceMax: number
  /** Fixed PRNG seed so repeated runs produce identical balances. */
  prngSeed: number
  /** Prefix for deterministic user ids (`<prefix><index>`). */
  userPrefix: string
  /** Rows per bulk INSERT; bounds statement size when seeding at scale. */
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

// mulberry32: deterministic 32-bit PRNG; same seed → same sequence → reproducible data.
function mulberry32(seed: number): number {
  let a = seed | 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function userIdFor(index: number, opts: SeedOptions): string {
  return `${opts.userPrefix}${index}`
}

// Deterministic balance per 1-based index: fixed when the range collapses, else
// drawn from a per-index PRNG (varied yet reproducible).
export function balanceFor(index: number, opts: SeedOptions): number {
  if (opts.balanceMax <= opts.balanceMin) {
    return opts.balanceMin
  }
  const span = opts.balanceMax - opts.balanceMin + 1
  const r = mulberry32(opts.prngSeed + index)
  return opts.balanceMin + Math.floor(r * span)
}

export interface SeedResult {
  requested: number
}

/**
 * Bulk-creates `count` wallet rows with deterministic ids and balances.
 *
 * Funds via DIRECT wallet inserts, never `win` actions: seed money is bootstrap
 * liquidity, not winnings, so it must bypass the ledger to avoid inflating RTP.
 * Idempotent via ON CONFLICT DO NOTHING, so re-running is a no-op.
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
