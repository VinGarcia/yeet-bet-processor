# Yeet Bet Processor

A production-style bet processor: bets / wins / rollbacks over a single signed
endpoint, with idempotency, non-negative balances, HMAC auth, per-user and
casino-wide RTP reporting, a seedable game runner, and a load benchmark.
Built in TypeScript (Fastify + Kysely + Postgres).

## Architecture

Hexagonal: domain logic in `src/core`, outbound adapters on `src/adapters`
inbound on `src/apps`. The main integration tests on `src/apps/api` start
a postgres docker container and run migrations before testing no setup
needed just run `pnpm install && pnpm test`

Deeper architecture notes live in [`AGENTS.md`](./AGENTS.md).

## Quick start

```sh
cp .env.example .env                    # DATABASE_URL, PORT, HMAC_SECRET, DB_HOST_PORT
docker compose up --build               # API on :3000, Postgres on :5132
```

Migrations run automatically on boot (advisory-locked, so replicas booting at
once race safely).

### Tests

```sh
pnpm install
pnpm test                 # vitest + testcontainers (spins its own Postgres)
pnpm typecheck && pnpm lint
```

### Smoke test (end-to-end against docker compose)

```sh
./scripts/smoke.sh        # boots compose, sends a signed bet, asserts balance, tears down
```

### Seed / game runner / benchmark

```sh
pnpm seed --count=5000                          # bulk wallet rows (direct inserts, never via win)
pnpm gamerunner --users=1000 --rounds=5000      # randomized rounds, verifies global RTP ~0.95
pnpm bench --concurrency=100 --requests=200000  # throughput + latency percentiles
```

Flags (CLI or env, CLI wins) are listed at the top of each tool's source.

## API

One business endpoint plus two reports, all `POST` and HMAC-signed; `/health` is open.

- `POST /aggregator/takehome/process` — bets/wins/rollbacks (or balance-only when
  `actions` is empty). Returns `{ game_id, transactions: [{action_id, tx_id}], balance }`.
- `POST /aggregator/takehome/reports/rtp/users` — RTP per (user, currency).
- `POST /aggregator/takehome/reports/rtp/casino` — RTP per currency.
- `GET /health` — liveness/readiness (`200` ok / `503` if DB down), unauthenticated.

### Auth

`Authorization: HMAC-SHA256 <hex>`, where `<hex>` is HMAC-SHA256 over the **raw
request body bytes** (verified pre-parse, constant-time). Signing the raw bytes —
not re-serialized JSON — keeps whitespace-sensitive payloads verifiable. Missing
or invalid → `403`.

## Design decisions

**Correctness & concurrency**

- **Per-step balance check, whole-request atomicity.** Actions apply in order
  against a running balance; the first step to go below zero rejects the *entire*
  batch with code `100` and rolls back. A net-only check would wrongly accept
  `[bet 100, win 200]` on a balance of 50.
- **Ensure-and-lock wallet upsert.** One `INSERT … ON CONFLICT … DO UPDATE
  RETURNING balance` locks (and lazily creates, at 0) the wallet row before the
  check, so concurrent same-user batches serialize — no lost updates, wallet and
  ledger never diverge.
- **Idempotency.** A replayed `action_id` returns its original `tx_id` and never
  re-applies — enforced by the wallet lock (the loser's context SELECT sees the
  committed row), with `UNIQUE(action_id)` as a backstop.

**Rollbacks**

- Reverse the original in the opposite direction (bet → credit, win → debit);
  the amount is derived from the original, not sent.
- **Pre-rollback (spec requirement).** A rollback of a not-yet-seen action is
  stored (`amount = 0`) and returns a `tx_id`; when the original later arrives it
  becomes a **noop**. Order within a batch is irrelevant — `[bet A, rollback A]`
  and `[rollback A, bet A]` behave identically.
- **Clawback overdraw** (rolling back a win past zero) rejects with code `100`,
  like a bet.
- **Double-rollback and rollback-of-a-rollback → `400`** (the spec defines no
  domain code for these; pending alignment).

**Scale**

- **`rolledback` flag per ledger row** (denormalized) lets the RTP query filter
  `type IN ('bet','win') AND rolledback = false` — a plain indexable predicate
  instead of a `NOT EXISTS` anti-join that worsens as the ledger grows. It is set
  on the path that already knows the reversal happened (no extra round-trip) and
  stays correct because a double-rollback is rejected, so each original is
  reversed at most once.
- **Fixed statement count per batch** regardless of size (upsert, one context
  SELECT, bulk insert, at most one flag UPDATE, one balance UPDATE) — not a giant
  CTE. Step resolution is in-memory.

**RTP reporting**

- `rtp = total_win / total_bet`, both excluding reversed rows; `null` when
  `total_bet = 0`. Reversed amounts are surfaced separately as
  `rolled_back_bet` / `rolled_back_win`.
- `rounds` = non-reversed bets in the window (one bet = one round; an alternative
  is `count(distinct game_id)`).
- **Half-open `[from, to)`** window, so adjacent windows neither overlap nor gap.
- **Keyset (cursor) pagination**, not offset — stable and gap-free across billions
  of rows (the cursor is an opaque token). A partial index
  `transactions(created_at) WHERE type IN ('bet','win')` keeps the window scan
  selective.

**Performance** — `pnpm bench` drives `/process` under closed-loop concurrency and
reports throughput + p50/p95/p99. One stateless API scales horizontally behind a
load balancer; per-wallet writes serialize only on the same `(user_id, currency)`
row, so load spread across users scales near-linearly until Postgres saturates
(then read replicas for reports + ledger partitioning). Indicative local run:
~2000 signed bets/s at p99 ~16 ms, concurrency 16 (laptop, API + DB co-located —
a relative baseline, not a ceiling).

## Limitations

- Balances are JS `number` (exact below `2^53`); a system approaching that would
  move to `BigInt` / `NUMERIC` end to end.
- A large-window RTP aggregate scans every in-window row; a production system
  would read from a maintained rollup / materialized summary. Out of scope here.
