#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
exec bash scripts/kit/deny-upstream-push.sh "$1" "$2"
