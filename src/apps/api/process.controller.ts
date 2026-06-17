import type { FastifyInstance } from 'fastify'

/**
 * Registers the `POST /aggregator/takehome/process` endpoint.
 *
 * For this slice the handler is a stub that returns `200 {}`. The HMAC auth
 * guard is wired separately (green step); the route here is intentionally
 * unprotected for now.
 */
export function registerProcessController(app: FastifyInstance): void {
  app.post('/aggregator/takehome/process', async (_request, reply) => {
    return reply.code(200).send({})
  })
}
