#!/usr/bin/env bash
# Hermetic self-test for check-stack-contract.ts. Fixtures only; no network.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="${ROOT}/scripts/kit/check-stack-contract.ts"
[[ -f "$SCANNER" ]] || { echo "FAIL: missing $SCANNER" >&2; exit 1; }
source "${ROOT}/scripts/kit/lib/gate-launch.sh"


PASS=0
FAIL=0
assert_case() {
  local name="$1" expected="$2" tree="$3" marker="$4"
  local output rc=0
  output="$(STACK_CONTRACT_ROOT="$tree" bun "$SCANNER" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$expected" ]] && [[ "$output" == *"$marker"* ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (expected rc=$expected and marker '$marker', got rc=$rc)" >&2
    echo "$output" >&2
    FAIL=$((FAIL + 1))
  fi
}

commit() {
  local tree="$1" msg="$2"
  git -C "$tree" add -A
  LEFTHOOK=0 git -C "$tree" -c user.email=stack-contract@example.com -c user.name=stack-contract \
    commit -q -m "$msg"
}

write_stack() {
  local tree="$1" body="$2"
  mkdir -p "$tree/.dev"
  printf '%s\n' "$body" >"$tree/.dev/stack.yml"
}

UPSTREAM='schema_version: "1.0"
name: cf-chemin-a
runtime: bun
backend:
  path: apps/example-api
frontend:
  path: apps/example-web
landing:
  mode: merge-on-green
commands:
  validate: bun run validate
  validate_full: bun run validate:full
  lint: bun run lint
  test: bun run test
  typecheck: bun run typecheck
  zero_edit: bun run zero-edit
  worktree_setup: scripts/kit/worktree-setup.sh
  dev: bun run dev
review:
  roster:
    max_agents: 3
    agents:
      R-security-auditor: never
release:
  model: trunk
  component: unkillable-kit
worktree:
  copy: []
  seed: []
  setup: bash scripts/kit/worktree-setup.sh
'

FILLED='schema_version: "1.0"
name: acme
runtime: bun
backend:
  path: apps/acme-api
frontend:
  path: apps/acme-web
landing:
  mode: merge-on-green
commands:
  validate: bun run validate
  validate_full: bun run validate:full
  lint: bun run lint
  test: bun run test
  typecheck: bun run typecheck
  zero_edit: bun run zero-edit
  worktree_setup: scripts/kit/worktree-setup.sh
  dev: bun run product-dev
review:
  roster:
    max_agents: 4
    agents:
      R-security-auditor: never
release:
  model: trunk
  component: acme
worktree:
  copy:
    - apps/acme-api/.dev.vars
  seed: []
  setup: bash scripts/kit/worktree-setup.sh
notes: product-only
'

# Kit mode also checks docs/kit/standards/stack.md row status against bun.lock.
write_stack_doc() {
  local tree="$1"
  mkdir -p "$tree/docs/kit/standards"
  cat >"$tree/docs/kit/standards/stack.md" <<'EOF'
| Couche | Choix | Statut | Paquets |
|---|---|---|---|
| API | **Hono** | livré | `hono` |
| Auth | Better Auth | livré | `@kit/auth` |
| Jobs | helpers | cible | `@kit/jobs` |
| Errors | Sentry | option produit | `@sentry/cloudflare` |
| Edge | Workers | livré | |
EOF
  cat >"$tree/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "fixture" } },
  "packages": {
    "hono": ["hono@4.13.9", "", {}, "sha512-x"],
    "@kit/auth": ["@kit/auth@workspace:packages/auth"],
  },
}
EOF
}

init_repo() {
  local tree="$1"
  rm -rf "$tree"
  git init -q -b main "$tree"
}

pin_product() {
  local tree="$1"
  local tip
  tip="$(git -C "$tree" rev-parse HEAD)"
  mkdir -p "$tree/config/product"
  printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${tip}\"}" >"$tree/config/product/inheritance.json"
  commit "$tree" "chore: pin inheritance"
}

TMP="$(mktemp -d -t stack-contract.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "== stack contract self-test =="

KIT="$TMP/kit"
init_repo "$KIT"
write_stack "$KIT" "$UPSTREAM"
write_stack_doc "$KIT"
assert_case "kit shape" 0 "$KIT" "check-stack-contract: OK (kit)"

# Formatter-aligned cells must preserve both passing and failing status checks.
KIT_PADDED="$TMP/kit-padded"
cp -R "$KIT" "$KIT_PADDED"
cat >"$KIT_PADDED/docs/kit/standards/stack.md" <<'EOF'
| Couche | Choix       | Statut         | Paquets               |
| ------ | ----------- | -------------- | --------------------- |
| API    | **Hono**    | livré          | `hono`                |
| Auth   | Better Auth | livré          | `@kit/auth`           |
| Jobs   | helpers     | cible          | `@kit/jobs`           |
| Errors | Sentry      | option produit | `@sentry/cloudflare`  |
EOF
assert_case "padded status table" 0 "$KIT_PADDED" "check-stack-contract: OK (kit)"
printf '%s\n' '| API    | **Hono**    | cible          | `hono`                |' >>"$KIT_PADDED/docs/kit/standards/stack.md"
assert_case "padded table still detects stale status" 1 "$KIT_PADDED" "cible package hono is in bun.lock (stale status)"

KIT_CHECKS="$TMP/kit-checks"
cp -R "$KIT" "$KIT_CHECKS"
printf '%s\n' '  required_checks: []' >>"$KIT_CHECKS/.dev/stack.yml"
# required_checks must sit under landing. Rewrite the landing block instead.
python3 - "$KIT_CHECKS/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
text = text.replace("landing:\n  mode: merge-on-green\n", "landing:\n  mode: merge-on-green\n  required_checks: []\n", 1)
p.write_text(text)
PY
assert_case "kit forbids required_checks" 1 "$KIT_CHECKS" "landing.required_checks is forbidden"

KIT_MODE="$TMP/kit-mode"
cp -R "$KIT" "$KIT_MODE"
python3 - "$KIT_MODE/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("mode: merge-on-green", "mode: squash", 1))
PY
assert_case "kit rejects landing.mode outside the set" 1 "$KIT_MODE" "landing.mode must be merge-on-green or native"

KIT_BUN="$TMP/kit-bun"
cp -R "$KIT" "$KIT_BUN"
printf '\nruntime_pin:\n  bun-version: "1.3.14"\n' >>"$KIT_BUN/.dev/stack.yml"
assert_case "kit forbids nested bun.*version" 1 "$KIT_BUN" "bun version key is forbidden: bun-version"

KIT_CMD="$TMP/kit-cmd"
cp -R "$KIT" "$KIT_CMD"
python3 - "$KIT_CMD/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("validate: bun run validate", "validate: bun run nope", 1))
PY
assert_case "kit mode does not compare commands" 0 "$KIT_CMD" "check-stack-contract: OK (kit)"

# stack.md status vs bun.lock (kit mode). The mutation sets `text` / `lock_text`; None deletes the file.
doc_mutant() {
  local name="$1" marker="$2" py="$3"
  local tree="$TMP/$name"
  rm -rf "$tree"
  cp -R "$KIT" "$tree"
  python3 - "$tree" "$py" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
doc = root / "docs/kit/standards/stack.md"
lock = root / "bun.lock"
text = doc.read_text()
lock_text = lock.read_text()
exec(sys.argv[2])
for path, body in ((doc, text), (lock, lock_text)):
    if body is None:
        path.unlink()
    else:
        path.write_text(body)
PY
  assert_case "$name" 1 "$tree" "$marker"
}

doc_mutant "livre-package-missing" "livré package hono is not in bun.lock" \
  'lock_text = lock_text.replace("    \"hono\": [\"hono@4.13.9\", \"\", {}, \"sha512-x\"],\n", "", 1)'
doc_mutant "cible-package-present" "cible package @kit/jobs is in bun.lock (stale status)" \
  'lock_text = lock_text.replace("  },\n}", "    \"@kit/jobs\": [\"@kit/jobs@workspace:packages/jobs\"],\n  },\n}", 1)'
doc_mutant "option-package-present" "option produit package @sentry/cloudflare is in bun.lock (stale status)" \
  'lock_text = lock_text.replace("  },\n}", "    \"@sentry/cloudflare\": [\"@sentry/cloudflare@10.0.0\", \"\", {}],\n  },\n}", 1)'
doc_mutant "status-unknown" 'status "prévu" must be one of' \
  'text = text.replace("| cible | `@kit/jobs` |", "| prévu | `@kit/jobs` |", 1)'
doc_mutant "package-not-npm-name" '"wrangler types" is not an npm package name' \
  'text = text.replace("| livré | `hono` |", "| livré | `wrangler types` |", 1)'
doc_mutant "no-status-table" "no table with a Statut column" \
  'text = text.replace("| Statut |", "| Etat |", 1)'
doc_mutant "no-livre-checked" "no livré package was checked against bun.lock" \
  'text = text.replace("`hono`", "", 1).replace("`@kit/auth`", "", 1)'
doc_mutant "doc-missing" "missing docs/kit/standards/stack.md" 'text = None'
doc_mutant "lock-missing" "missing bun.lock" 'lock_text = None'

PROD="$TMP/product"
init_repo "$PROD"
write_stack "$PROD" "$UPSTREAM"
commit "$PROD" "chore: kit tip"
pin_product "$PROD"
write_stack "$PROD" "$FILLED"
assert_case "product fill passes" 0 "$PROD" "check-stack-contract: OK (product)"

prod_mutant() {
  local name="$1" marker="$2" py="$3"
  local tree="$TMP/$name"
  rm -rf "$tree"
  cp -R "$PROD" "$tree"
  python3 - "$tree/.dev/stack.yml" "$py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
exec(sys.argv[2])
p.write_text(text)
PY
  assert_case "$name" 1 "$tree" "$marker"
}

prod_mutant "never-override" "review.roster never override not in upstream: R-tester" \
  'text = text.replace("R-security-auditor: never", "R-security-auditor: never\n      R-tester: never", 1)'
prod_mutant "max-agents-below" "review.roster max_agents 1 is below upstream 3" \
  'text = text.replace("max_agents: 4", "max_agents: 1", 1)'
prod_mutant "required-checks" "landing.required_checks is forbidden" \
  'text = text.replace("mode: merge-on-green", "mode: merge-on-green\n  required_checks:\n    - ci", 1)'
prod_mutant "landing-mode" "landing.mode must be merge-on-green or native" \
  'text = text.replace("mode: merge-on-green", "mode: squash", 1)'
prod_mutant "command-changed" "commands.validate changed" \
  'text = text.replace("validate: bun run validate", "validate: bun run nope", 1)'
prod_mutant "command-removed" "commands.validate_full removed" \
  'text = text.replace("  validate_full: bun run validate:full\n", "", 1)'
prod_mutant "bun-version" "bun version key is forbidden: bun_version" \
  'text = text + "\nbun_version: \"1.3.14\"\n"'
prod_mutant "name-equal" "name must differ from upstream" \
  'text = text.replace("name: acme", "name: cf-chemin-a", 1)'
prod_mutant "component-equal" "release.component must differ from upstream" \
  'text = text.replace("component: acme", "component: unkillable-kit", 1)'
prod_mutant "component-legacy" "release.component must not reuse the legacy Kit component" \
  'text = text.replace("component: acme", "component: roxabi-boilerplate-cf", 1)'

# Falsify the guard independently of the ordinary malformed-input fixtures.
mutant_root="$TMP/allow-legacy-component-scanner"
mkdir -p "$mutant_root/scripts/kit"
ln -s "$ROOT/packages" "$mutant_root/packages"
ln -s "$ROOT/scripts/kit/lib" "$mutant_root/scripts/kit/lib"
mutant_scanner="$mutant_root/scripts/kit/check-stack-contract.ts"
awk '
  /if \(scalar\(head, .*=== .roxabi-boilerplate-cf.\) \{/ {
    if (++mutations != 1) exit 2
    print "  if (false) {"
    next
  }
  { print }
  END { if (mutations != 1) exit 2 }
' "$SCANNER" > "$mutant_scanner"
if output="$(STACK_CONTRACT_ROOT="$TMP/component-legacy" bun "$mutant_scanner" 2>&1)" &&
  [[ "$output" == *'check-stack-contract: OK (product)'* ]]; then
  echo 'PASS: mutant killed: allow-legacy-component'
  printf 'FAIL: expected legacy Kit component refusal; mutant returned: %s\n' "$output"
  PASS=$((PASS + 1))
else
  echo "FAIL: allow-legacy-component did not reproduce the acceptance hole: $output" >&2
  FAIL=$((FAIL + 1))
fi

prod_mutant "name-missing" "name must differ from upstream" \
  'text = text.replace("name: acme\n", "", 1)'
prod_mutant "path-equal" "backend.path must differ from upstream" \
  'text = text.replace("path: apps/acme-api", "path: apps/example-api", 1)'
prod_mutant "hash-glued" "glued # under review or landing" \
  'text = text + "\nreview:\n  roster:\n    max_agents: 1#\n    agents:\n      R-tester: never#\n"'
prod_mutant "dup-review" "Map keys must be unique" \
  'text = "review:\n  roster:\n    max_agents: 1\n    agents:\n      R-tester: never\n" + text + "review:\n  roster:\n    max_agents: 3\n"'
prod_mutant "block-scalar" "block scalar under review or landing" \
  'text = text + "\nreview:\n  roster:\n    agents:\n      R-adversarial: default\n      note: |\n        R-tester: never\n"'
prod_mutant "dup-roster" "Map keys must be unique" \
  'text = text.replace("review:\n  roster:\n    max_agents: 4\n    agents:\n      R-security-auditor: never\n", "review:\n  roster:\n    max_agents: 1\n    agents:\n      R-tester: never\n  roster:\n    max_agents: 3\n", 1)'
prod_mutant "nested-agent" "review.roster.agents.R-devops must be a scalar" \
  'text = text.replace("R-security-auditor: never\n", "R-security-auditor: never\n      R-devops:\n        R-tester: never\n", 1)'
prod_mutant "dup-landing" "Map keys must be unique" \
  'text = text.replace("landing:\n  mode: merge-on-green\n", "landing:\n  mode: native\n  required_checks: [ci]\n", 1) + "landing:\n  mode: merge-on-green\n"'

# API-only: replace the whole frontend block. A no-op replace would still pass the filled product.
API_ONLY="$TMP/api-only"
rm -rf "$API_ONLY"
cp -R "$PROD" "$API_ONLY"
python3 - "$API_ONLY/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
old = "frontend:\n  path: apps/acme-web\n"
if old not in text:
    raise SystemExit("api-only fixture: frontend block missing")
text = text.replace(old, "frontend: null\n", 1)
if "apps/acme-web" in text:
    raise SystemExit("api-only fixture: replacement did not occur")
p.write_text(text)
PY
if ! grep -qx 'frontend: null' "$API_ONLY/.dev/stack.yml"; then
  echo "FAIL: api-only fixture replacement did not occur" >&2
  FAIL=$((FAIL + 1))
else
  echo "PASS: api-only fixture replacement occurred"
  PASS=$((PASS + 1))
fi
assert_case "api-only explicit null passes" 0 "$API_ONLY" "check-stack-contract: OK (product)"

API_ONLY_ANCHOR="$TMP/api-only-anchor"
rm -rf "$API_ONLY_ANCHOR"
cp -R "$API_ONLY" "$API_ONLY_ANCHOR"
python3 - "$API_ONLY_ANCHOR/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
old = "frontend: null\n"
if old not in text:
    raise SystemExit("anchored fixture: explicit null missing")
text = text.replace(old, "frontend: &noFrontend null\n", 1)
p.write_text(text)
PY
if ! grep -qx 'frontend: &noFrontend null' "$API_ONLY_ANCHOR/.dev/stack.yml"; then
  echo "FAIL: anchored null fixture replacement did not occur" >&2
  FAIL=$((FAIL + 1))
else
  assert_case "api-only anchored null passes" 0 "$API_ONLY_ANCHOR" "check-stack-contract: OK (product)"
fi

API_ONLY_BACKEND="$TMP/api-only-backend-equal"
rm -rf "$API_ONLY_BACKEND"
cp -R "$API_ONLY" "$API_ONLY_BACKEND"
python3 - "$API_ONLY_BACKEND/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
old = "path: apps/acme-api"
if "frontend: null\n" not in text or old not in text:
    raise SystemExit("api-only backend-equal fixture was not prepared")
text = text.replace(old, "path: apps/example-api", 1)
p.write_text(text)
PY
if ! grep -qx 'frontend: null' "$API_ONLY_BACKEND/.dev/stack.yml" \
  || ! grep -qx '  path: apps/example-api' "$API_ONLY_BACKEND/.dev/stack.yml"; then
  echo "FAIL: api-only backend-equal fixture was not prepared" >&2
  FAIL=$((FAIL + 1))
else
  assert_case "api-only null with equal backend fails" 1 "$API_ONLY_BACKEND" \
    "backend.path must differ from upstream"
fi

prod_mutant "frontend-path-equal" "frontend.path must differ from upstream" \
  'text = text.replace("path: apps/acme-web", "path: apps/example-web", 1)'
prod_mutant "frontend-absent" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "", 1)'
prod_mutant "frontend-path-missing" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "frontend:\n  framework: vite\n", 1)'
prod_mutant "frontend-path-null" "frontend.path must differ from upstream" \
  'text = text.replace("path: apps/acme-web", "path: null", 1)'
prod_mutant "frontend-path-blank" "frontend.path must differ from upstream" \
  'text = text.replace("path: apps/acme-web", "path: \"   \"", 1)'
prod_mutant "frontend-quoted-null" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "frontend: \"null\"\n", 1)'
prod_mutant "frontend-implicit-empty" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "frontend:\n", 1)'
prod_mutant "frontend-tilde" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "frontend: ~\n", 1)'
prod_mutant "frontend-Null" "frontend.path must differ from upstream" \
  'text = text.replace("frontend:\n  path: apps/acme-web\n", "frontend: Null\n", 1)'


LAUNDER="$TMP/launder"
init_repo "$LAUNDER"
write_stack "$LAUNDER" "$UPSTREAM"
commit "$LAUNDER" "chore: kit tip"
pin_product "$LAUNDER"
launder_pin="$(git -C "$LAUNDER" rev-parse HEAD)"
write_stack "$LAUNDER" "$FILLED"
printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${launder_pin}\"}" >"$LAUNDER/config/product/inheritance.json"
assert_case "upstream is the commit that introduced the marker" 1 "$LAUNDER" "upstreamCommit descends from ${launder_pin}"

# Delete-and-re-add launder: C1 drops the marker and fills the stack, C2 re-adds it pinned to C1.
# C1's own tree has no marker, but it descends from the commit that introduced it.
LAUNDER2="$TMP/launder-readd"
init_repo "$LAUNDER2"
write_stack "$LAUNDER2" "$UPSTREAM"
commit "$LAUNDER2" "chore: kit tip"
pin_product "$LAUNDER2"
rm "$LAUNDER2/config/product/inheritance.json"
write_stack "$LAUNDER2" "$FILLED"
commit "$LAUNDER2" "chore: drop marker, fill stack"
launder2_pin="$(git -C "$LAUNDER2" rev-parse HEAD)"
printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${launder2_pin}\"}" >"$LAUNDER2/config/product/inheritance.json"
assert_case "marker deleted and re-added pinned to the deleting commit" 1 "$LAUNDER2" "upstreamCommit descends from"

# worktree.setup must equal "bash <commands.worktree_setup>" (both modes).
KIT_SETUP="$TMP/kit-setup-empty"
cp -R "$KIT" "$KIT_SETUP"
python3 - "$KIT_SETUP/.dev/stack.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
path.write_text(text.replace("setup: bash scripts/kit/worktree-setup.sh", 'setup: ""'))
PY
assert_case "kit rejects empty worktree.setup" 1 "$KIT_SETUP" 'worktree.setup must equal "bash scripts/kit/worktree-setup.sh"'

prod_mutant "worktree-setup-mismatch" 'worktree.setup must equal "bash scripts/kit/worktree-setup.sh"' '
text = text.replace("setup: bash scripts/kit/worktree-setup.sh", "setup: bash scripts/other.sh")
'


# RC-1: cmd absent / empty must not disable the pin (vacuous-guard).
KIT_NO_CMD="$TMP/kit-setup-no-cmd"
cp -R "$KIT" "$KIT_NO_CMD"
python3 - "$KIT_NO_CMD/.dev/stack.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
path.write_text(text.replace("  worktree_setup: scripts/kit/worktree-setup.sh\n", ""))
PY
assert_case "kit rejects missing worktree_setup command" 1 "$KIT_NO_CMD" \
  'commands.worktree_setup must be a non-empty string'

KIT_EMPTY_CMD="$TMP/kit-setup-empty-cmd"
cp -R "$KIT" "$KIT_EMPTY_CMD"
python3 - "$KIT_EMPTY_CMD/.dev/stack.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
path.write_text(text.replace(
  "  worktree_setup: scripts/kit/worktree-setup.sh",
  '  worktree_setup: ""',
))
PY
assert_case "kit rejects empty worktree_setup command" 1 "$KIT_EMPTY_CMD" \
  'commands.worktree_setup must be a non-empty string'

KIT_NO_BLOCK="$TMP/kit-setup-no-block"
cp -R "$KIT" "$KIT_NO_BLOCK"
python3 - "$KIT_NO_BLOCK/.dev/stack.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
start = text.index("worktree:\n")
path.write_text(text[:start].rstrip() + "\n")
PY
assert_case "kit rejects missing worktree block" 1 "$KIT_NO_BLOCK" \
  'worktree.setup must equal "bash scripts/kit/worktree-setup.sh"'

prod_mutant "worktree-setup-cmd-removed" 'commands.worktree_setup removed' '
text = text.replace("  worktree_setup: scripts/kit/worktree-setup.sh\n", "")
'

assert_gate_launch STACK_CONTRACT_ROOT "$KIT_MODE" "landing.mode must be merge-on-green or native"
assert_gate_requires_install stack-contract:check \
  'check-stack-contract: yaml is not installed; run bun install'
assert_gate_rethrows_yaml_initialization stack-contract:check \
  'check-stack-contract: yaml is not installed; run bun install'


echo "== stack contract summary: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
