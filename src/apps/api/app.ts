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

/**
 * Builds the Fastify application: constructs the Repo adapter from the injected
 * database handle and wires up the controllers.
 *
 * `hmacSecret` is the shared secret used to authenticate the protected business
 * routes. `/health` stays on the root scope and is left unauthenticated.
 */
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

  // Central mapping of domain errors to HTTP responses. Registered before the
  // protected scope so the encapsulated scope inherits it. HTTP knowledge lives
  // only here; the core errors carry domain codes, not transport status.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      let status = 400 // Domain errors are client errors by default.
      if (err instanceof ForbiddenError) status = 403
      else if (err instanceof BadRequestError) status = 400
      else if (err instanceof NotFoundError) status = 404
      // Insufficient funds is a well-formed request the server won't apply.
      else if (err instanceof InsufficientFundsError) status = 422
      return reply.code(status).send({ code: err.code, message: err.message })
    }
    request.log.error(err)
    return reply.code(500).send({ code: 500, message: 'internal server error' })
  })

  // Unauthenticated probe lives on the root scope.
  registerHealthController(app, repo)

  // Protected business routes live in an encapsulated scope so the raw-body
  // parser and HMAC guard never apply to `/health`.
  await app.register((protectedScope, _opts, done) => {
    registerHmacAuth(protectedScope, { secret: hmacSecret })
    registerProcessController(protectedScope, repo)
    registerReportControllers(protectedScope, repo)
    done()
  })

  await app.ready()
  return app
}
