#!/usr/bin/env bash
# Run a smoke test against the backend serverless API.
#
# Environment variables:
#
# - SMOKE_TARGET: "test" or "public"
# - SMOKE_ENVIRONMENT: GH environment name e.g. "preview" or "production"
# - GITHUB_RUN_ID: Relevant when called in GHA only. Set to "01" if local.
#
# - TEST_API_URL: 'test' API URL
# - TEST_API_KEY: 'test' API key
# - PUBLIC_API_URL: public ('prod') API URL

set -euo pipefail

smoke_target="${SMOKE_TARGET:-}"
smoke_environment="${SMOKE_ENVIRONMENT:-unknown}"
github_run_id="${GITHUB_RUN_ID:-local}"

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

payload="$(
    cat <<JSON
{
  "threadId": "ci-${smoke_environment}-${smoke_target}-${github_run_id}",
  "messages": [
    {
      "role": "user",
      "content": "Say 'Hello test' and nothing else."
    }
  ]
}
JSON
)"

response="$(
    curl --silent --show-error --fail-with-body \
        -X POST "$smoke_url" \
        "${headers[@]}" \
        --data "$payload"
)"

printf '%s' "$response" | node -e '
let data = "";

process.stdin.on("data", chunk => {
    data += chunk;
});

process.stdin.on("end", () => {
    let parsed;

    try {
        parsed = JSON.parse(data);
    } catch {
        console.error("Smoke-test response was not valid JSON:", data);
        process.exit(1);
    }

    const content = parsed.assistant?.content;

    if (!content || !content.includes("Hello test")) {
        console.error("Unexpected smoke-test response:", data);
        process.exit(1);
    }

    console.log("Smoke test passed:", content);
});
'