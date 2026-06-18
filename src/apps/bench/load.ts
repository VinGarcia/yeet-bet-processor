import { signedJsonRequest } from '../../helpers/crypto/hmac.js'

/**
 * A closed-loop concurrent load generator for the signed `/process` endpoint.
 *
 * `concurrency` worker loops run in parallel; each one pulls the next request
 * index off a shared counter, signs the body via the shared `signedJsonRequest`
 * (same HMAC framing the gamerunner client uses), POSTs it, and records the
 * wall-clock latency. Workers stop as soon as the shared counter reaches
 * `totalRequests`, so the run drives exactly that many requests regardless of
 * how the work splits across workers (closed-loop, not open-loop: a fixed pool
 * of in-flight requests, the standard way to bound a benchmark's concurrency
 * without an unbounded request queue).
 */

/** Builds the signed POST body for request number `i` (0-based). */
export type RequestFactory = (i: number) => unknown

export interface LoadOptions {
  /** Endpoint the benchmark hammers. */
  url: string
  /** HMAC secret used to sign every raw body. */
  secret: string
  /** Number of worker loops kept in flight at once. */
  concurrency: number
  /** Total requests to send across all workers. */
  totalRequests: number
  /** Produces the body for the i-th request. */
  makeBody: RequestFactory
}

export interface LoadResult {
  /** Requests that returned a 2xx response. */
  ok: number
  /** Requests that errored (non-2xx or transport failure). */
  errors: number
  /** Per-request latencies in milliseconds, in completion order. */
  latenciesMs: number[]
  /** Total wall-clock time of the run, in milliseconds. */
  wallMs: number
}

/** A minimal `fetch` shape so a test can inject a fake transport. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>

/**
 * Runs the closed-loop load test and returns raw timings. Computing the
 * percentile summary is left to {@link summarize} so the engine stays a pure
 * "generate load, collect samples" unit that a test can drive deterministically.
 */
export async function runLoad(
  opts: LoadOptions,
  fetchImpl: FetchLike = fetch,
): Promise<LoadResult> {
  const latenciesMs: number[] = []
  let ok = 0
  let errors = 0
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      // Claim-then-check must stay synchronous (no `await` between `next++` and
      // the bounds guard) so concurrent workers never double-claim or overrun.
      const i = next++
      if (i >= opts.totalRequests) return

      const { init } = signedJsonRequest(opts.secret, opts.makeBody(i))
      const started = performance.now()
      try {
        const res = await fetchImpl(opts.url, init)
        if (res.ok) ok++
        else errors++
      } catch {
        errors++
      }
      latenciesMs.push(performance.now() - started)
    }
  }

  const workerCount = Math.max(1, Math.min(opts.concurrency, opts.totalRequests))
  const wallStart = performance.now()
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  const wallMs = performance.now() - wallStart

  return { ok, errors, latenciesMs, wallMs }
}

export interface LoadSummary {
  totalRequests: number
  ok: number
  errors: number
  /** Requests completed per second over the whole run. */
  throughput: number
  /** Latency percentiles in milliseconds. */
  latency: { p50: number; p95: number; p99: number; max: number }
}

/** Nearest-rank percentile (`p` in `[0, 1]`) of a latency sample, in ms. */
export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const rank = Math.ceil(p * sortedMs.length)
  const index = Math.min(sortedMs.length - 1, Math.max(0, rank - 1))
  return sortedMs[index] ?? 0
}

/** Folds raw {@link LoadResult} timings into throughput + latency percentiles. */
export function summarize(result: LoadResult): LoadSummary {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b)
  const total = result.ok + result.errors
  const throughput = result.wallMs > 0 ? (total / result.wallMs) * 1000 : 0
  return {
    totalRequests: total,
    ok: result.ok,
    errors: result.errors,
    throughput,
    latency: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
    },
  }
}

/** Renders a {@link LoadSummary} as a clean, aligned text block. */
export function formatSummary(s: LoadSummary): string {
  const ms = (n: number): string => `${n.toFixed(2)}ms`
  return [
    '',
    '── benchmark results ──────────────────────',
    `requests     : ${s.totalRequests} (${s.ok} ok, ${s.errors} errors)`,
    `throughput   : ${s.throughput.toFixed(1)} req/s`,
    `latency p50  : ${ms(s.latency.p50)}`,
    `latency p95  : ${ms(s.latency.p95)}`,
    `latency p99  : ${ms(s.latency.p99)}`,
    `latency max  : ${ms(s.latency.max)}`,
    '───────────────────────────────────────────',
  ].join('\n')
}
