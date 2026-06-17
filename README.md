# yeet-bet-processor

WIP.

## Design decisions

- **Actions processed strictly in request order with a per-step balance check.**
  New bets are applied one at a time against a running balance; the first bet
  that would drive the balance below zero rejects the **whole request** with code
  `100` and rolls everything back. We check at each step, not just the net of the
  batch. With bets only this is indistinguishable from a net check (debits
  commute), but it becomes observable once wins interleave with bets in a batch —
  a later win cannot retroactively fund an earlier bet that already overdrew. The
  concrete case: balance `50`, `[bet 100, win 200]` rejects with code `100`
  because the bet overdraws at step 1 (`-50`), even though the net delta (`+100`)
  would leave a positive balance. A net-only implementation cannot reject this.
- **Wallet row is ensured-and-locked via upsert before the balance check.**
  Instead of `SELECT … FOR UPDATE` (which locks nothing when the row is absent)
  plus a bare `UPDATE` (which silently matches zero rows for a brand-new user,
  losing the debit while the ledger still writes), we run a single
  `INSERT … ON CONFLICT (user_id, currency) DO UPDATE SET balance = wallets.balance
  RETURNING balance`. The no-op `DO UPDATE` still takes the row lock and returns
  the current balance; if the row is absent it is created at 0. This guarantees
  the row exists and is row-locked before the per-step computation, so concurrent
  first-bet batches for the same new user **serialize** (no lost update) and
  wallet/ledger can never diverge.
- **A bet against a non-existent wallet lazily creates it at balance 0.** There
  is no separate "open wallet" step: the first action for a user/currency
  materializes the wallet (at 0) as part of the ensure-and-lock upsert. With
  bet-only and a start balance of 0, any *positive* first bet still rejects via
  the per-step check (`0 - amount < 0`), and the just-created row is rolled back
  with the transaction — so no orphan wallet and no orphan ledger row remain.
- **Batch failure is whole-request rollback (atomic).** The spec says to process
  a round's actions "atomically", and the insufficient-funds response is a bare
  `{ code, message }` with no `transactions` array. So a batch that can't be
  covered rolls back entirely: no wallet change, no ledger rows. We deliberately
  rejected per-action partial reporting (apply what fits, report the rest) — it
  contradicts "atomically" and has no shape in the response, and a betting round
  is a single unit of work, not independently-committable lines.
- **Idempotency via `UNIQUE(action_id)`.** A replayed `action_id` is detected up
  front and is never applied twice; the replay returns the original `tx_id`, so
  retries and at-least-once delivery from the aggregator are safe. A duplicate
  `action_id` — whether it appears **twice within one batch** or arrives as a
  **concurrent submission of the same brand-new id** — is also resolved as an
  idempotent replay, not an error: (a) within a batch we dedupe by `action_id`
  before applying, keeping the first occurrence so the debit happens once and both
  response slots carry the same `tx_id`; (b) for a concurrent race the up-front
  lookup is unlocked and the wallet lock does not cover the ledger, so the loser's
  insert hits `UNIQUE(action_id)` (`23505`) and aborts its transaction — we catch
  that violation, then in a **fresh transaction** re-read the now-committed rows by
  `action_id` and return their **original** `tx_id`s (the standard insert-or-get
  pattern). Either way the raw `23505` never leaks past the adapter.
- **Small, fixed set of statements, not a giant CTE.** Each batch runs a constant
  number of statements regardless of size: select existing action_ids, one locked
  balance read, one wallet update to the computed balance, one bulk ledger insert.
  The per-bet balance check is plain in-memory arithmetic in the app, not SQL.
  This keeps the SQL readable and debuggable; a single all-in-one CTE would be far
  harder to reason about for no real throughput gain at these batch sizes.

## Known / accepted limitations (this slice)

These are deliberately left as-is for the current slice and flagged for a later
decision:

- **`Number(bigint)` precision ceiling.** Balances are converted from Postgres
  `bigint` to a JS `number` at the adapter boundary, which is exact only below
  `2^53`. Balances beyond that would lose precision. Accepted for now; revisit if
  real balances can approach that magnitude (move math to `bigint`/`string` end
  to end).
- **Integer overflow is not guarded.** Balances and amounts are integer minor
  units handled as JS `number`s, and the running-balance arithmetic does not check
  for overflow. Realistic values stay well below `Number.MAX_SAFE_INTEGER`
  (`2^53`), so we deliberately accept this rather than add guards. A real system
  carrying balances near that ceiling would use `BigInt` or `NUMERIC` end to end.

## Database & migrations

Migrations run **automatically on startup** (the app calls `migrate(db)` before
it begins serving), so a fresh database is brought to the latest schema on boot.
This is a deliberate choice: Kysely's `Migrator` takes a Postgres advisory lock,
so concurrent replicas booting at once race safely (only one applies a given
migration). Revisit moving migrations to a standalone job only if they grow long
(blocking startup) or the app needs a least-privilege, DML-only DB role at
runtime.

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
