#!/usr/bin/env bash
# Run a smoke test against the backend serverless API.
#
# Environment variables:
#
# - SMOKE_TARGET: "test" or "public"
# - SMOKE_ENVIRONMENT: GH environment name e.g. "preview" or "production"
#
# - TEST_API_URL: 'test' API URL
# - TEST_API_KEY: 'test' API key
# - PUBLIC_API_URL: public ('prod') API URL

set -euo pipefail

smoke_target="${SMOKE_TARGET:-}"
smoke_environment="${SMOKE_ENVIRONMENT:-unknown}"

headers=(
    -H "Content-Type: application/json"
)

case "$smoke_target" in
    test)
        if [[ -z "${TEST_API_URL:-}" ]]; then
            echo "TEST_API_URL is missing." >&2
            exit 1
        fi

        if [[ -z "${TEST_API_KEY:-}" ]]; then
            echo "TEST_API_KEY is missing." >&2
            exit 1
        fi

        smoke_url="$TEST_API_URL"
        headers+=(
            -H "X-Api-Key: $TEST_API_KEY"
        )
        ;;

    public)
        if [[ -z "${PUBLIC_API_URL:-}" ]]; then
            echo "PUBLIC_API_URL is missing." >&2
            exit 1
        fi

        smoke_url="$PUBLIC_API_URL"
        ;;

    *)
        echo "Unsupported smoke-test target: ${smoke_target:-<missing>}" >&2
        echo "Expected: test or public" >&2
        exit 1
        ;;
esac

# CI verifies only the authentication boundary. Authenticated CRUD and SSE
# persistence require a real Cognito session and are tested separately.
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
for endpoint in "$smoke_url" "${smoke_url%/chat}/threads"; do
    status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
        -o "$response_file" -w '%{http_code}' \
        -X POST "$endpoint" "${headers[@]}" --data '{}')"
    if [[ "$status" != "401" ]]; then
        echo "Authentication smoke test failed: expected 401, got $status" >&2
        cat "$response_file" >&2
        exit 1
    fi
    node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof (body.message ?? body.error) !== "string") process.exit(1);
' "$response_file"
done
echo "Authentication boundary smoke test passed ($smoke_environment/$smoke_target): chat and threads."
