import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'
import { KyselyRepo } from '../../adapters/repo/kyselyrepo/index.js'
import { DomainError, BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors.js'
import { registerHealthController } from './health.controller.js'
import { registerProcessController } from './process.controller.js'
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

  // Maps a domain error to an HTTP status. HTTP knowledge lives only in this
  // adapter; the core errors carry domain codes, not transport status.
  function httpStatusFor(err: DomainError): number {
    if (err instanceof ForbiddenError) return 403
    if (err instanceof BadRequestError) return 400
    if (err instanceof NotFoundError) return 404
    // Domain errors are client errors by default.
    return 400
  }

  // Central mapping of domain errors to HTTP responses. Registered before the
  // protected scope so the encapsulated scope inherits it.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      return reply.code(httpStatusFor(err)).send({ code: err.code, message: err.message })
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
    registerProcessController(protectedScope)
    done()
  })

  await app.ready()
  return app
}
