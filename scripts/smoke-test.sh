#!/usr/bin/env bash
#
# Smoke test runner for the backend serverless API.
# Calls lib/smoke-test.mjs with the same arguments.
#
# Load environment variables from setenv-preview.sh or setenv-production.sh first.
#
# Default: CI authentication boundary. --authenticated: local CRUD/SSE checks.
# e.g.
# For local testing:         ./scripts/smoke-test.sh --authenticated
# or for CI:                 ./scripts/smoke-test.sh

set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/lib/smoke-test.mjs" "$@"
