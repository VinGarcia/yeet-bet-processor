import type { FastifyInstance } from 'fastify'
import type { Repo } from '../../adapters/repo/contracts.js'

// Unauthenticated `GET /health`: liveness + DB readiness, for LB/Kubernetes probes.
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
