import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { config } from '../../config.js'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'
import { buildApp } from './app.js'

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl })
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })

  const app = await buildApp({ db })

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info(`server listening on port ${config.port}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
