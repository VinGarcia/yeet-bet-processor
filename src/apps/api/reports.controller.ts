import type { FastifyInstance } from 'fastify'
import type { CasinoRtpRow, UserRtpRow } from '../../core/entities.js'
import type { Repo, RtpReportQuery } from '../../adapters/repo/contracts.js'
import { BadRequestError } from '../../core/errors.js'

// A strict ISO-8601 datetime: `YYYY-MM-DDThh:mm:ss` with optional fractional
// seconds and a REQUIRED `Z`/`±hh:mm` offset. The offset is mandatory because an
// offset-less timestamp would be parsed as server-local time, silently shifting
// the report window per host; requiring it keeps the window unambiguous (UTC or
// explicit) and turns a malformed `from`/`to` into a clean 400.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Parses one ISO-8601 datetime field, throwing a 400 on anything malformed.
 * Exported for unit testing of the {@link ISO_DATETIME_RE} acceptance boundary.
 */
export function parseIsoDatetime(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) {
    throw new BadRequestError(`${field} must be an ISO-8601 datetime`)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new BadRequestError(`${field} must be a valid datetime`)
  return new Date(ms)
}

/**
 * Narrows an unvalidated parsed body to {@link RtpReportQuery} without `as` or
 * `any`. `from`/`to` are required ISO-8601 datetimes with `from <= to`; `cursor`
 * is an optional opaque string; `limit` is an optional positive integer.
 */
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

  return { from, to, cursor, limit }
}

/** Maps a casino RTP row to its snake_case wire shape. */
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

/** Maps a per-user RTP row to its snake_case wire shape (casino fields + user_id). */
function toUserWire(r: UserRtpRow): Record<string, unknown> {
  return { user_id: r.userId, ...toCasinoWire(r) }
}

/**
 * Registers the two HMAC-signed RTP report endpoints inside the protected scope:
 *
 *   POST /aggregator/takehome/reports/rtp/users  — per (user, currency)
 *   POST /aggregator/takehome/reports/rtp/casino — per currency, all users
 *
 * Both take `{ from, to, cursor?, limit? }`, return `{ items, cursor }`, and
 * page via an opaque keyset cursor (null once exhausted).
 */
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
