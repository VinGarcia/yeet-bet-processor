import { config } from '../../config.js'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import { buildApp } from './app.js'

async function main(): Promise<void> {
  const db = createDb(config.databaseUrl)

  // Self-migrate on boot so a fresh database is brought to the latest schema
  // before the app starts serving traffic.
  await migrate(db)

  const app = await buildApp({ db, hmacSecret: config.hmacSecret })

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info(`server listening on port ${config.port}`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`received ${signal}, shutting down`)
      void app.close().then(
        () => process.exit(0),
        (err) => {
          app.log.error(err)
          process.exit(1)
        },
      )
    })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
