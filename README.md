# yeet-bet-processor

WIP.

## Design decisions

- **Batch failure is whole-request rollback (atomic).** The spec says to process
  a round's actions "atomically", and the insufficient-funds response is a bare
  `{ code, message }` with no `transactions` array. So a batch that can't be
  covered rolls back entirely: no wallet change, no ledger rows. We deliberately
  rejected per-action partial reporting (apply what fits, report the rest) — it
  contradicts "atomically" and has no shape in the response, and a betting round
  is a single unit of work, not independently-committable lines.
- **Idempotency via `UNIQUE(action_id)`.** A replayed `action_id` is detected up
  front and is never applied twice; the replay returns the original `tx_id`, so
  retries and at-least-once delivery from the aggregator are safe.
- **Fixed ~3-statement transaction, not a giant CTE.** Each batch runs a constant
  number of statements regardless of size: select existing action_ids, one
  guarded wallet debit for the net of new bets, one bulk ledger insert. This
  keeps the SQL readable and debuggable; a single all-in-one CTE would be far
  harder to reason about for no real throughput gain at these batch sizes.

## Database & migrations

Migrations run **automatically on startup** (the app calls `migrate(db)` before
it begins serving), so a fresh database is brought to the latest schema on boot.
This is a deliberate choice: Kysely's `Migrator` takes a Postgres advisory lock,
so concurrent replicas booting at once race safely (only one applies a given
migration). Revisit moving migrations to a standalone job only if they grow long
(blocking startup) or the app needs a least-privilege, DML-only DB role at
runtime. A `pnpm migrate` entrypoint is also available to run them explicitly.

Wallet `balance` is stored as a Postgres `bigint` in minor units (smallest
currency unit) and converted to a JS `number` at the adapter boundary (in
`findWallet`). This is precision-safe below `2^53`; balances beyond that would
lose precision — a documented limit for extreme values.

## Health check

`GET /health` is an **unauthenticated** endpoint. It is a load-balancer /
Kubernetes liveness + readiness probe, not a user-facing route. It returns:

- `200 { "status": "ok", "db": "ok" }` when the database is reachable.
- `503 { "status": "ok", "db": "down" }` when the service is up but its database
  dependency is not.

The HMAC auth applies to the business endpoints only; the probe is intentionally
left open so infrastructure can check service health.

## Authentication

Every business request must be signed. The client sends:

```
Authorization: HMAC-SHA256 <hex>
```

where `<hex>` is the HMAC-SHA256 digest over the **raw request body bytes**
(never re-serialized JSON, so whitespace-sensitive payloads verify correctly),
keyed by the shared secret. The signature is verified in constant time. A
missing, malformed, or invalid signature is rejected with `403`. `/health` is
exempt (it is an infrastructure probe, not a business route).

Notes:

- **Multi-key / rotation**: the verifier is built so it can be extended to
  accept multiple keys for key rotation if needed in the future.
- **Error codes**: responses use `{ code, message }`. The spec only defines
  domain code `100` (insufficient funds); HTTP-level errors currently reuse the
  HTTP status as `code` (e.g. `403`). The full error-code vocabulary still needs
  alignment with Yeet.
