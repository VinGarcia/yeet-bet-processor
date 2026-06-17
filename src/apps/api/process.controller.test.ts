import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'
import type { DB } from '../../adapters/repo/kyselyrepo/schema.js'

// The secret is invariant across every test and no assertion depends on its
// value, so the app is shared infra: build it once in beforeAll.
const SECRET = 'test'

let container: StartedPostgreSqlContainer
let db: Kysely<DB>
let app: FastifyInstance
let baseURL: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()

  const pool = new Pool({ connectionString: container.getConnectionUri() })
  db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })

  app = await buildApp({ db, hmacSecret: SECRET })
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

// Self-contained signature over the exact raw body string we send. Uses Node's
// crypto directly so the test is correct independent of our impl.
function signRaw(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex')
}

describe('POST /aggregator/takehome/process', () => {
  it('rejects a request with no Authorization header with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const res = await fetch(`${baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

    expect(res.status).toBe(403)
    const payload = (await res.json()) as { code: number; message: string }
    expect(payload.code).toBe(403)
    expect(typeof payload.message).toBe('string')
  })

  it('accepts a request with a valid signature with 200 and an empty body', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const signature = signRaw(SECRET, body)
    const res = await fetch(`${baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}`,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('rejects a request with a tampered signature with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const signature = signRaw(SECRET, body)
    const tampered = signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
    const res = await fetch(`${baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${tampered}`,
      },
      body,
    })

    expect(res.status).toBe(403)
  })

  it('rejects a request with a malformed Authorization header with 403', async () => {
    const body = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
    const res = await fetch(`${baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'HMAC-SHA256 nothex',
      },
      body,
    })

    expect(res.status).toBe(403)
  })

  it('rejects a valid signature over a malformed JSON body with 400', async () => {
    const body = '{"user_id":"8|USDT|USD",'
    const signature = signRaw(SECRET, body)
    const res = await fetch(`${baseURL}/aggregator/takehome/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}`,
      },
      body,
    })

    expect(res.status).toBe(400)
  })
})
