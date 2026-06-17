# AGENTS.md

Guidance for agents (and the code reviewer) working in this repo.

## Project

Yeet Casino bet processor take-home. Node.js + TypeScript service that
processes signed bet/aggregator requests and exposes a health probe.

## Architecture (hexagonal)

- `src/core` — domain entities, errors, and validators. Pure: depends on
  nothing external. Domain errors carry `{ httpStatus, code, message }`.
- `src/adapters/<x>/contracts.ts` — outbound ports (interfaces). Concrete
  implementations live in `src/adapters/<x>/<impl>/` (e.g.
  `adapters/repo/kyselyrepo/`). Adapters translate library/driver errors into
  domain errors so the core stays transport-agnostic.
- `src/apps/<entrypoint>` — inbound adapters: Fastify controllers plus the
  composition root (`main.ts` wires real dependencies, `app.ts` builds the
  Fastify instance). Controllers depend on ports, not concrete clients.
- `src/helpers` — pure, side-effect-free utilities (e.g. `helpers/crypto` for
  HMAC signing).

Import direction: core ← adapters ← apps. Never the reverse.

## Conventions

- Strict TypeScript. NodeNext module resolution: relative imports use the
  `.js` extension.
- No `any`, no non-null assertions, no `as` casts except at a validated
  boundary. No floating promises.
- Domain errors (`src/core/errors.ts`) are mapped to HTTP responses by a single
  central `setErrorHandler` in `app.ts`, which emits `{ code, message }`.

## Testing

- Vitest + a real Postgres via testcontainers (no in-memory fakes for the DB).
- `resetTestDB` truncates tables between tests for deterministic state.
- Integration tests boot the real Fastify server and make real `fetch`
  requests against it.
- Per-test, assertion-relevant **data** flows through a `setup(args)` helper
  (eng-standards `ts-parametrized-test-setup`). Shared infra and invariant
  wiring config (containers, an app whose config no assertion depends on) live
  in `beforeAll`/module constants instead.
- No `mocks.ts`. Use real adapters; inject small function types (clock/RNG)
  when determinism is needed; use `vi.fn()` only to assert calls.

## Commands

- `pnpm dev` — run with watch.
- `pnpm build` — compile to `dist`.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm test` — run the Vitest suite (testcontainers; ~15-20s).
- `pnpm lint` — ESLint.
- `pnpm format` — Prettier write.

## Code review

This project is reviewed against the eng-standards packs `universal` +
`packs/backend-ts` + `packs/testing`. It is a standalone project: it does NOT
use the empresa-digital org profile (it is not a teamcollab repo).
