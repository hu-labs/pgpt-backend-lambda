#!/usr/bin/env bash
#
# Loader for production environment variables.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    echo "Use: source scripts/setenv-production.sh test|public" >&2
    exit 1
fi
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/setenv.sh" || return 1
_promptgpt_setenv production "${1:-}"
