import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'

let container: StartedPostgreSqlContainer
let app: FastifyInstance
let db: Kysely<DB>
let baseURL: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const pool = new Pool({ connectionString: container.getConnectionUri() })
  db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
  app = await buildApp({ db, hmacSecret: 'test' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as AddressInfo
  baseURL = `http://127.0.0.1:${address.port}`
}, 60_000)

afterAll(async () => {
  await app.close()
  await db.destroy()
  await container.stop()
})

beforeEach(async () => {
  await resetTestDB(db)
})

describe('GET /health', () => {
  it('returns 200 with status ok and db ok when the database is reachable', async () => {
    const res = await fetch(`${baseURL}/health`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' })
  })
})
