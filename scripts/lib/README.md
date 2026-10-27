# Local smoke tests

Use Node.js 24 and run `npm ci` from the backend repository root. No AWS CLI
credentials or frontend session are needed for API smoke tests.

## Configuration

Create `.env.preview.local` and `.env.production.local` in the backend root using
[.env.example](../../.env.example). Keep each file private (`chmod 600 .env.*.local`);
Git ignores both. Each file contains that stack's API URLs, API key, Cognito
pool/client IDs, and account credentials. If the local files already exist,
fill in their empty login fields.

Use two confirmed Cognito users from the same environment's user pool:

```dotenv
COGNITO_USERNAME="first-user@example.com"
COGNITO_PASSWORD="first-password"
COGNITO_SECOND_USERNAME="second-user@example.com"
COGNITO_SECOND_PASSWORD="second-password"
```

Quote passwords containing spaces or `#`. Values are parsed as dotenv data, with
no shell expansion. Omit both second-account fields to skip cross-user checks.
Supplying only one second-account field is an error.

Copy connection values from the corresponding Terraform environment's outputs:
`api_gateway_test_url`, `public_api_url`, `api_key_value`,
`cognito_user_pool_id`, and `cognito_client_id`. Keep `/chat` at the end of the
configured URLs. `test` calls API Gateway's `/test` stage with the API key;
`public` calls CloudFront's `/api/v1` path, which injects the API key and routes
to the stable alias. The frontend is not involved.

## Run

From the backend repository root:

```bash
source scripts/setenv-preview.sh test && ./scripts/smoke-test.sh --authenticated
source scripts/setenv-production.sh test && ./scripts/smoke-test.sh --authenticated
```

Replace `test` with `public` to check the stack's CloudFront endpoint. Setup
scripts must be sourced to update the current shell. Every load clears the
previous stack's settings, including on failure. Production tests require the
conversation API infrastructure and backend to be deployed there first.

Authenticated mode signs in through Cognito SRP and keeps tokens in memory for
that process. It does not change Cognito configuration or store session tokens
on disk. Password-change and MFA challenges must be completed through an
interactive login before using these scripts.

The test checks unauthenticated rejection, thread and message CRUD, a short AI
response through SSE, matching persisted message IDs and content, and thread
deletion. When a second account is present, it also checks that thread lists
are isolated and that cross-user reads, writes and chat requests return 404.
Both logins must resolve to different Cognito subject IDs.

Each authenticated run makes one real AI request and creates temporary threads.
The script attempts to delete those threads on completion, failure, or a handled
interrupt. Cleanup failures make the test fail and print the thread IDs for
manual removal. A killed process or an ambiguous network failure can still
leave test data behind; avoid blindly retrying after a dropped connection.

## CI authentication check

Without `--authenticated`, the same script checks only that unauthenticated
`POST /chat` and `POST /threads` requests return JSON with status 401. It does not
log in or create data. Existing GitHub Actions environment variables continue to
work, and CI does not load local dotenv files or need account passwords. This
mode uses only Node.js built-ins and needs no npm dependency installation.
Promotion and rollback workflows select Node.js 24 before running it.

```bash
source scripts/setenv-preview.sh test && ./scripts/smoke-test.sh
```

## Offline verification

`npm run check` includes the mocked script tests. These cover configuration
loading, Cognito callbacks, SSE parsing, persistence assertions, cross-user
checks, and cleanup without calling AWS or OpenAI.
