#!/usr/bin/env bash
#
# End-to-end smoke test against the dockerized stack: boots compose, seeds one
# wallet, fires a single HMAC-signed `bet`, and asserts HTTP 200 + a debited
# balance. Proves the compose wiring (build, migrate-on-boot, auth) actually
# works. Usage: ./scripts/smoke.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# HMAC_SECRET must match .env (the value the API container loads).
SECRET="$(grep -E '^HMAC_SECRET=' .env | cut -d= -f2-)"
BASE_URL="http://localhost:3000"
USER_ID="smoke-user-1"
CURRENCY="USD"
BALANCE=1000000
BET_AMOUNT=12345

# Publish Postgres on a free host port so the smoke run never collides with a
# local Postgres or another stack already bound to 5432.
DB_HOST_PORT="$(
  python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'
)"
export DB_HOST_PORT
# Seed runs on the host, so point it at the published port (not .env's default).
export DATABASE_URL="postgres://postgres:postgres@localhost:${DB_HOST_PORT}/yeet"

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# Lowercase-hex HMAC-SHA256 of $1 keyed by $SECRET, over raw bytes.
hmac() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //'; }

# POST a signed JSON body; echoes "<http_status>\n<body>".
signed_post() {
  local body="$1" sig
  sig="$(hmac "$body")"
  curl -sS -o /dev/stdout -w '\n%{http_code}' \
    -X POST "$BASE_URL/aggregator/takehome/process" \
    -H 'content-type: application/json' \
    -H "authorization: HMAC-SHA256 $sig" \
    --data-raw "$body"
}

echo "==> docker compose up"
docker compose up -d --build

echo "==> waiting for API health (db: ok)"
for i in $(seq 1 60); do
  if curl -sf "$BASE_URL/health" 2>/dev/null | grep -q '"db":"ok"'; then
    echo "    healthy after ${i}s"
    break
  fi
  [ "$i" -eq 60 ] && fail "API never became healthy"
  sleep 1
done

echo "==> seeding wallet $USER_ID ($BALANCE $CURRENCY)"
# The seed CLI takes --flag=value (env vars also work); USER_ID = <prefix>1.
pnpm seed --count=1 --prefix=smoke-user- --currency="$CURRENCY" --balance="$BALANCE" >/dev/null

echo "==> reading initial balance"
read_balance() {
  local body resp status payload
  body="{\"user_id\":\"$USER_ID\",\"currency\":\"$CURRENCY\"}"
  resp="$(signed_post "$body")"
  status="$(printf '%s' "$resp" | tail -n1)"
  payload="$(printf '%s' "$resp" | sed '$d')"
  [ "$status" = "200" ] || fail "balance lookup returned $status: $payload"
  printf '%s' "$payload" | grep -oE '"balance":[0-9]+' | cut -d: -f2
}
INITIAL="$(read_balance)"
echo "    initial balance: $INITIAL"
[ "$INITIAL" = "$BALANCE" ] || fail "seeded balance mismatch: got $INITIAL, want $BALANCE"

echo "==> sending one signed bet of $BET_AMOUNT"
ACTION_ID="$(cat /proc/sys/kernel/random/uuid)"
GAME_ID="$(cat /proc/sys/kernel/random/uuid)"
BET_BODY="{\"user_id\":\"$USER_ID\",\"currency\":\"$CURRENCY\",\"game\":\"acceptance:test\",\"game_id\":\"$GAME_ID\",\"actions\":[{\"action\":\"bet\",\"action_id\":\"$ACTION_ID\",\"amount\":$BET_AMOUNT}]}"
RESP="$(signed_post "$BET_BODY")"
STATUS="$(printf '%s' "$RESP" | tail -n1)"
PAYLOAD="$(printf '%s' "$RESP" | sed '$d')"
echo "    HTTP $STATUS: $PAYLOAD"

[ "$STATUS" = "200" ] || fail "bet returned $STATUS (want 200)"

NEW_BALANCE="$(printf '%s' "$PAYLOAD" | grep -oE '"balance":[0-9]+' | cut -d: -f2)"
EXPECTED=$((INITIAL - BET_AMOUNT))
[ "$NEW_BALANCE" = "$EXPECTED" ] \
  || fail "balance did not decrease correctly: got $NEW_BALANCE, want $EXPECTED"
[ "$NEW_BALANCE" -lt "$INITIAL" ] || fail "balance did not decrease"

echo "SMOKE PASS: HTTP 200, balance $INITIAL -> $NEW_BALANCE (-$BET_AMOUNT)"
