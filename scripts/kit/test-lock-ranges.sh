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
  git -C "$tree" init -q
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

export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

commit_tree() {
  local tree="$1" msg="$2"
  git -C "$tree" init -q
  git -C "$tree" add .
  git -C "$tree" commit -qm "$msg"
}

NORMALIZATION="$TMP/normalization"
mkdir -p "$NORMALIZATION"
git -C "$ROOT" archive HEAD | tar -x -C "$NORMALIZATION"
cp "$SCANNER" "$NORMALIZATION/scripts/kit/check-lock-ranges.ts"
commit_tree "$NORMALIZATION" fixture
output="$(cd "$NORMALIZATION" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: committed install-stable lock'
  PASS=$((PASS + 1))
else
  echo "FAIL: committed install-stable lock: $output" >&2
  FAIL=$((FAIL + 1))
fi

TRUST="$TMP/trust-rewrite"
rm -rf "$TRUST"
cp -a "$NORMALIZATION" "$TRUST"
node -e 'const fs = require("node:fs"); const p = process.argv[1]; const s = fs.readFileSync(p, "utf8"); const t = s.replace(/  "trustedDependencies": \[\],\n/, ""); if (s === t) process.exit(1); fs.writeFileSync(p, t)' "$TRUST/bun.lock"
git -C "$TRUST" add bun.lock
git -C "$TRUST" commit -qm trust-mutant
output="$(cd "$TRUST" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: missing trustedDependencies fails on rewrite'
  PASS=$((PASS + 1))
else
  echo "FAIL: missing trustedDependencies (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

MISSING_WS="$TMP/missing-workspace"
rm -rf "$MISSING_WS"
cp -a "$NORMALIZATION" "$MISSING_WS"
rm -f "$MISSING_WS/apps/starter-web/package.json"
git -C "$MISSING_WS" add -A
git -C "$MISSING_WS" commit -qm missing-starter-web
output="$(cd "$MISSING_WS" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
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
const fs = require("node:fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
const t = s.replace(
  "await checkStability(root, tree)",
  "/* stability probe deleted */",
);
if (t === s) process.exit(1);
fs.writeFileSync(p, t);
' "$PROBE_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(cd "$PROBE_MUTANT" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo 'PASS: deleting stability probe mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: probe-deleted mutant still failed (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

DUP="$TMP/duplicate-keys"
rm -rf "$DUP"
cp -a "$NORMALIZATION" "$DUP"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const text = fs.readFileSync(p, "utf8");
const marker = "\"packages\": {";
const i = text.indexOf(marker);
if (i < 0) process.exit(1);
const after = text.slice(i + marker.length);
const km = after.match(/\n    ("(?:\\.|[^"\\])*"): \[/);
if (!km) process.exit(1);
const lineStart = text.indexOf(km[0], i);
const lineEnd = text.indexOf("\n", lineStart + 1);
const line = text.slice(lineStart, lineEnd);
fs.writeFileSync(p, text.slice(0, lineEnd) + line + text.slice(lineEnd));
' "$DUP/bun.lock"
git -C "$DUP" add bun.lock
git -C "$DUP" commit -qm duplicate-packages-key
output="$(cd "$DUP" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'ambiguous bun.lock'* ]]; then
  echo 'PASS: duplicate packages keys refused'
  PASS=$((PASS + 1))
else
  echo "FAIL: duplicate keys (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

DUP_MUTANT="$TMP/dup-mutant"
rm -rf "$DUP_MUTANT"
cp -a "$DUP" "$DUP_MUTANT"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
let t = s.replace(/[ \t]*if \(tree\) await assertUnambiguousLock\(lockText\)\n/g, "");
t = t.replace(/[ \t]*await assertUnambiguousLock\(lockText\)\n/g, "");
if (t === s || /await assertUnambiguousLock\(/.test(t)) process.exit(1);
fs.writeFileSync(p, t);
' "$DUP_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(cd "$DUP_MUTANT" && env -u LOCK_RANGES_ROOT bun scripts/kit/check-lock-ranges.ts 2>&1)" && rc=0 || rc=$?
# Kill = the 'ambiguous' refusal test would fail (message gone), even if rewrite still fails.
if [[ "$output" != *'ambiguous bun.lock'* ]]; then
  echo 'PASS: no-strict-key mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: no-strict-key mutant survived (still ambiguous): $output" >&2
  FAIL=$((FAIL + 1))
fi

EMPTY_CACHE="$TMP/empty-cache"
rm -rf "$EMPTY_CACHE"
cp -a "$NORMALIZATION" "$EMPTY_CACHE"
empty_cache_dir="$TMP/bun-cache-empty"
empty_home="$TMP/empty-home"
rm -rf "$empty_cache_dir" "$empty_home"
mkdir -p "$empty_cache_dir" "$empty_home"
output="$(
  cd "$EMPTY_CACHE" &&
    env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$empty_cache_dir" HOME="$empty_home" \
      bun scripts/kit/check-lock-ranges.ts 2>&1
)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'warm the Bun cache'* ]]; then
  echo 'PASS: empty required cache fails closed with warming guidance'
  PASS=$((PASS + 1))
else
  echo "FAIL: empty cache (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

# Three-app hoisting layout: ordinary install keeps bytes; --lockfile-only would rewrite.
HOIST="$TMP/hoist-stable"
HOIST_CACHE="$TMP/hoist-cache"
rm -rf "$HOIST" "$HOIST_CACHE"
mkdir -p "$HOIST_CACHE"
cat >"$TMP/build-hoist.py" <<'HOISTPY'
#!/usr/bin/env python3
"""Build a three-app hoisting-stable lock fixture with a loopback registry."""
from __future__ import annotations
import datetime as dt, json, os, shutil, subprocess, sys, tarfile, threading
from base64 import b64encode
from hashlib import sha512
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

root = Path(sys.argv[1]).resolve()
cache = Path(sys.argv[2]).resolve()
scanner = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
extra_files = {}  # filled by callers via env JSON if needed

if root.exists():
    shutil.rmtree(root)
root.mkdir(parents=True)
cache.mkdir(parents=True, exist_ok=True)

bodies: dict[str, bytes] = {}
records: dict[tuple[str, str], dict] = {}
logs: list[str] = []
port_box = {"port": 0}


def make_tgz(name: str, version: str) -> tuple[str, bytes, str]:
    raw = json.dumps({"name": name, "version": version}).encode()
    buf = BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("package/package.json")
        info.size = len(raw)
        tar.addfile(info, BytesIO(raw))
    blob = buf.getvalue()
    path = f"{name}/-/{name}-{version}.tgz"
    integrity = "sha512-" + b64encode(sha512(blob).digest()).decode()
    return path, blob, integrity


for version in ("1.0.0", "1.0.1"):
    path, blob, integrity = make_tgz("kit-pin", version)
    bodies[path] = blob
    records[("kit-pin", version)] = {
        "name": "kit-pin",
        "version": version,
        "dist": {"tarball": "", "integrity": integrity},
    }


class Registry(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: A003
        return

    def do_GET(self):  # noqa: N802
        path = self.path.strip("/")
        logs.append(path)
        if path == "kit-pin":
            versions = ["1.0.0", "1.0.1"]
            obj = {
                "name": "kit-pin",
                "dist-tags": {"latest": "1.0.1"},
                "versions": {},
                "time": {
                    "modified": "2025-01-01T00:00:00.000Z",
                    "created": "2025-01-01T00:00:00.000Z",
                },
            }
            for v in versions:
                meta = json.loads(json.dumps(records[("kit-pin", v)]))
                meta["dist"]["tarball"] = f"http://127.0.0.1:{port_box['port']}/kit-pin/-/kit-pin-{v}.tgz"
                obj["versions"][v] = meta
                obj["time"][v] = "2025-01-01T00:00:00.000Z"
            buf = json.dumps(obj).encode()
            mime = "application/json"
        elif path in bodies:
            buf = bodies[path]
            mime = "application/octet-stream"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(buf)))
        self.end_headers()
        self.wfile.write(buf)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
port_box["port"] = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{port_box['port']}/"

bun_version = subprocess.check_output(["bun", "-v"], text=True).strip()
(root / "package.json").write_text(
    json.dumps(
        {
            "name": "hoist-root",
            "private": True,
            "workspaces": ["apps/*"],
            "trustedDependencies": [],
            "packageManager": f"bun@{bun_version}",
        },
        indent=2,
    )
    + "\n"
)
(root / "bunfig.toml").write_text(f'[install]\nregistry = "{url}"\nminimumReleaseAge = 259200\n')
for app, ver in (("a", "1.0.1"), ("b", "1.0.0"), ("c", "1.0.1")):
    app_dir = root / "apps" / app
    app_dir.mkdir(parents=True)
    (app_dir / "package.json").write_text(json.dumps({"name": app, "dependencies": {"kit-pin": ver}}) + "\n")
if scanner is not None:
    scripts = root / "scripts" / "kit"
    scripts.mkdir(parents=True)
    shutil.copy(scanner, scripts / "check-lock-ranges.ts")

env = {**os.environ, "BUN_INSTALL_CACHE_DIR": str(cache)}


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bun", *args],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )


r = run("install", "--lockfile-only", "--ignore-scripts")
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("initial lockfile-only failed")

lock = json.loads(
    subprocess.check_output(
        ["bun", "-e", 'console.log(JSON.stringify(Bun.JSONC.parse(await Bun.file("bun.lock").text())))'],
        cwd=root,
        text=True,
    )
)
high = next(v for v in lock["packages"].values() if v[0] == "kit-pin@1.0.1")
low = next(v for v in lock["packages"].values() if v[0] == "kit-pin@1.0.0")
next_packages = {k: v for k, v in lock["packages"].items() if k != "kit-pin" and not k.endswith("/kit-pin")}
next_packages["kit-pin"] = low
next_packages["a/kit-pin"] = high
next_packages["c/kit-pin"] = high
lock["packages"] = next_packages
(root / "bun.lock").write_text(json.dumps(lock, indent=2) + "\n")
before = (root / "bun.lock").read_bytes()

r = run("install", "--frozen-lockfile", "--minimum-release-age", "0", "--ignore-scripts")
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("frozen warmup failed")
srv.shutdown()
if (root / "bun.lock").read_bytes() != before:
    raise SystemExit("frozen rewrote lock")

# Prove ordinary offline keeps bytes and lockfile-only would rewrite.
r = run("install", "--offline", "--ignore-scripts")
if r.returncode != 0 or (root / "bun.lock").read_bytes() != before:
    raise SystemExit("ordinary offline did not keep lock")
writer = root.parent / (root.name + "-writer")
if writer.exists():
    shutil.rmtree(writer)
shutil.copytree(root, writer, ignore=shutil.ignore_patterns("node_modules", ".pkg"))
r = subprocess.run(
    ["bun", "install", "--lockfile-only", "--offline", "--ignore-scripts", "--minimum-release-age", "0"],
    cwd=writer,
    env=env,
    text=True,
    capture_output=True,
    timeout=60,
)
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("lockfile-only offline failed")
if (writer / "bun.lock").read_bytes() == before:
    raise SystemExit("lockfile-only did not rewrite hoisting layout")
print("hoist fixture ready")
print("registry_hits", len(logs))

HOISTPY
python3 "$TMP/build-hoist.py" "$HOIST" "$HOIST_CACHE" "$SCANNER"
printf '%s\n' 'node_modules/' '.pkg/' >"$HOIST/.gitignore"
rm -rf "$HOIST/node_modules" "$HOIST"/apps/*/node_modules "$HOIST/.pkg"
commit_tree "$HOIST" hoist-stable
warm_start=$(date +%s%N)
output="$(
  cd "$HOIST" &&
    env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$HOIST_CACHE" bun scripts/kit/check-lock-ranges.ts 2>&1
)" && rc=0 || rc=$?
warm_end=$(date +%s%N)
warm_ms=$(( (warm_end - warm_start) / 1000000 ))
if [[ "$rc" -eq 0 && "$output" == *'check-lock-ranges: OK'* ]]; then
  echo "PASS: hoisting-only layout accepted by ordinary-install oracle (${warm_ms}ms warm)"
  PASS=$((PASS + 1))
else
  echo "FAIL: hoist accept (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi
printf '%s\n' "$warm_ms" >"$TMP/probe-warm-ms.txt"

LOCKFILE_ONLY_MUTANT="$TMP/lockfile-only-mutant"
rm -rf "$LOCKFILE_ONLY_MUTANT"
cp -a "$HOIST" "$LOCKFILE_ONLY_MUTANT"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
const from = "['\''install'\'', '\''--offline'\'', '\''--ignore-scripts'\'']";
const to = "['\''install'\'', '\''--lockfile-only'\'', '\''--offline'\'', '\''--ignore-scripts'\'', '\''--minimum-release-age'\'', '\''0'\'']";
const t = s.replace(from, to);
if (t === s) process.exit(1);
fs.writeFileSync(p, t);
' "$LOCKFILE_ONLY_MUTANT/scripts/kit/check-lock-ranges.ts"
output="$(
  cd "$LOCKFILE_ONLY_MUTANT" &&
    env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$HOIST_CACHE" bun scripts/kit/check-lock-ranges.ts 2>&1
)" && rc=0 || rc=$?
if [[ "$rc" -eq 1 && "$output" == *'candidate bun.lock changes on install'* ]]; then
  echo 'PASS: --lockfile-only comparison mutant killed'
  PASS=$((PASS + 1))
else
  echo "FAIL: lockfile-only mutant (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

cold_cache="$TMP/hoist-cache-cold"
cold_home="$TMP/hoist-home-cold"
rm -rf "$cold_cache" "$cold_home"
mkdir -p "$cold_cache" "$cold_home"
cold_start=$(date +%s%N)
output="$(
  cd "$HOIST" &&
    env -u LOCK_RANGES_ROOT BUN_INSTALL_CACHE_DIR="$cold_cache" HOME="$cold_home" \
      bun scripts/kit/check-lock-ranges.ts 2>&1
)" && rc=0 || rc=$?
cold_end=$(date +%s%N)
cold_ms=$(( (cold_end - cold_start) / 1000000 ))
printf '%s\n' "$cold_ms" >"$TMP/probe-cold-ms.txt"
if [[ "$rc" -eq 1 && "$output" == *'warm the Bun cache'* ]]; then
  echo "PASS: cold empty cache against hoist fixture fails closed (${cold_ms}ms)"
  PASS=$((PASS + 1))
else
  echo "FAIL: cold cache timing case (rc=$rc): $output" >&2
  FAIL=$((FAIL + 1))
fi

echo "== Lock ranges summary: $PASS pass, $FAIL fail =="
echo "probe warm_ms=$(cat "$TMP/probe-warm-ms.txt") cold_ms=$(cat "$TMP/probe-cold-ms.txt")"
[[ "$FAIL" -eq 0 ]]
