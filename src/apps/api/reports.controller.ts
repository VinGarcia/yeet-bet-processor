import type { FastifyInstance } from 'fastify'
import type { CasinoRtpRow, UserRtpRow } from '../../core/entities.js'
import type { Repo, RtpReportQuery } from '../../adapters/repo/contracts.js'
import { BadRequestError } from '../../core/errors.js'

// Strict ISO-8601 with a REQUIRED `Z`/`±hh:mm` offset: an offset-less timestamp
// would parse as server-local time, silently shifting the report window per host.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function parseIsoDatetime(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) {
    throw new BadRequestError(`${field} must be an ISO-8601 datetime`)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new BadRequestError(`${field} must be a valid datetime`)
  return new Date(ms)
}

// Narrows the parsed body to {@link RtpReportQuery}; from/to are required ISO with from <= to.
function parseRtpReportRequest(body: unknown): RtpReportQuery {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('request body must be a JSON object')
  }
  if (!('from' in body)) throw new BadRequestError('from is required')
  if (!('to' in body)) throw new BadRequestError('to is required')
  const from = parseIsoDatetime(body.from, 'from')
  const to = parseIsoDatetime(body.to, 'to')
  if (from.getTime() > to.getTime()) throw new BadRequestError('from must be <= to')

  let cursor: string | undefined
  if ('cursor' in body) {
    if (typeof body.cursor !== 'string') throw new BadRequestError('cursor must be a string')
    cursor = body.cursor
  }

  let limit: number | undefined
  if ('limit' in body) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit <= 0) {
      throw new BadRequestError('limit must be a positive integer')
    }
    limit = body.limit
  }

  // Optional: restrict the per-user report to one user. The casino report ignores it.
  let userId: string | undefined
  if ('user_id' in body) {
    if (typeof body.user_id !== 'string' || body.user_id === '') {
      throw new BadRequestError('user_id must be a non-empty string')
    }
    userId = body.user_id
  }

  return { from, to, cursor, limit, userId }
}

function toCasinoWire(r: CasinoRtpRow): Record<string, unknown> {
  return {
    currency: r.currency,
    rounds: r.rounds,
    total_bet: r.totalBet,
    total_win: r.totalWin,
    rtp: r.rtp,
    rolled_back_bet: r.rolledBackBet,
    rolled_back_win: r.rolledBackWin,
  }
}

function toUserWire(r: UserRtpRow): Record<string, unknown> {
  return { user_id: r.userId, ...toCasinoWire(r) }
}

/** Registers the two HMAC-signed RTP report endpoints (per-user and casino-wide). */
export function registerReportControllers(app: FastifyInstance, repo: Repo): void {
  app.post('/aggregator/takehome/reports/rtp/users', async (request, reply) => {
    const query: RtpReportQuery = parseRtpReportRequest(request.body)
    const page = await repo.userRtpReport(query)
    return reply.code(200).send({ items: page.items.map(toUserWire), cursor: page.cursor })
  })

  app.post('/aggregator/takehome/reports/rtp/casino', async (request, reply) => {
    const query: RtpReportQuery = parseRtpReportRequest(request.body)
    const page = await repo.casinoRtpReport(query)
    return reply.code(200).send({ items: page.items.map(toCasinoWire), cursor: page.cursor })
  })
}
