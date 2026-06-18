// Injected random source (float in [0,1)); the runner never touches Math.random,
// so a run is fully deterministic for a given seed.
export type Rng = () => number

// mulberry32: tiny deterministic 32-bit PRNG. Stateful closure (vs the seeder's
// pure index→value form) because the simulation draws an unbounded stream.
export function mulberry32(seed: number): Rng {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// RFC-4122 v4 UUID drawn from the seeded {@link Rng} (not crypto.randomUUID) so
// the ids stay reproducible; action_id columns are Postgres `uuid`.
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
