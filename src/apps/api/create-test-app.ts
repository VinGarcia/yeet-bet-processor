import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { AddressInfo } from 'node:net'
import type { Kysely } from 'kysely'
import { buildApp } from './app.js'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'

// The HMAC secret is invariant infrastructure config for the tests: no assertion
// depends on its value, only that signing and verification share it. Exported so
// tests that need to sign a request can reuse the exact same value.
export const TEST_SECRET = 'test'

/**
 * Spins up the full integration stack for a test file: a fresh Postgres
 * testcontainer, a migrated database, and a listening Fastify app on an
 * ephemeral port.
 *
 * Returns the `db` handle (for seeding/resetting), the `baseURL` to hit, and a
 * `close()` that tears everything down (app, db, container) in order.
 */
export async function createTestApp(): Promise<{
  db: Kysely<DB>
  baseURL: string
  close: () => Promise<void>
}> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start()

  const db = createDb(container.getConnectionUri())
  await migrate(db)

  const app = await buildApp({ db, hmacSecret: TEST_SECRET })
  await app.listen({ port: 0, host: '127.0.0.1' })

  const address = app.server.address() as AddressInfo
  const baseURL = `http://127.0.0.1:${address.port}`

  async function close(): Promise<void> {
    await app.close()
    await db.destroy()
    await container.stop()
  }

  return { db, baseURL, close }
}
