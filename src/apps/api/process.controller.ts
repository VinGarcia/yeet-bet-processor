import type { FastifyInstance } from 'fastify'
import type { Repo } from '../../adapters/repo/contracts.js'
import { BadRequestError } from '../../core/errors.js'

/**
 * The external request shape, after narrowing the parsed body. The aggregator
 * speaks snake_case; the controller maps it to the camelCase domain.
 */
interface ProcessRequest {
  userId: string
  currency: string
  actions: unknown[]
}

/**
 * Narrows an unvalidated parsed body to {@link ProcessRequest} without `as` or
 * `any`. `user_id` and `currency` are required strings; `actions` is optional
 * and defaults to an empty list (a balance-only request).
 */
function parseProcessRequest(body: unknown): ProcessRequest {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('request body must be a JSON object')
  }
  if (!('user_id' in body) || typeof body.user_id !== 'string') {
    throw new BadRequestError('user_id is required')
  }
  if (!('currency' in body) || typeof body.currency !== 'string') {
    throw new BadRequestError('currency is required')
  }

  const actions = 'actions' in body && Array.isArray(body.actions) ? body.actions : []

  return { userId: body.user_id, currency: body.currency, actions }
}

/**
 * Registers the `POST /aggregator/takehome/process` endpoint.
 *
 * A request with no `actions` is a balance-only lookup: it returns the wallet's
 * balance (0 when the user has no wallet). Requests carrying `actions` are not
 * processed yet and fall through to the existing stub response.
 */
export function registerProcessController(app: FastifyInstance, repo: Repo): void {
  app.post('/aggregator/takehome/process', async (request, reply) => {
    const { userId, currency, actions } = parseProcessRequest(request.body)

    if (actions.length === 0) {
      const wallet = await repo.findWallet(userId, currency)
      return reply.code(200).send({ balance: wallet?.balance ?? 0 })
    }

    // Intentional stub: requests carrying `actions` are not processed yet.
    // Slice 3b implements bet processing and returns the real response here.
    return reply.code(200).send({})
  })
}
