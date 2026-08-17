#!/usr/bin/env bash
#
# Acceptance check for `GET /health/db`: the native MongoDB driver reaching Atlas from a locally
# running Worker, with no HTTP shim and no Data API in between. This is the platform bet the
# whole runtime decision rests on, so it is verified by running it.
#
# Requires `npm run dev` running, and `.dev.vars` with a `MONGODB_URI` pointing at the
# dev/staging database — never production (workspace Rule 4).
#
#   npm run verify:db
#   npm run verify:db -- https://staging.example/health/db
#
# The body is compared exactly rather than grepped, so a partially-true answer fails.
set -euo pipefail

url="${1:-http://localhost:8080/health/db}"
expected='{"status":"ok","db":true}'

if ! body="$(curl -fsS --max-time 30 "$url")"; then
  echo "verify:db FAILED — $url did not answer 2xx. Response body:" >&2
  curl -sS --max-time 30 "$url" >&2 || true
  echo >&2
  echo "If the code is DB_NOT_CONFIGURED, set MONGODB_URI in .dev.vars and restart the dev server." >&2
  exit 1
fi

if [ "$body" != "$expected" ]; then
  echo "verify:db FAILED — expected $expected, got $body" >&2
  exit 1
fi

echo "verify:db ok — $body"
