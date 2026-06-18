/**
 * A seedable random source: a zero-arg function returning a float in `[0, 1)`,
 * the same tiny injected-function convention the seeder uses (`mulberry32`).
 * The game runner depends on this type — never on `Math.random` directly — so a
 * run is fully deterministic for a given seed, which the take-home calls out as
 * an explicit evaluation criterion ("deterministic seeds").
 */
export type Rng = () => number

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG factory. Given the
 * same 32-bit seed it returns a generator that always yields the same sequence
 * of floats in `[0, 1)`. Shared shape with the seeder's PRNG; here it is a
 * stateful generator (closure) rather than a pure index→value function because
 * the simulation draws an unbounded stream rather than one value per index.
 */
export function mulberry32(seed: number): Rng {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Draws a RFC-4122-shaped v4 UUID from the injected {@link Rng}. The endpoint's
 * `action_id`/`original_action_id` are Postgres `uuid` columns (validated by
 * `validateAction`), so the runner must emit well-formed UUIDs — and they must
 * come from the seeded RNG, not `crypto.randomUUID()`, for a run to stay
 * reproducible. The version (`4`) and variant (`8..b`) nibbles are fixed; the
 * remaining 122 bits are filled from the RNG.
 */
export function uuidFrom(rng: Rng): string {
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-'
    } else if (i === 14) {
      out += '4'
    } else if (i === 19) {
      out += hex[(Math.floor(rng() * 16) & 0x3) | 0x8]
    } else {
      out += hex[Math.floor(rng() * 16)]
    }
  }
  return out
}
