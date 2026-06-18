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
  bet-only and a start balance of 0, any _positive_ first bet still rejects via
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
  **concurrent submission of the same brand-new id** — is resolved as an
  idempotent replay, not an error: (a) within a batch we dedupe by `action_id`
  before applying, keeping the first occurrence so the debit happens once and both
  response slots carry the same `tx_id`; (b) for a concurrent race the detection
  is lock-based, not a `23505` catch. Each batch first does an ensure-and-lock
  wallet upsert that serializes same-`(user, currency)` batches; the loser blocks
  until the winner commits, then — still inside its own transaction, after the
  lock — its **context SELECT** sees the now-committed row by `action_id` and
  returns that **original** `tx_id` instead of re-inserting. The `UNIQUE(action_id)`
  constraint remains as a backstop, but under the wallet lock the duplicate insert
  is never attempted, so a raw `23505` never reaches the adapter's happy path.
- **Rollback semantics.** A `rollback` carries `original_action_id` and **no
  `amount`** (the amount is derived from the referenced original). It reverses
  the original in the **opposite** direction: rolling back a `bet` **credits**
  the amount back; rolling back a `win` **debits** (claws back) it. Both bets and
  wins are reversible.
  - **Pre-rollback (spec hard requirement).** A rollback that references a
    not-yet-seen original is **recorded** (a `rollback` row with `amount = 0`,
    no balance change) and still returns a `tx_id`. When the original `bet`/`win`
    later arrives — a future request _or_ later in the same batch — it becomes a
    **noop**: persisted (so it has a `tx_id` and idempotency holds) but with no
    balance effect.
  - **Rollback ordering within a batch (order-independent noop).** A `bet`/`win`
    cancelled by a rollback **anywhere in the same batch** is a noop, whether the
    rollback comes before or after it. We pre-populate the set of rolled-back
    originals from the whole batch up front, so the in-order pass simply never
    applies a cancelled `bet`/`win` to the balance — rather than applying it and
    reversing it later. Two deliberate consequences: (1) `[bet A, rollback A]` and
    `[rollback A, bet A]` behave identically; (2) a `bet` that would overdraw is
    **not** rejected if the same batch rolls it back — the per-step
    insufficient-funds check only sees actions that actually take effect. We chose
    this over apply-then-reverse because order-independence is far easier to reason
    about and there is no value in failing a bet the same request cancels. Only
    **committed** (prior-call) originals are ever reversed against the balance;
    same-batch ones never landed.
  - **Clawback overdraw.** Rolling back a **committed** (prior-call) win debits the
    credited amount; if that would drive the balance below zero it is rejected with
    the **same** insufficient-funds domain code `100` as a bet, rolling the whole
    batch back. (A same-batch win is noop'd, never credited, so there is nothing to
    claw back.)
  - **Rejected cases → HTTP `400`.** A **double rollback** (a second, distinct
    rollback `action_id` targeting an original that already has a rollback,
    committed or earlier in the same batch) and a **rollback-of-a-rollback**
    (`original_action_id` points at a `rollback` row) are rejected with
    `BadRequestError` → `400`. The spec defines no domain code for these, so they
    reuse `400` pending alignment with Yeet (the controller likewise rejects a
    rollback with a missing/non-string `original_action_id` with `400`).
  - **Idempotency** is unchanged: a replayed `action_id` (including a replayed
    rollback) returns its original `tx_id` and is not re-applied.
  - **`rolledback` denormalization (for RTP at scale).** Each ledger row carries
    a `rolledback` boolean. An original (`bet`/`win`) is set `true` the moment a
    rollback reverses it; **rollback rows themselves stay `false`** (and keep
    `amount = 0` — the reversal reads the original's amount in memory, never the
    rollback row's). The future RTP query can then filter
    `WHERE type <> 'rollback' AND rolledback = false` — a plain indexable
    predicate — instead of an anti-join (`NOT EXISTS` against the rollback rows)
    that grows more expensive as the ledger does. It is written on the path that
    already knows the reversal happened, so it costs no extra round-trip per
    action: a **same-batch** cancelled original is noop'd, so its row is written
    with `rolledback = true` directly, and **prior-call** (committed) originals are
    flagged with a single batched `UPDATE … WHERE action_id IN (…)` inside the same
    transaction. The flag is a
    denormalization of "a rollback row with this `original_action_id` exists", so
    it stays correct only because a double rollback is rejected — an original is
    reversed at most once.
- **Small, fixed set of statements, not a giant CTE.** Each batch runs a constant
  number of statements regardless of size: one ensure-and-lock wallet upsert
  (also the locked balance read), one **context SELECT** (replays + any rollback
  originals/targets), one bulk ledger insert, at most one batched `UPDATE` to
  flag prior-call originals as `rolledback`, and one wallet update to the
  computed balance. The per-step balance check and rollback resolution are plain
  in-memory logic in the app, not SQL.
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

## Seeding

`pnpm seed` bulk-creates wallet rows so a fresh database has thousands of funded
users to test or benchmark against. It connects with the same `DATABASE_URL` as
the app, self-migrates, then inserts in chunks.

```sh
pnpm seed                                  # 1000 USD wallets, default balances
pnpm seed --count=5000 --currency=EUR      # 5000 EUR wallets
pnpm seed --balance=50000                  # fixed balance (minor units)
pnpm seed --min=10000 --max=2000000        # deterministic balance range
```

**Direct wallet inserts, never `win` actions.** Seed money is bootstrap
liquidity, not game winnings. Funding via a `win` would write it to the
transaction ledger and inflate RTP (return-to-player) metrics, so the seeder
writes `wallets` rows directly and bypasses the ledger entirely.

**Deterministic + idempotent.** User ids are `<prefix><index>` and balances are
derived from the row index via a fixed-seed PRNG (`mulberry32`), so repeated runs
produce identical data. Inserts use `ON CONFLICT (user_id, currency) DO NOTHING`,
so re-running never errors or duplicates — the row count and balances stay the
same.

**Config knobs** (CLI flag wins over env var wins over default):

| Flag         | Env             | Default      | Meaning                                   |
| ------------ | --------------- | ------------ | ----------------------------------------- |
| `--count`    | `SEED_COUNT`    | `1000`       | Number of wallets to create               |
| `--currency` | `SEED_CURRENCY` | `USD`        | One of `USD`, `EUR`, `BRL`, `GBP`         |
| `--balance`  | `SEED_BALANCE`  | —            | Fixed balance (sets both bounds)          |
| `--min`      | `SEED_MIN`      | `10000`      | Balance range lower bound (minor units)   |
| `--max`      | `SEED_MAX`      | `1000000`    | Balance range upper bound (minor units)   |
| `--seed`     | `SEED_SEED`     | `1`          | PRNG seed for reproducible balances       |
| `--prefix`   | `SEED_PREFIX`   | `seed-user-` | Generated user-id prefix                  |
| `--chunk`    | `SEED_CHUNK`    | `1000`       | Rows per bulk INSERT (scales to far more) |

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

## RTP reporting

Two HMAC-signed endpoints compute Return-To-Player over a time window. Both are
`POST` with a JSON body, signed with the **same** HMAC scheme as `/process`
(missing/invalid signature → `403`):

- `POST /aggregator/takehome/reports/rtp/users` — grouped per (`user_id`,
  `currency`).
- `POST /aggregator/takehome/reports/rtp/casino` — grouped per `currency` only.
  Different currencies cannot be summed into a single RTP, so the casino-wide
  report stays per-currency (it just drops `user_id`).

**Request** — `{ from, to, cursor?, limit? }`. `from`/`to` are ISO-8601
datetimes (`400` if malformed or `from > to`) bounding a **half-open** window
`[from, to)` on `created_at` (`from` inclusive, `to` exclusive). `cursor` is the
opaque next-page token from a prior response. `limit` is an optional positive
integer page size, defaulting to `100` and capped at `1000`.

**Response** — `{ items, cursor }`. A per-user item:

```json
{
  "user_id": "string",
  "currency": "USD",
  "rounds": 123456,
  "total_bet": 123456789,
  "total_win": 117283950,
  "rtp": 0.9498,
  "rolled_back_bet": 1000,
  "rolled_back_win": 500
}
```

The casino item is identical without `user_id`. `cursor` is the token for the
next page, or `null` once the result set is exhausted.

Decisions:

- **RTP = `total_win / total_bet`, both excluding reversed rows.** A row reversed
  by a rollback (its denormalized `rolledback` flag is `true`) is excluded from
  `total_bet`/`total_win` and from `rounds`. A row counts as reversed by its
  **current** `rolledback` state, regardless of when the rollback happened
  relative to the window. `rollback` rows themselves are never counted (the query
  filters `type IN ('bet', 'win')`).
- **Reversed amounts surfaced separately.** `rolled_back_bet` / `rolled_back_win`
  are the sums of `amount` on reversed `bet` / `win` rows — so a reader can see
  what was clawed back without it distorting the headline RTP.
- **`rounds` = count of non-reversed `bet` rows** in the window (one bet = one
  round). _Alternative considered:_ counting **distinct `game_id`** as rounds. We
  chose one-bet-per-round deliberately: it is unambiguous, needs no extra index,
  and matches "RTP per wager". If a round is later defined as a full game
  regardless of re-bets, switch to `count(distinct game_id)`.
- **Denominator 0 → `rtp: null`.** When there are no non-reversed bets in the
  window (`total_bet = 0`), the ratio is undefined, reported as `null` rather
  than `0` or an error. The group still appears (e.g. wins-only) with its totals.
- **Half-open `[from, to)` window.** `from` is inclusive, `to` is exclusive. This
  lets a caller partition a timeline into adjacent windows (`…to = T` then
  `from = T…`) with no overlap and no gap: a row stamped exactly at `T` is counted
  by exactly one of them. An inclusive-both-ends window would double-count it.
- **Keyset (cursor) pagination, not offset/limit.** Offset scans and discards the
  skipped rows, degrading as you page deeper across billions of rows. We order by
  the group key — (`currency`, `user_id`) per-user, `currency` casino-wide — and
  the cursor encodes the last row's key; the next page adds a row-value predicate
  (`(currency, user_id) > (…)`). Note this trims only the _emitted_ result rows on
  later pages — it is **not** a fresh indexed seek into the raw table. The query
  groups and aggregates over the whole in-window row set every page (the only
  index is on `created_at`, not the group key), then the keyset predicate filters
  the grouped output. So a page is O(in-window rows), not O(page); the keyset
  buys stable, gap-free paging, not a cheaper scan. The cursor is an opaque
  base64url token (the client echoes it back verbatim); its shape is an
  implementation detail we are free to change.
- **Single windowed scan with FILTER aggregates.** Both the non-reversed sums and
  the reversed sums come from one pass over the window (`count(*)`/`sum(amount)
FILTER (WHERE …)`), so there is no second query and no rollback anti-join.
- **Supporting index.** Migration `003` adds a partial index
  `transactions (created_at) WHERE type IN ('bet', 'win')` to make the window
  scan selective without indexing the `rollback` rows the report never reads.

**Limitation:** a per-user aggregate over a very large window inherently scans
every matching row in that window — the index bounds the range but does not make
an enormous span cheap. A production system would maintain a rollup /
materialized per-period summary and read the report from that. That is out of
scope for this take-home and accepted as a known limitation.

## RTP game runner

`pnpm gamerunner` plays an arbitrary number of randomized rounds for an arbitrary
number of users against the **live** `/process` endpoint, then calls the RTP
report for the same time window and prints a pass/fail summary.

```sh
# 1) start Postgres + the API (e.g. docker compose up, or `pnpm dev`)
# 2) point the runner at it and play
pnpm gamerunner                                   # 50 users × 200 rounds (defaults)
pnpm gamerunner --users=1000 --rounds=5000        # bigger run
pnpm gamerunner --seed=42 --url=http://localhost:3000
```

It seeds the players first by reusing the existing `seedWallets` tooling (direct
wallet inserts, so the bootstrap liquidity never pollutes RTP), then submits one
signed `bet` (+ optional `win`) batch per round, then verifies the global RTP.

**RTP distribution.** Each round is a `bet` followed by a _probabilistic_ win —
never a flat "pay 95% of the bet". With probability `p = 0.8` the round wins and
pays `bet × U`, where `U` is **uniform on `[0, 2·0.95/p]` = `[0, 2.375]`**; with
probability `1 − p` it pays nothing. The expected payout is therefore

```
E[payout] = p · bet · E[U] = p · bet · (0.95 / p) = 0.95 · bet,
```

so the **expected** RTP is exactly `0.95` while each round's realized payout
carries genuine variance (zero on a loss, up to `2.375×` the bet on a win). By
the law of large numbers the **observed** global RTP converges to `0.95` as the
sample grows; per-user RTPs show real spread, which the runner surfaces as a
`min`/`max` band. `p = 0.8` (vs a coin-flip) keeps meaningful per-round variance
while converging fast enough that a few thousand rounds already land inside the
tolerance — useful for a deterministic CI test.

**Determinism.** All randomness — bet sizes, the win coin-flip, the win
multiplier, and every `action_id`/`game_id` UUID — is drawn from a single
**seedable** `mulberry32` RNG injected as a tiny `Rng = () => number` function
(the same injection convention as the seeder's clock/PRNG). Two runs with the
same `--seed` submit byte-identical traffic and produce identical totals, which
the functional test asserts directly.

**Verification & tolerance.** After the run, the runner reads the casino-wide RTP
report for `[from, to)` (the window is widened by ±1s to absorb client/DB clock
skew on the server-stamped `created_at`) and checks
`|observed − 0.95| ≤ tolerance`. The default tolerance is **±0.01 (±1%)**,
matching the spec; it exits `0` on pass and `1` on fail. The convergence test
uses a looser **±0.02** because an 8 000-round sample (kept small so the test is
fast) has more sampling noise than a production-scale run — at ~80 000 rounds the
same seeds already sit inside ±0.01.

**Config knobs** (CLI flag wins over env var wins over default):

| Flag          | Env            | Default    | Meaning                                       |
| ------------- | -------------- | ---------- | --------------------------------------------- |
| `--users`     | `GR_USERS`     | `50`       | Distinct players (each seeded with a balance) |
| `--rounds`    | `GR_ROUNDS`    | `200`      | Rounds per user (total = users × rounds)      |
| `--currency`  | `GR_CURRENCY`  | `USD`      | One of `USD`, `EUR`, `BRL`, `GBP`             |
| `--bet-min`   | `GR_BET_MIN`   | `10`       | Min bet size, minor units (drawn per round)   |
| `--bet-max`   | `GR_BET_MAX`   | `100`      | Max bet size, minor units                     |
| `--seed`      | `GR_SEED`      | `1`        | RNG seed (deterministic runs)                 |
| `--tolerance` | `GR_TOLERANCE` | `0.01`     | Max abs deviation of global RTP from `0.95`   |
| `--balance`   | `GR_BALANCE`   | auto       | Fixed start balance; auto-sized if omitted    |
| `--prefix`    | `GR_PREFIX`    | `gr-user-` | Generated player-id prefix                    |
| `--url`       | `GR_BASE_URL`  | `:$PORT`   | Base URL of the running API                   |

**Assumptions.** The runner only exercises bets and wins (no rollbacks /
duplicates, per the spec). Start balances are auto-sized to cover the worst-case
losing streak (`rounds × max-bet × 3`) so the non-negative-balance guard never
trips mid-run; pass `--balance` to override.
