#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
status=0
bun scripts/kit/select-tooling.ts --pre-push "$1" || status=$?
if [ "$status" -eq 0 ]; then
  bun run validate:tooling
elif [ "$status" -ne 1 ]; then
  exit "$status"
fi
