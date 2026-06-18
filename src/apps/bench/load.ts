import { signedJsonRequest } from '../../helpers/crypto/hmac.js'

// Closed-loop load generator: `concurrency` workers pull the next request index
// off a shared counter and stop at `totalRequests`, bounding in-flight requests
// without an unbounded queue.

export type RequestFactory = (i: number) => unknown

export interface LoadOptions {
  url: string
  secret: string
  concurrency: number
  totalRequests: number
  makeBody: RequestFactory
}

export interface LoadResult {
  ok: number
  errors: number
  latenciesMs: number[]
  wallMs: number
}

/** A minimal `fetch` shape so a test can inject a fake transport. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>

/** Runs the load test and returns raw timings; {@link summarize} computes percentiles. */
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
  throughput: number
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
