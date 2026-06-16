import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'
import { KyselyRepo } from '../../adapters/repo/kyselyrepo/index.js'
import { registerHealthController } from './health.controller.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<DB>
  }
}

/**
 * Builds the Fastify application: constructs the Repo adapter from the injected
 * database handle and wires up the controllers.
 */
export async function buildApp({ db }: { db: Kysely<DB> }): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('db', db)

  const repo = new KyselyRepo(db)
  registerHealthController(app, repo)

  await app.ready()
  return app
}
