/**
 * Tiny shared CLI-config helpers for the runnable apps (`seed`, `gamerunner`).
 *
 * Every app resolves config the same way — `--flag=value` args layered over env
 * vars layered over defaults — so the parsing lives here once rather than being
 * copied per entrypoint.
 */

/** Reads `--flag=value` style CLI args into a lookup map. */
export function parseFlags(argv: string[]): Map<string, string> {
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
export function pick(flags: Map<string, string>, flag: string, env: string): string | undefined {
  return flags.get(flag) ?? process.env[env]
}

/** Parses an integer config value, throwing a labelled error on non-integers. */
export function toInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer, got: ${value}`)
  return parsed
}

/** Parses a finite float config value, throwing a labelled error otherwise. */
export function toFloat(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number, got: ${value}`)
  return parsed
}

/** Returns a required env var, throwing if it is unset or empty. */
export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
