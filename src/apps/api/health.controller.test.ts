import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from './create-test-app.js'
import { resetTestDB } from '../../adapters/repo/kyselyrepo/test-helpers.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>

beforeAll(async () => {
  ctx = await createTestApp()
}, 60_000)

afterAll(() => ctx.close())

beforeEach(() => resetTestDB(ctx.db))

describe('GET /health', () => {
  it('returns 200 with status ok and db ok when the database is reachable', async () => {
    const res = await fetch(`${ctx.baseURL}/health`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' })
  })
})
