# yeet-bet-processor

WIP, slice 1.

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
