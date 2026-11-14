#!/usr/bin/env bash
# Hermetic self-test for check-qualified-refs.ts and the commitlint rule that shares its detector.
# Fixtures only; no network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
# shellcheck source=lib/hermetic-git.sh
source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
SCANNER="${ROOT}/scripts/kit/check-qualified-refs.ts"
[[ -f "$SCANNER" ]] || { echo "FAIL: missing $SCANNER" >&2; exit 1; }
# shellcheck source=lib/gate-launch.sh
source "${ROOT}/scripts/kit/lib/gate-launch.sh"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d -t qualified-refs.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# scan <name> <expected rc> <marker> — scan the tree in $TMP/<name>.
scan() {
  local name="$1" expected="$2" marker="$3" output rc=0
  output="$(QUALIFIED_REFS_ROOT="$TMP/$name" bun "${GATE[@]}" "$SCANNER" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$expected" ]] && [[ "$output" == *"$marker"* ]]; then
    pass "$name"
  else
    fail "$name (expected rc=$expected and marker '$marker', got rc=$rc)"
    echo "$output" >&2
  fi
}

# fixture <name> <path> <content> — one-file git tree.
fixture() {
  local name="$1" path="$2" content="$3"
  mkdir -p "$TMP/$name/$(dirname "$path")"
  git init -q "$TMP/$name"
  printf '%s\n' "$content" >"$TMP/$name/$path"
}

echo "== qualified refs self-test =="

fixture md-bare README.md 'Fixed in #12.'  # qualified-refs:ignore — fixture data
scan md-bare 1 "README.md:1: bare issue reference #12"  # qualified-refs:ignore — fixture data

fixture md-link-label README.md 'See [#12](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/12).'  # qualified-refs:ignore — fixture data
scan md-link-label 1 "README.md:1: bare issue reference #12"  # qualified-refs:ignore — fixture data

fixture ts-comment-bare src/a.ts '// retry once (#318)'  # qualified-refs:ignore — fixture data
scan ts-comment-bare 1 "src/a.ts:1: bare issue reference #318"  # qualified-refs:ignore — fixture data

fixture sh-message-bare run.sh 'echo "see #7"'  # qualified-refs:ignore — fixture data
scan sh-message-bare 1 "run.sh:1: bare issue reference #7"  # qualified-refs:ignore — fixture data

fixture json-bare config.json '{ "description": "kit apps (#318)" }'  # qualified-refs:ignore — fixture data
scan json-bare 1 "config.json:1: bare issue reference #318"  # qualified-refs:ignore — fixture data

fixture md-range docs.md 'Children #27–#36.'  # qualified-refs:ignore — fixture data
scan md-range 1 "docs.md:1: bare issue reference #27"  # qualified-refs:ignore — fixture data

fixture md-qualified README.md 'Fixed in Roxabi/roxabi-boilerplate-cf#12 and go-silex/silex-boilerplate#14, range Roxabi/roxabi-boilerplate-cf#27–36.'
scan md-qualified 0 "check-qualified-refs: OK"

fixture md-url README.md 'See https://github.com/Roxabi/roxabi-boilerplate-cf/issues/12#issuecomment-1 and [x](https://github.com/Roxabi/roxabi-boilerplate-cf/pull/12).'
scan md-url 0 "check-qualified-refs: OK"

fixture md-anchor README.md 'Jump to [section](#12-steps) or [other](docs.md#3-more), repo evilmartians/lefthook#1475, `${#1}`, &#123;.'
scan md-anchor 0 "check-qualified-refs: OK"

fixture ts-color src/a.tsx 'const bg = "bg-[#333] #1a2b3c #112233 #fff #ff0000"'  # qualified-refs:ignore — fixture data
scan ts-color 0 "check-qualified-refs: OK"

fixture sh-shebang run.sh $'#!/usr/bin/env bash\n# $# args, ${#arr[@]} items'
scan sh-shebang 0 "check-qualified-refs: OK"

fixture debt-pin src/a.ts '// biome-ignore lint/suspicious/noExplicitAny: boundary — DEBT:zod-boundary #68'
scan debt-pin 0 "check-qualified-refs: OK"

fixture ignore-marker README.md 'color #333 qualified-refs:ignore fixture data'
scan ignore-marker 0 "check-qualified-refs: OK"

fixture migration-excluded apps/api/migrations/0001_init.sql '-- init (#12)'  # qualified-refs:ignore — fixture data
scan migration-excluded 0 "check-qualified-refs: OK"

fixture sql-outside-migrations scripts/seed.sql '-- seed (#12)'  # qualified-refs:ignore — fixture data
scan sql-outside-migrations 1 "scripts/seed.sql:1: bare issue reference"

fixture unscanned-ext notes.png.bak 'binary-ish #12'  # qualified-refs:ignore — fixture data
scan unscanned-ext 0 "check-qualified-refs: OK"

# A cwd .env or bunfig preload re-points the root unless the package.json flags close it.
assert_gate_launch QUALIFIED_REFS_ROOT "$TMP/md-bare" "README.md:1: bare issue reference #12"  # qualified-refs:ignore — fixture data

# --- commitlint rule (same detector) ---
[[ -x "$ROOT/node_modules/.bin/commitlint" ]] || { echo "FAIL: commitlint is not installed (run bun install)" >&2; exit 1; }
lint() {
  local name="$1" expected="$2" message="$3" rc=0 output
  printf '%s\n' "$message" >"$TMP/lint-msg.txt"
  output="$(cd "$ROOT" && bash scripts/kit/lefthook-commit-msg.sh "$TMP/lint-msg.txt" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$expected" ]]; then
    pass "commitlint: $name"
  else
    fail "commitlint: $name (expected rc=$expected, got rc=$rc)"
    echo "$output" >&2
  fi
}

lint "scope with issue number rejected" 1 'feat(#240): add tasks'  # qualified-refs:ignore — fixture data
lint "bare ref in header rejected" 1 'fix(tasks): retry once, closes #240'  # qualified-refs:ignore — fixture data
lint "bare ref in body rejected" 1 $'feat(tasks): add tasks\n\nsee #12'  # qualified-refs:ignore — fixture data
lint "bare ref in trailer rejected" 1 $'feat(tasks): add tasks\n\nCloses #12'  # qualified-refs:ignore — fixture data
lint "plain scope accepted" 0 'feat(tasks): add tasks'
lint "qualified trailer accepted" 0 $'feat(tasks): add tasks\n\nRefs: Roxabi/roxabi-boilerplate-cf#240'
lint "qualified closing trailer accepted" 0 $'feat(tasks): add tasks\n\nCloses Roxabi/roxabi-boilerplate-cf#240'
lint "url accepted" 0 $'feat(tasks): add tasks\n\nSee https://github.com/Roxabi/roxabi-boilerplate-cf/issues/240'

# --- commit-msg hook: a product config file must not replace the kit policy (Roxabi/roxabi-boilerplate-cf#429) ---
# Runs Lefthook itself with the kit hook config in fixtures holding the kit runner and detector.
# Each control proves its planted config changes the previous runner's behaviour; the hook must
# still reject a bare ref and accept a clean message. Executable cosmiconfig meta configs also run
# under the old --config pin: isolating the process cwd closes that construction-time discovery.
# Does not cover Lefthook local overlays or LEFTHOOK*/core.hooksPath (docs/kit/testing/critical-path.md
# CP-ZERO-EDIT non-claims).
[[ -x "$ROOT/node_modules/.bin/lefthook" ]] || { echo "FAIL: lefthook is not installed (run bun install)" >&2; exit 1; }
HOOK_CMD='node_modules/.bin/lefthook run commit-msg {1}'

PERMISSIVE='{"extends":["@commitlint/config-conventional"],"rules":{"type-enum":[2,"always",["feat","fix","wip"]]}}'
BARE_MSG=$'feat(tasks): add tasks\n\nsee #12'  # qualified-refs:ignore — fixture data
UNPINNED_CMD='bunx commitlint --edit {1}'
PINNED_CMD='node_modules/.bin/commitlint --config commitlint.config.cjs --edit {1}'

# shadow_fixture <name> <path> <content> — kit config + detector + a planted root config; node_modules shared.
shadow_fixture() {
  local dir="$TMP/shadow-$1"
  mkdir -p "$dir/scripts/kit/lib" "$(dirname "$dir/$2")"
  git init -q "$dir"
  cp "$ROOT/commitlint.config.cjs" "$dir/"
  cp "$ROOT/scripts/kit/lib/bare-issue-ref.cjs" "$dir/scripts/kit/lib/"
  cp "$ROOT/lefthook.yml" "$dir/"
  cp "$ROOT/scripts/kit/lefthook-commit-msg.sh" "$dir/scripts/kit/"
  ln -s "$ROOT/node_modules" "$dir/node_modules"
  printf '%s\n' "$3" >"$dir/$2"
  printf '%s\n' "$BARE_MSG" >"$dir/msg.txt"
  printf '%s\n' 'feat(tasks): add tasks' >"$dir/ok.txt"
}

# hook_run <name> <command> <message file> — run a commit-msg command in the fixture; sets rc, output.
hook_run() {
  rc=0
  output="$(cd "$TMP/shadow-$1" && bash -c "${2//\{1\}/$3}" 2>&1)" || rc=$?
}

shadow_case() {
  local name="$1" file="$2" content="$3" control="${4:-$UNPINNED_CMD}" mode="${5:-accept-bare}" rc output
  shadow_fixture "$name" "$file" "$content"

  if [[ "$mode" == accept-bare ]]; then
    hook_run "$name" "$control" msg.txt
    if [[ "$rc" -eq 0 ]]; then
      pass "commit-msg control: planted $file lets the previous runner accept a bare ref"
    else
      fail "commit-msg control: planted $file did not bypass the previous runner (rc=$rc)"
      echo "$output" >&2
    fi
  else
    hook_run "$name" "$control" ok.txt
    if [[ "$rc" -ne 0 ]]; then
      pass "commit-msg control: planted $file makes the previous runner refuse a clean message"
    else
      fail "commit-msg control: planted $file did not change the previous runner (rc=$rc)"
      echo "$output" >&2
    fi
  fi

  hook_run "$name" "$HOOK_CMD" msg.txt
  if [[ "$rc" -ne 0 && "$output" == *"no-bare-issue-ref"* ]]; then
    pass "commit-msg hook: planted $file does not replace the kit policy"
  else
    fail "commit-msg hook: planted $file replaced the kit policy (rc=$rc, expected no-bare-issue-ref)"
    echo "$output" >&2
  fi

  hook_run "$name" "$HOOK_CMD" ok.txt
  if [[ "$rc" -eq 0 ]]; then
    pass "commit-msg hook: a clean message passes with planted $file"
  else
    fail "commit-msg hook: a clean message was refused with planted $file (rc=$rc)"
    echo "$output" >&2
  fi
}

shadow_case rc-json .commitlintrc.json "$PERMISSIVE"
shadow_case package-yaml package.yaml $'commitlint:\n  extends: ["@commitlint/config-conventional"]\n  rules:\n    type-enum: [2, always, [feat, fix, wip]]'
shadow_case meta-config .config/config.json "{\"commitlint\":${PERMISSIVE}}"
shadow_case meta-exec-cjs .config/config.cjs 'process.exit(0)' "$PINNED_CMD"
shadow_case meta-exec-mjs .config/config.mjs 'process.exit(0)' "$PINNED_CMD"
shadow_case meta-options-json .config/config.json '{"cosmiconfig":{"applyPackagePropertyPathToConfiguration":true,"packageProp":"rules"}}' "$PINNED_CMD" refuse-clean
# commitlint reads core.commentChar from process.cwd(), not from --cwd. A checkout-local
# value must still apply after the empty-directory isolation, or a leading # hides a bare ref.
shadow_fixture comment-char .gitkeep ''
git -C "$TMP/shadow-comment-char" config core.commentChar ';'
printf 'feat(tasks): add tasks\n\n#12\n' >"$TMP/shadow-comment-char/hash.txt"  # qualified-refs:ignore — fixture data
hook_run comment-char "$PINNED_CMD" hash.txt
if [[ "$rc" -ne 0 && "$output" == *"no-bare-issue-ref"* ]]; then
  pass "commit-msg control: in-place runner rejects a hash issue line when commentChar is not hash"
else
  fail "commit-msg control: in-place runner did not reject a hash issue line (rc=$rc)"
  echo "$output" >&2
fi
hook_run comment-char "$HOOK_CMD" hash.txt
if [[ "$rc" -ne 0 && "$output" == *"no-bare-issue-ref"* ]]; then
  pass "commit-msg hook: checkout commentChar still rejects a hash issue line"
else
  fail "commit-msg hook: checkout commentChar hid a hash issue line (rc=$rc)"
  echo "$output" >&2
fi
hook_run comment-char "$HOOK_CMD" ok.txt
if [[ "$rc" -eq 0 ]]; then
  pass "commit-msg hook: a clean message passes with a checkout commentChar"
else
  fail "commit-msg hook: a clean message was refused with a checkout commentChar (rc=$rc)"
  echo "$output" >&2
fi

echo "== qualified refs summary: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
