#!/usr/bin/env bash
#
# Loader for preview environment variables.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    echo "Use: source scripts/setenv-preview.sh test|public" >&2
    exit 1
fi
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/setenv.sh" || return 1
_promptgpt_setenv preview "${1:-}"
