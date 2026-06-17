import { config } from '../../config.js'
import { createDb } from '../../adapters/repo/kyselyrepo/create-db.js'
import { migrate } from '../../adapters/repo/kyselyrepo/migrations/index.js'

/**
 * Standalone migration entrypoint (`pnpm migrate`). Runs all pending migrations
 * against the configured database, then closes the connection. Exits non-zero
 * on failure so it can gate a deploy. The app also self-migrates on startup;
 * this entrypoint is the explicit, run-it-yourself alternative.
 */
async function main(): Promise<void> {
  const db = createDb(config.databaseUrl)
  try {
    await migrate(db)
  } finally {
    await db.destroy()
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
