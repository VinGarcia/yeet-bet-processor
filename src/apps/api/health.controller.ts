import type { FastifyInstance } from 'fastify'
import type { Repo } from '../../adapters/repo/contracts.js'

/**
 * Registers the unauthenticated `GET /health` probe.
 *
 * The endpoint reports liveness (the service is up) and readiness (its database
 * dependency is reachable). It is intended for load-balancer / Kubernetes probes
 * and is deliberately not behind auth.
 */
export function registerHealthController(app: FastifyInstance, repo: Repo): void {
  app.get('/health', async (_request, reply) => {
    try {
      await repo.checkConnection()
      return reply.code(200).send({ status: 'ok', db: 'ok' })
    } catch {
      return reply.code(503).send({ status: 'ok', db: 'down' })
    }
  })
}
