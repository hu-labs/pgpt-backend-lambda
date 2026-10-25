#!/usr/bin/env bash
#
# Typically called by setenv-preview.sh or setenv-production.sh.
#
# Shared loader for the sourced environment wrappers.
# Depends on the local-env.mjs script.

_promptgpt_setenv() {
    local environment="$1" target="${2:-}" script_dir env_file temp_file key value
    # Clear the previous stack even when the new configuration cannot be loaded.
    unset AWS_REGION TEST_API_URL PUBLIC_API_URL TEST_API_KEY \
        COGNITO_USER_POOL_ID COGNITO_CLIENT_ID COGNITO_USERNAME COGNITO_PASSWORD \
        COGNITO_SECOND_USERNAME COGNITO_SECOND_PASSWORD SMOKE_ENVIRONMENT SMOKE_TARGET
    if [[ "$target" != test && "$target" != public ]]; then
        echo "Usage: source scripts/setenv-${environment}.sh test|public" >&2
        return 1
    fi
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || return 1
    env_file="${script_dir}/../../.env.${environment}.local"
    temp_file="$(umask 077; mktemp)" || return 1
    if ! node "$script_dir/local-env.mjs" "$env_file" "$environment" "$target" > "$temp_file"; then
        rm -f -- "$temp_file"
        return 1
    fi
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        export "$key=$value"
    done < "$temp_file"
    rm -f -- "$temp_file"
    printf 'Loaded %s/%s configuration. Credentials are not displayed.\n' "$environment" "$target"
}
