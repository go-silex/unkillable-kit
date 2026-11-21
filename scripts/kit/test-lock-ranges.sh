#!/usr/bin/env bash
# Self-test uses fixtures and an isolated Git repository; installs remain offline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
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
# Hermetic: empty HOME/cache for the whole suite. Stability cases warm SUITE_CACHE later.
SUITE_HOME="$TMP/suite-home"
SUITE_CACHE="$TMP/suite-cache"
mkdir -p "$SUITE_HOME" "$SUITE_CACHE"
export HOME="$SUITE_HOME" XDG_CONFIG_HOME="$SUITE_HOME" BUN_INSTALL_CACHE_DIR="$SUITE_CACHE"

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
  mkdir -p "$tree/scripts/kit/lib" "$tree/config/kit" "$tree/decoy"
  git -C "$tree" init -q
  cp "$SCANNER" "$tree/scripts/kit/"
  cp "$ROOT/scripts/kit/lib/jsonc-strict.ts" "$tree/scripts/kit/lib/"
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

export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

commit_tree() {
  local tree="$1" msg="$2"
  git -C "$tree" init -q
  git -C "$tree" add .
  git -C "$tree" commit -qm "$msg"
}

copy_scanner() {
  local tree="$1"
  mkdir -p "$tree/scripts/kit/lib"
  cp "$SCANNER" "$tree/scripts/kit/check-lock-ranges.ts"
  cp "$ROOT/scripts/kit/lib/jsonc-strict.ts" "$tree/scripts/kit/lib/jsonc-strict.ts"
}

run_check() {
  local tree="$1"
  shift
  (cd "$tree" && env -u LOCK_RANGES_ROOT "$@" bun scripts/kit/check-lock-ranges.ts)
}

HOIST="$TMP/hoist-stable"
python3 "$ROOT/scripts/kit/lib/build-hoist-fixture.py" "$HOIST" "$SUITE_CACHE" "$SCANNER"
printf '%s\n' 'node_modules/' '.pkg/' '.hermetic-home/' >"$HOIST/.gitignore"
rm -rf "$HOIST/node_modules" "$HOIST"/apps/*/node_modules "$HOIST/.pkg" "$HOIST/.hermetic-home"
copy_scanner "$HOIST"
commit_tree "$HOIST" hoist-stable

warm_start=$(date +%s%N)
output="$(run_check "$HOIST" 2>&1)" && rc=0 || rc=$?
warm_end=$(date +%s%N)
warm_ms=$(( (warm_end - warm_start) / 1000000 ))
if [[ "$rc" -eq 0 && "$output" == *'check-lock-ranges: OK'* ]]; then
  echo "PASS: hoisting-only layout accepted (${warm_ms}ms warm)"
  PASS=$((PASS + 1))
else
  echo "FAIL: hoist accept (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi
printf '%s\n' "$warm_ms" >"$TMP/probe-warm-ms.txt"

# go-silex/unkillable-kit#42: missing trustedDependencies on the loopback fixture
TRUST="$TMP/trust-rewrite"
rm -rf "$TRUST"
cp -a "$HOIST" "$TRUST"
node -e 'const fs=require("fs"); const p=process.argv[1]; const s=fs.readFileSync(p,"utf8"); const t=s.replace(/  "trustedDependencies": \[\],\n/,""); if(t===s) process.exit(1); fs.writeFileSync(p,t)' "$TRUST/bun.lock"
git -C "$TRUST" add bun.lock && git -C "$TRUST" commit -qm trust-mutant
output="$(run_check "$TRUST" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: missing trustedDependencies fails on rewrite'
  PASS=$((PASS + 1))
else
  echo "FAIL: missing trustedDependencies (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# go-silex/unkillable-kit#42: removed tracked workspace manifest
MISSING_WS="$TMP/missing-workspace"
rm -rf "$MISSING_WS"
cp -a "$HOIST" "$MISSING_WS"
rm -f "$MISSING_WS/apps/a/package.json"
git -C "$MISSING_WS" add -A && git -C "$MISSING_WS" commit -qm missing-a
output="$(run_check "$MISSING_WS" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: removed tracked workspace manifest fails on rewrite'
  PASS=$((PASS + 1))
else
  echo "FAIL: removed workspace manifest (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

PROBE_MUTANT="$TMP/probe-mutant"
rm -rf "$PROBE_MUTANT"
cp -a "$TRUST" "$PROBE_MUTANT"
node -e '
const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
const t=s.replace("checkStability(root, tree)","/* stability probe deleted */");
if(t===s) process.exit(1); fs.writeFileSync(p,t);
' "$PROBE_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(run_check "$PROBE_MUTANT" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: deleting stability probe mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: probe-deleted mutant still failed (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

for mode in literal escaped nested; do
  DUP="$TMP/dup-$mode"
  rm -rf "$DUP"
  cp -a "$HOIST" "$DUP"
  node "$ROOT/scripts/kit/lib/inject-lock-duplicate.mjs" "$DUP/bun.lock" "$mode"
  git -C "$DUP" add bun.lock && git -C "$DUP" commit -qm "dup-$mode"
  # Verdict must not depend on TMPDIR: escaped case under node_modules/.cache/tmp
  if [[ "$mode" == escaped ]]; then
    bad_tmp="$DUP/node_modules/.cache/tmp"
    mkdir -p "$bad_tmp"
    output="$(cd "$DUP" && env -u LOCK_RANGES_ROOT TMPDIR="$bad_tmp" bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
  else
    output="$(run_check "$DUP" 2>&1)" && rc=0 || rc=$?
  fi
  if [[ "$rc" -eq 1 && "$output" == *'ambiguous bun.lock'* ]]; then
    echo "PASS: duplicate keys refused ($mode)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: duplicate keys $mode (rc=$rc): $output" >&2
    FAIL=$((FAIL + 1))
  fi
done

# Malformed JSONC fails closed
BAD="$TMP/bad-jsonc"
rm -rf "$BAD"
cp -a "$HOIST" "$BAD"
printf '{ "lockfileVersion": 1, "workspaces": { "", },\n' >"$BAD/bun.lock"
git -C "$BAD" add bun.lock && git -C "$BAD" commit -qm bad
output="$(run_check "$BAD" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'unparseable bun.lock'* ]]; then
  echo 'PASS: malformed JSONC fails closed'
  PASS=$((PASS + 1))
else
  echo "FAIL: malformed JSONC (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

DUP_MUTANT="$TMP/dup-mutant"
rm -rf "$DUP_MUTANT"
cp -a "$TMP/dup-literal" "$DUP_MUTANT"
node -e '
const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
let t=s.replace(/[ \t]*if \(tree\) assertLockShape\(lockText\)\n/g,"");
t=t.replace(/[ \t]*assertLockShape\(lockText\)\n/g,"");
t=t.replace(/[ \t]*assertLockShape\(lockText\)\n/g,"");
if(t===s||/assertLockShape\(lockText\)/.test(t)) process.exit(1);
fs.writeFileSync(p,t);
' "$DUP_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(run_check "$DUP_MUTANT" 2>&1)" && rc=0 || rc=$?
if [[ "$output" != *'ambiguous bun.lock'* ]]; then
  echo 'PASS: no-strict-key mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: no-strict-key mutant survived: $output" >&2
  FAIL=$((FAIL + 1))
fi

# Empty required cache fail-closed
EMPTY_CACHE="$TMP/empty-cache-tree"
rm -rf "$EMPTY_CACHE" "$TMP/empty-cache-dir"
cp -a "$HOIST" "$EMPTY_CACHE"
mkdir -p "$TMP/empty-cache-dir"
output="$(cd "$EMPTY_CACHE" && env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$TMP/empty-cache-dir" bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'warm the Bun cache'* ]]; then
  echo 'PASS: empty required cache fails closed with warming guidance'
  PASS=$((PASS + 1))
else
  echo "FAIL: empty cache (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# HOME/.bunfig.toml frozenLockfile must not hide go-silex/unkillable-kit#42
FROZEN_HOME="$TMP/frozen-home"
rm -rf "$FROZEN_HOME"
mkdir -p "$FROZEN_HOME"
printf '%s\n' '[install]' 'frozenLockfile = true' >"$FROZEN_HOME/.bunfig.toml"
output="$(cd "$TRUST" && env -u LOCK_RANGES_ROOT HOME="$FROZEN_HOME" XDG_CONFIG_HOME="$FROZEN_HOME" BUN_INSTALL_CACHE_DIR="$SUITE_CACHE" bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: HOME frozenLockfile cannot hide trustedDependencies rewrite'
  PASS=$((PASS + 1))
else
  echo "FAIL: HOME frozenLockfile bypass (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Canonical lock refusals: CR, BOM, comment, CR-terminated comment+duplicate
for kind in cr bom comment crdup; do
  CANON="$TMP/canon-$kind"
  rm -rf "$CANON"
  cp -a "$HOIST" "$CANON"
  case "$kind" in
    cr) python3 -c 'from pathlib import Path; p=Path("'"$CANON"'/bun.lock"); p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))' ;;
    bom) python3 -c 'from pathlib import Path; p=Path("'"$CANON"'/bun.lock"); p.write_bytes(b"\xef\xbb\xbf"+p.read_bytes())' ;;
    comment) python3 -c 'from pathlib import Path; p=Path("'"$CANON"'/bun.lock"); t=p.read_text(); p.write_text(t.replace("{", "{\n  // comment", 1))' ;;
    crdup) python3 -c 'from pathlib import Path; p=Path("'"$CANON"'/bun.lock"); t=p.read_text();
# duplicate packages key after a CR-terminated comment (Bun would hide it; we refuse)
needle='"'"'"packages":'"'"'
i=t.find(needle)
assert i>0
inj="// hide\r  \"packages\": {},\n  "
p.write_text(t[:i]+inj+t[i:])' ;;
  esac
  git -C "$CANON" add bun.lock && git -C "$CANON" commit -qm "canon-$kind"
  output="$(run_check "$CANON" 2>&1)" && rc=0 || rc=$?
  if [[ "$rc" -eq 1 && "$output" == *'not in the form Bun writes'* ]]; then
    echo "PASS: non-canonical lock refused ($kind)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: canonical $kind (rc=$rc): $output" >&2
    FAIL=$((FAIL + 1))
  fi
done

# Write-suppression canary: each suppressing bunfig must fail; root-level frozen must pass
base_bunfig="$(cat "$HOIST/bunfig.toml")"
reg=$(printf '%s' "$base_bunfig" | sed -n 's/.*registry = "\([^"]*\)".*/\1/p' | head -1)
write_suppress_fig() {
  local dest="$1" kind="$2"
  case "$kind" in
    frozen) printf '%s\nfrozenLockfile = true\n' "$base_bunfig" >"$dest" ;;
    quoted) printf '%s' "$base_bunfig" | sed 's/\[install\]/[install]\n"frozenLockfile" = true/' >"$dest" ;;
    dotted) printf 'install.registry = "%s"\ninstall.minimumReleaseAge = 259200\ninstall.frozenLockfile = true\n' "$reg" >"$dest" ;;
    inline) printf 'install = { frozenLockfile = true, registry = "%s", minimumReleaseAge = 259200 }\n' "$reg" >"$dest" ;;
    dry) printf '%s\ndryRun = true\n' "$base_bunfig" >"$dest" ;;
    savefalse) printf '[install.lockfile]\nsave = false\n%s' "$base_bunfig" >"$dest" ;;
    *) return 1 ;;
  esac
}
for kind in frozen quoted dotted inline dry savefalse; do
  SUP="$TMP/suppress-$kind"
  rm -rf "$SUP"
  cp -a "$HOIST" "$SUP"
  write_suppress_fig "$SUP/bunfig.toml" "$kind"
  git -C "$SUP" add bunfig.toml && git -C "$SUP" commit -qm "suppress-$kind"
  canary_start=$(date +%s%N)
  output="$(run_check "$SUP" 2>&1)" && rc=0 || rc=$?
  canary_end=$(date +%s%N)
  canary_ms=$(( (canary_end - canary_start) / 1000000 ))
  if [[ "$rc" -eq 1 && "$output" == *'suppresses lock writes'* ]]; then
    echo "PASS: write-suppression detected ($kind) (${canary_ms}ms)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: suppress $kind (rc=$rc): $output" >&2
    FAIL=$((FAIL + 1))
  fi
done
printf '%s\n' "$canary_ms" >"$TMP/canary-ms.txt"

ROOT_FROZEN="$TMP/root-frozen"
rm -rf "$ROOT_FROZEN"
cp -a "$HOIST" "$ROOT_FROZEN"
printf 'frozenLockfile = true\n%s' "$base_bunfig" >"$ROOT_FROZEN/bunfig.toml"
git -C "$ROOT_FROZEN" add bunfig.toml && git -C "$ROOT_FROZEN" commit -qm root-frozen
output="$(run_check "$ROOT_FROZEN" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: root-level frozenLockfile ignored (not refused)'
  PASS=$((PASS + 1))
else
  echo "FAIL: root frozenLockfile (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# export-ignore on a new workspace absent from the lock must fail
EXPORT_IGNORE="$TMP/export-ignore"
rm -rf "$EXPORT_IGNORE"
cp -a "$HOIST" "$EXPORT_IGNORE"
mkdir -p "$EXPORT_IGNORE/apps/d"
printf '%s\n' '{"name":"d","dependencies":{"kit-pin":"1.0.1"}}' >"$EXPORT_IGNORE/apps/d/package.json"
printf '%s\n' 'apps/d/ export-ignore' >"$EXPORT_IGNORE/.gitattributes"
git -C "$EXPORT_IGNORE" add -A && git -C "$EXPORT_IGNORE" commit -qm export-ignore
output="$(run_check "$EXPORT_IGNORE" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: export-ignore workspace still present in probe and fails'
  PASS=$((PASS + 1))
else
  echo "FAIL: export-ignore (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Raw checkout: eol=crlf, ident, custom smudge — snapshot bytes equal blobs
ATTRS="$TMP/raw-attrs"
rm -rf "$ATTRS"
cp -a "$HOIST" "$ATTRS"
printf '%s\n' 'bun.lock text eol=crlf' 'apps/a/package.json ident' >"$ATTRS/.gitattributes"
# custom smudge via local config + attributes
printf '%s\n' 'secret.txt filter=kitcanary' >>"$ATTRS/.gitattributes"
printf 'plain\n' >"$ATTRS/secret.txt"
git -C "$ATTRS" add -A
# Ensure CRLF is stored as committed bytes for bun.lock: force LF in index first then...
# Commit current LF lock with eol=crlf attr; materialize must still equal blob (LF), not working-tree conversion.
git -C "$ATTRS" commit -qm attrs
blob_lock=$(git -C "$ATTRS" rev-parse HEAD:bun.lock)
blob_pkg=$(git -C "$ATTRS" rev-parse HEAD:apps/a/package.json)
blob_secret=$(git -C "$ATTRS" rev-parse HEAD:secret.txt)
# Configure a smudge that would rewrite secret.txt if filters ran
git -C "$ATTRS" config filter.kitcanary.smudge 'sed s/plain/SMUDGED/'
git -C "$ATTRS" config filter.kitcanary.clean cat
# Materialize the way the probe does
mat=$(mktemp -d)
idx="$mat/index"
snap="$mat/tree"
mkdir -p "$snap"
EMPTY=$(git -C "$ATTRS" hash-object -t tree --stdin </dev/null)
GIT_INDEX_FILE="$idx" GIT_NO_LAZY_FETCH=1 GIT_ATTR_NOSYSTEM=1 \
  git -C "$ATTRS" --attr-source="$EMPTY" -c core.attributesFile=/dev/null read-tree HEAD
GIT_INDEX_FILE="$idx" GIT_NO_LAZY_FETCH=1 GIT_ATTR_NOSYSTEM=1 \
  git -C "$ATTRS" --attr-source="$EMPTY" -c core.attributesFile=/dev/null -c core.autocrlf=false -c core.symlinks=false \
  checkout-index -a -f --prefix="$snap/"
ok=1
cmp -s <(git -C "$ATTRS" cat-file blob "$blob_lock") "$snap/bun.lock" || ok=0
cmp -s <(git -C "$ATTRS" cat-file blob "$blob_pkg") "$snap/apps/a/package.json" || ok=0
cmp -s <(git -C "$ATTRS" cat-file blob "$blob_secret") "$snap/secret.txt" || ok=0
# ident must not expand; secret must not be smudged
if grep -q '\$Id\$' "$ATTRS/apps/a/package.json" 2>/dev/null; then :; fi
if [[ "$ok" -eq 1 ]]; then
  echo 'PASS: raw checkout keeps blob bytes (eol=crlf, ident, smudge)'
  PASS=$((PASS + 1))
else
  echo "FAIL: raw checkout converted bytes" >&2
  FAIL=$((FAIL + 1))
fi
rm -rf "$mat"
# Also run the check on ATTRS — should still pass (same lock bytes)
git -C "$ATTRS" add -A && git -C "$ATTRS" commit -qm attrs-config --allow-empty
output="$(run_check "$ATTRS" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: eol=crlf/ident tree still install-stable'
  PASS=$((PASS + 1))
else
  echo "FAIL: attrs stability (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Pivot symlink chain: verdict independent of external target
SYMLINK="$TMP/symlink-chain"
rm -rf "$SYMLINK"
cp -a "$HOIST" "$SYMLINK"
# apps/b/package.json -> pivot/../../b.json and apps/b/pivot -> ../..
rm -f "$SYMLINK/apps/b/package.json"
ln -s 'pivot/../../b.json' "$SYMLINK/apps/b/package.json"
ln -s '../..' "$SYMLINK/apps/b/pivot"
# External file the chain would resolve to if followed
printf '%s\n' '{"name":"b","dependencies":{"kit-pin":"9.9.9"}}' >"$SYMLINK/../b.json"
git -C "$SYMLINK" add -A && git -C "$SYMLINK" commit -qm symlink-chain
output1="$(run_check "$SYMLINK" 2>&1)" && rc1=0 || rc1=$?
# Flip external file
printf '%s\n' '{"name":"b","dependencies":{"kit-pin":"1.0.0"}}' >"$SYMLINK/../b.json"
output2="$(run_check "$SYMLINK" 2>&1)" && rc2=0 || rc2=$?
if [[ "$rc1" -eq "$rc2" ]]; then
  echo "PASS: symlink pivot chain verdict independent of external file (rc=$rc1)"
  PASS=$((PASS + 1))
else
  echo "FAIL: symlink pivot depended on external (rc1=$rc1 rc2=$rc2)"$'\n'"$output1"$'\n'"---"$'\n'"$output2" >&2
  FAIL=$((FAIL + 1))
fi

# .env selects populated cache while default cache empty — check must pass
DOTENV_CACHE="$TMP/dotenv-cache-select"
rm -rf "$DOTENV_CACHE" "$TMP/populated-cache" "$TMP/empty-default-cache"
cp -a "$HOIST" "$DOTENV_CACHE"
# Warm a private cache by copying suite cache
cp -a "$SUITE_CACHE" "$TMP/populated-cache"
mkdir -p "$TMP/empty-default-cache" "$DOTENV_CACHE/.hermetic-home"
# Point .env at populated cache; leave BUN_INSTALL_CACHE_DIR unset so default would be empty home cache
printf 'BUN_INSTALL_CACHE_DIR=%s\n' "$TMP/populated-cache" >"$DOTENV_CACHE/.env"
git -C "$DOTENV_CACHE" add .env && git -C "$DOTENV_CACHE" commit -qm dotenv-cache
# Run with empty default: unset BUN_INSTALL_CACHE_DIR, HOME with empty .bun
empty_home="$TMP/empty-default-home"
rm -rf "$empty_home"
mkdir -p "$empty_home"
output="$(cd "$DOTENV_CACHE" && env -u LOCK_RANGES_ROOT -u BUN_INSTALL_CACHE_DIR HOME="$empty_home" XDG_CONFIG_HOME="$empty_home" bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: .env-selected cache used when default cache is empty'
  PASS=$((PASS + 1))
else
  echo "FAIL: .env cache select (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Large tracked file streams (no in-memory buffer limit)
LARGE="$TMP/large-file"
rm -rf "$LARGE"
cp -a "$HOIST" "$LARGE"
dd if=/dev/zero of="$LARGE/big.bin" bs=1M count=4 status=none
git -C "$LARGE" add big.bin && git -C "$LARGE" commit -qm large
output="$(run_check "$LARGE" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: large tracked file streams through materialize'
  PASS=$((PASS + 1))
else
  echo "FAIL: large file (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# lockfile-only mutant
LOCKFILE_ONLY_MUTANT="$TMP/lockfile-only-mutant"
rm -rf "$LOCKFILE_ONLY_MUTANT"
cp -a "$HOIST" "$LOCKFILE_ONLY_MUTANT"
node -e '
const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
const from="['\''--no-env-file'\'', '\''install'\'', '\''--offline'\'', '\''--ignore-scripts'\'', '\''--cache-dir'\'', cacheDir]";
const to="['\''--no-env-file'\'', '\''install'\'', '\''--lockfile-only'\'', '\''--offline'\'', '\''--ignore-scripts'\'', '\''--cache-dir'\'', cacheDir]";
const t=s.replace(from,to); if(t===s) process.exit(1); fs.writeFileSync(p,t);
' "$LOCKFILE_ONLY_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(run_check "$LOCKFILE_ONLY_MUTANT" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: --lockfile-only comparison mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: lockfile-only mutant (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

cold_cache="$TMP/hoist-cache-cold"
rm -rf "$cold_cache"
mkdir -p "$cold_cache"
cold_start=$(date +%s%N)
output="$(cd "$HOIST" && env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$cold_cache" bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
cold_end=$(date +%s%N)
cold_ms=$(( (cold_end - cold_start) / 1000000 ))
printf '%s\n' "$cold_ms" >"$TMP/probe-cold-ms.txt"
if [[ "$rc" -eq 1 && "$output" == *'warm the Bun cache'* ]]; then
  echo "PASS: cold empty cache fails closed (${cold_ms}ms)"
  PASS=$((PASS + 1))
else
  echo "FAIL: cold cache (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Staged unstable lock vs stable HEAD during an open merge must fail.
STAGED="$TMP/staged-vs-head"
rm -rf "$STAGED"
cp -a "$HOIST" "$STAGED"
# Create a second commit that restores a stable lock, then stage an unstable index during merge-ish write-tree
node -e 'const fs=require("fs"); const p=process.argv[1]; const s=fs.readFileSync(p,"utf8"); const t=s.replace(/  "trustedDependencies": \[\],\n/,""); if(t===s) process.exit(1); fs.writeFileSync(p,t)' "$STAGED/bun.lock"
git -C "$STAGED" add bun.lock && git -C "$STAGED" commit -qm unstable-head
# Now HEAD is unstable. Make a stable staged tree by restoring trustedDependencies in the index only.
cp "$HOIST/bun.lock" "$STAGED/bun.lock"
git -C "$STAGED" add bun.lock
# Simulate open merge: write MERGE_HEAD and keep staged stable? Assignment wants staged unstable, HEAD stable.
git -C "$STAGED" reset --hard HEAD~1 >/dev/null
# HEAD is stable (hoist). Stage unstable lock while MERGE_HEAD present.
node -e 'const fs=require("fs"); const p=process.argv[1]; const s=fs.readFileSync(p,"utf8"); const t=s.replace(/  "trustedDependencies": \[\],\n/,""); if(t===s) process.exit(1); fs.writeFileSync(p,t)' "$STAGED/bun.lock"
git -C "$STAGED" add bun.lock
git -C "$STAGED" rev-parse HEAD >"$STAGED/.git/MERGE_HEAD"
output="$(run_check "$STAGED" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: unstable staged lock fails despite stable HEAD'
  PASS=$((PASS + 1))
else
  echo "FAIL: staged-vs-head (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi
# Mutant: always HEAD instead of staged tree → killed (would pass)
HEAD_MUTANT="$TMP/head-mutant"
rm -rf "$HEAD_MUTANT"
cp -a "$STAGED" "$HEAD_MUTANT"
node -e '
const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
const from="if (!existsSync(resolve(root, merge.stdout.toString().trim()))) return '\''HEAD'\''\n  const tree = spawnSync('\''git'\'', ['\''write-tree'\''], { cwd: root })";
const to="if (!existsSync(resolve(root, merge.stdout.toString().trim()))) return '\''HEAD'\''\n  return '\''HEAD'\''\n  const tree = spawnSync('\''git'\'', ['\''write-tree'\''], { cwd: root })";
const t=s.replace(from,to);
if(t===s) process.exit(1); fs.writeFileSync(p,t);
' "$HEAD_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(run_check "$HEAD_MUTANT" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: always-HEAD mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: always-HEAD mutant still failed (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

echo "== Lock ranges summary: $PASS pass, $FAIL fail =="
echo "probe warm_ms=$(cat "$TMP/probe-warm-ms.txt") cold_ms=$(cat "$TMP/probe-cold-ms.txt")"
echo "suite HOME=$HOME cache=$BUN_INSTALL_CACHE_DIR"
[[ "$FAIL" -eq 0 ]]
