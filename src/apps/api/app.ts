import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'
import { KyselyRepo } from '../../adapters/repo/kyselyrepo/index.js'
import {
  DomainError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  InsufficientFundsError,
} from '../../core/errors.js'
import { registerHealthController } from './health.controller.js'
import { registerProcessController } from './process.controller.js'
import { registerReportControllers } from './reports.controller.js'
import { registerHmacAuth } from './middlewares/hmac-auth.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<DB>
  }
}

// Builds the Fastify app from the injected db; `/health` stays unauthenticated
// on the root scope, business routes go behind HMAC.
export async function buildApp({
  db,
  hmacSecret,
}: {
  db: Kysely<DB>
  hmacSecret: string
}): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('db', db)

  const repo = new KyselyRepo(db)

  // The one place HTTP status is mapped from domain errors; the core carries
  // domain codes, not transport status. Registered before the protected scope so it inherits it.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      let status = 400
      if (err instanceof ForbiddenError) status = 403
      else if (err instanceof BadRequestError) status = 400
      else if (err instanceof NotFoundError) status = 404
      // Well-formed request the server declines to apply.
      else if (err instanceof InsufficientFundsError) status = 422
      return reply.code(status).send({ code: err.code, message: err.message })
    }
    request.log.error(err)
    return reply.code(500).send({ code: 500, message: 'internal server error' })
  })

  registerHealthController(app, repo)

  // Encapsulated scope so the raw-body parser and HMAC guard never reach `/health`.
  await app.register((protectedScope, _opts, done) => {
    registerHmacAuth(protectedScope, { secret: hmacSecret })
    registerProcessController(protectedScope, repo)
    registerReportControllers(protectedScope, repo)
    done()
  })

  await app.ready()
  return app
}
