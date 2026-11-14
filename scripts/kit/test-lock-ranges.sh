#!/usr/bin/env bash
# Self-test uses fixtures and an isolated Git repository; installs remain offline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="${ROOT}/scripts/kit/check-lock-ranges.ts"
[[ -f "$SCANNER" ]] || { echo "FAIL: missing $SCANNER" >&2; exit 1; }

PASS=0
FAIL=0
assert_case() {
  local name="$1" expected="$2" tree="$3"
  shift 3
  local output rc=0 missing="" marker
  output="$(LOCK_RANGES_ROOT="$tree" bun "$SCANNER" 2>&1)" || rc=$?
  if [[ "$rc" -ne "$expected" ]]; then
    missing+=" rc=$rc"
  fi
  for marker in "$@"; do
    if [[ "$output" != *"$marker"* ]]; then
      missing+=" missing=$(printf '%q' "$marker")"
    fi
  done
  if [[ -z "$missing" ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (expected rc=$expected;$missing)" >&2
    echo "$output" >&2
    FAIL=$((FAIL + 1))
  fi
}

write_lock() {
  local tree="$1"
  mkdir -p "$tree"
  cat >"$tree/bun.lock"
}

TMP="$(mktemp -d -t lock-ranges.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "== Lock ranges self-test =="

CLEAN="$TMP/clean"
write_lock "$CLEAN" <<'EOF'
{
  "lockfileVersion": 1,
  // bun.lock is JSONC: comments and trailing commas are legal.
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "left-pad": "^1.0.0",
        "@kit/ui": "workspace:*",
      },
    },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "@tanstack/react-hotkeys": "^0.12.0",
      },
    },
  },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-fixture"],
    "@tanstack/react-hotkeys": ["@tanstack/react-hotkeys@0.12.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "clean tree" 0 "$CLEAN" \
  "check-lock-ranges: OK (2 workspace(s), 2 range(s) checked, 1 skipped)"

HOISTED="$TMP/hoisted-outside"
write_lock "$HOISTED" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
    },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "@tanstack/react-hotkeys": "^0.10.0",
      },
    },
  },
  "packages": {
    "@tanstack/react-hotkeys": ["@tanstack/react-hotkeys@0.12.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "hoisted resolution outside workspace range" 1 "$HOISTED" \
  "apps/acme-web" \
  "@tanstack/react-hotkeys" \
  "^0.10.0" \
  "0.12.0" \
  'run `bun update @tanstack/react-hotkeys` from apps/acme-web' \
  "check-lock-ranges: FAIL (1 finding(s))"

# A range never installs another package: an in-range version under another name is no proof.
FOREIGN="$TMP/foreign-name"
write_lock "$FOREIGN" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": { "left-pad": "^1.0.0" },
    },
  },
  "packages": {
    "left-pad": ["right-pad@1.3.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "a lock entry naming another package fails" 1 "$FOREIGN" \
  "lock entry is package right-pad, not left-pad" \
  "check-lock-ranges: FAIL (1 finding(s))"

# npm and Bun accept a space after an operator (`>= 1.0.0`): it is a range, judged like `>=1.0.0`.
SPACED="$TMP/spaced-comparator"
write_lock "$SPACED" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": { "left-pad": ">= 1.0.0 < 2", "right-pad": "^ 2.0.0" },
    },
  },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-fixture"],
    "right-pad": ["right-pad@1.3.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "a spaced comparator is a range" 1 "$SPACED" \
  'right-pad spec "^ 2.0.0" resolved 1.3.0; does not satisfy the range' \
  "check-lock-ranges: FAIL (1 finding(s))"

NESTED="$TMP/nested-wins"
write_lock "$NESTED" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "@tanstack/react-hotkeys": "^0.10.0",
      },
    },
  },
  "packages": {
    "@tanstack/react-hotkeys": ["@tanstack/react-hotkeys@0.12.0", "", {}, "sha512-hoisted"],
    "acme-web/@tanstack/react-hotkeys": ["@tanstack/react-hotkeys@0.10.1", "", {}, "sha512-nested"],
  },
}
EOF
assert_case "nested in-range wins over hoisted out-of-range" 0 "$NESTED" \
  "check-lock-ranges: OK (2 workspace(s), 1 range(s) checked, 0 skipped)"

OVERRIDE_OK="$TMP/override-admits"
write_lock "$OVERRIDE_OK" <<'EOF'
{
  "lockfileVersion": 1,
  "overrides": {
    "vite": "^8.3.0",
  },
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "vite": "^8.3.1",
      },
    },
  },
  "packages": {
    "vite": ["vite@8.3.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "root override admits a version the declared range rejects" 0 "$OVERRIDE_OK" \
  "check-lock-ranges: OK (1 workspace(s), 1 range(s) checked, 0 skipped)"

OVERRIDE_BAD="$TMP/override-rejects"
write_lock "$OVERRIDE_BAD" <<'EOF'
{
  "lockfileVersion": 1,
  "overrides": {
    "vite": "^7.0.0",
  },
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "vite": "^8.3.0",
      },
    },
  },
  "packages": {
    "vite": ["vite@8.3.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "root override rejects the resolved version" 1 "$OVERRIDE_BAD" \
  "(override)" \
  "^7.0.0" \
  "8.3.0" \
  "fix the override or the lock" \
  "check-lock-ranges: FAIL (1 finding(s))"

DEV="$TMP/dev"
write_lock "$DEV" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "packages/ui": {
      "name": "@kit/ui",
      "devDependencies": {
        "vitest": "^4.0.0",
      },
    },
  },
  "packages": {
    "vitest": ["vitest@5.0.2", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "devDependencies are checked" 1 "$DEV" \
  "packages/ui devDependencies: vitest" \
  "^4.0.0" \
  "5.0.2" \
  'run `bun update vitest` from packages/ui'

OPTIONAL="$TMP/optional"
write_lock "$OPTIONAL" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "optionalDependencies": {
        "fsevents": "^1.0.0",
      },
    },
  },
  "packages": {
    "fsevents": ["fsevents@2.3.3", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "optionalDependencies are checked" 1 "$OPTIONAL" \
  "apps/acme-web optionalDependencies: fsevents" \
  "^1.0.0" \
  "2.3.3" \
  'run `bun update fsevents` from apps/acme-web'

WORKSPACE="$TMP/workspace-protocol"
write_lock "$WORKSPACE" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "@kit/ui": "workspace:*",
        "zod": "1.0.0",
      },
    },
  },
  "packages": {
    "zod": ["zod@1.0.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "workspace:* spec is skipped" 0 "$WORKSPACE" \
  "check-lock-ranges: OK (2 workspace(s), 1 range(s) checked, 1 skipped)"

# npm's prefix-less forms are not ranges: skipped and counted, never "not a checkable range".
prefixless_case() {
  local name="$1" spec="$2" dir="$TMP/prefixless-${3}"
  write_lock "$dir" <<EOF
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "shared": "${spec}",
        "zod": "1.0.0",
      },
    },
  },
  "packages": {
    "zod": ["zod@1.0.0", "", {}, "sha512-fixture"],
  },
}
EOF
  assert_case "${name}" 0 "$dir" \
    "check-lock-ranges: OK (2 workspace(s), 1 range(s) checked, 1 skipped)"
}
prefixless_case "git shorthand owner/repo#ref is skipped" "acme/shared-2#v1.2.0" git
prefixless_case "a path spec is skipped" "../shared-2" path

SHAPE="$TMP/not-a-range"
write_lock "$SHAPE" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "left-pad": "1.0.0 ~~ 2",
      },
    },
  },
  "packages": {
    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-fixture"],
  },
}
EOF
assert_case "a spec that is not a range names a spec rewrite, not bun update" 1 "$SHAPE" \
  'left-pad spec "1.0.0 ~~ 2" resolved <none>; spec is not a checkable range' \
  "write a semver range, or a form this gate skips (scripts/kit/check-lock-ranges.ts header), in apps/acme-web/package.json" \
  "\`bun update\` cannot change a spec's form"

MISSING="$TMP/missing"
write_lock "$MISSING" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture" },
    "apps/acme-web": {
      "name": "acme-web",
      "dependencies": {
        "left-pad": "^1.0.0",
      },
    },
  },
  "packages": {},
}
EOF
assert_case "missing resolution is a finding" 1 "$MISSING" \
  "left-pad" \
  "^1.0.0" \
  "<none>" \
  "lock out of sync" \
  'run `bun update left-pad` from apps/acme-web'

EMPTY="$TMP/no-lock"
mkdir -p "$EMPTY"
assert_case "missing bun.lock" 1 "$EMPTY" "check-lock-ranges: FAIL missing bun.lock"

BAD="$TMP/bad-lock"
mkdir -p "$BAD"
printf '{ not json,\n' >"$BAD/bun.lock"
assert_case "unparseable bun.lock" 1 "$BAD" "check-lock-ranges: FAIL unparseable bun.lock"

NO_ROOT="$TMP/no-root-workspace"
write_lock "$NO_ROOT" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": { "apps/acme-web": { "name": "acme-web", "dependencies": { "zod": "^1.0.0" } } },
  "packages": { "zod": ["zod@1.0.0", "", {}, "sha512-fixture"] },
}
EOF
assert_case "a lock without the root workspace fails" 1 "$NO_ROOT" 'no root workspace ""'

BLIND="$TMP/blind"
write_lock "$BLIND" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "fixture", "dependencies": { "@kit/ui": "workspace:*" } } },
  "packages": {},
}
EOF
assert_case "a scan that checks no range fails" 1 "$BLIND" "no range checked — the scan is blind"

# Bun reads a tree's .env and its bunfig.toml (`preload`, `define`) before the gate's own code runs.
# The real package.json launch line must keep either from re-pointing the gate at a clean decoy while
# the tree's own lock drifts. One tree per channel, so a failure names the channel left open.
decoy_tree() {
  local tree="$1"
  mkdir -p "$tree/scripts/kit" "$tree/config/kit" "$tree/decoy"
  cp "$SCANNER" "$tree/scripts/kit/"
  cp "$ROOT/config/kit/bunfig.gates.toml" "$tree/config/kit/"
  cp "$CLEAN/bun.lock" "$tree/decoy/bun.lock"
  node -e '
    const fs = require("node:fs")
    const launch = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).scripts["lock-ranges:check"]
    fs.writeFileSync(process.argv[2], JSON.stringify({ scripts: { "lock-ranges:check": launch } }))
  ' "$ROOT/package.json" "$tree/package.json"
  write_lock "$tree" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "fixture", "dependencies": { "left-pad": "^1.0.0" } } },
  "packages": { "left-pad": ["left-pad@2.0.0", "", {}, "sha512-fixture"] },
}
EOF
}

assert_not_repointed() {
  local channel="$1" tree="$2" output rc
  output="$(cd "$tree" && env -u LOCK_RANGES_ROOT bun run lock-ranges:check 2>&1)" && rc=0 || rc=$?
  if [[ "$rc" -eq 1 && "$output" == *"check-lock-ranges: FAIL"* && "$output" == *"left-pad"* ]]; then
    echo "PASS: $channel cannot re-point lock-ranges:check"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $channel re-pointed lock-ranges:check (rc=$rc)" >&2
    echo "$output" >&2
    FAIL=$((FAIL + 1))
  fi
}

DOTENV="$TMP/dotenv"
decoy_tree "$DOTENV"
printf 'LOCK_RANGES_ROOT=decoy\n' >"$DOTENV/.env"
assert_not_repointed "a tree .env" "$DOTENV"

BUNFIG="$TMP/bunfig"
decoy_tree "$BUNFIG"
printf 'preload = ["./preload.ts"]\n' >"$BUNFIG/bunfig.toml"
printf 'process.env.LOCK_RANGES_ROOT = "decoy"\n' >"$BUNFIG/preload.ts"
assert_not_repointed "a tree bunfig.toml preload" "$BUNFIG"

NORMALIZATION="$TMP/normalization"
mkdir -p "$NORMALIZATION"
git -C "$ROOT" archive HEAD | tar -x -C "$NORMALIZATION"
cp "$SCANNER" "$NORMALIZATION/scripts/kit/check-lock-ranges.ts"
git -C "$NORMALIZATION" init -q
git -C "$NORMALIZATION" add .
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
git -C "$NORMALIZATION" commit -qm fixture
output="$(cd "$NORMALIZATION" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: committed normalized lock'
  PASS=$((PASS + 1))
else
  echo "FAIL: committed normalized lock: $output" >&2
  FAIL=$((FAIL + 1))
fi
node -e 'const fs = require("node:fs"); const p = process.argv[1]; const s = fs.readFileSync(p, "utf8"); const t = s.replace(/  "trustedDependencies": \[\],\n/, ""); if (s === t) process.exit(1); fs.writeFileSync(p, t)' "$NORMALIZATION/bun.lock"
git -C "$NORMALIZATION" add bun.lock
git -C "$NORMALIZATION" commit -qm mutant
output="$(cd "$NORMALIZATION" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'committed bun.lock changes on install'* ]]; then
  echo 'PASS: committed lock normalization drift detected'
  PASS=$((PASS + 1))
else
  echo "FAIL: committed lock normalization drift (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

echo "== Lock ranges summary: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
