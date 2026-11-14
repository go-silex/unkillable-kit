#!/usr/bin/env bash
# Dogfood zero-edit consumer contract against a product clone (ADR-0009).
#
# Usage:
#   bash scripts/kit/dogfood-zero-edit.sh /path/to/product-repo
#   bash scripts/kit/dogfood-zero-edit.sh --generated-product /path/to/product-repo
#   bash scripts/kit/dogfood-zero-edit.sh --self-sim
#
# Exit 0 only if:
#   - upstream remote exists
#   - upstream push URL is exactly no_push
#   - zero-edit (product mode) green vs inheritance marker
#   - banlist green
# Self-sim also asserts:
#   - Roxabi kit → mirror → product chain (three repos, distinct tips)
#   - stale refs/remotes/upstream/main does not control the base (Roxabi/roxabi-boilerplate-cf#103)
#   - protected-path dual-edit fails
#   - mirror stays kit mode (allowlisted origin, no product marker)
#   - kit fixture seeds from exact source HEAD (branch or detached — CI-safe)
#   - unlisted product-*.yml workflow passes; unlisted non-prefix workflow fails (ADR-0013)
#   - tool-mandated docs/agents/issue-tracker.md passes the inventory; sibling / same-basename /
#     protected-only docs paths fail; product tracks it and cannot edit it (Roxabi/roxabi-boilerplate-cf#259)
#   - product edit of .dev/stack.yml passes with no exception; package.json stays forbidden (Roxabi/roxabi-boilerplate-cf#260)
#   - stack-contract product mode: a filled product passes; a new never override fails (Roxabi/roxabi-boilerplate-cf#260)
#   - marker lineage: mirror chain + re-inherit of a newer tip accepted; delete/re-add launder, base on a
#     product commit and shallow clone refused (ADR-0009 D4 threat model)
#   - protected non-ASCII paths fail from committed, unstaged, index-only staged and untracked Git
#     listings with core.quotePath=true; a clean product and a product-owned non-ASCII path pass
#   - exception expiry cap: a new/extended exception beyond max_days refused; legacy grandfathered
#   - product root pnpm-workspace.yaml is FORBIDDEN, untracked included (Roxabi/roxabi-boilerplate-cf#422)
#   - publication continuity: independent go-silex/unkillable-kit root; direct and mirror-mediated
#     products each transition once, then ordinary upgrade; fetched-unmerged pin refused;
#     root LICENSE presence and bytes are restored from the pre-merge HEAD (Roxabi/roxabi-boilerplate-cf#505)
set -euo pipefail

# leftover / worktree shells can export GIT_DIR. git -C then ignores dest and
# mutates the real repo (`checkout -B main`, remote add kit-seed).
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-}"
ZERO_SCRIPT="$ROOT/scripts/kit/check-zero-edit-zones.sh"
BAN_SCRIPT="$ROOT/scripts/kit/check-banned-strings.sh"
DENY_SCRIPT="$ROOT/scripts/kit/deny-upstream-push.sh"
SELF_SIM_MIRROR_IDENTITY="go-silex/silex-boilerplate"
SELF_SIM_PRODUCT_IDENTITY="example/acme-product"

run_gates() {
  local tree="$1"
  local gh_identity="${2:-}"
  local zero_script ban_script
  if [[ -f "$tree/scripts/kit/check-zero-edit-zones.sh" ]]; then
    zero_script="$tree/scripts/kit/check-zero-edit-zones.sh"
  else
    zero_script="$ZERO_SCRIPT"
    echo "NOTE: using kit zero-edit script with ZERO_EDIT_ROOT=$tree"
  fi
  if [[ -f "$tree/scripts/kit/check-banned-strings.sh" ]]; then
    ban_script="$tree/scripts/kit/check-banned-strings.sh"
  else
    ban_script="$BAN_SCRIPT"
    echo "NOTE: using kit banlist script with ZERO_EDIT_ROOT=$tree"
  fi

  if [[ -n "$gh_identity" ]]; then
    ZERO_EDIT_ROOT="$tree" GITHUB_REPOSITORY="$gh_identity" bash "$zero_script"
  else
    ZERO_EDIT_ROOT="$tree" bash "$zero_script"
  fi
  ZERO_EDIT_ROOT="$tree" bash "$ban_script"
}

run_zero_edit_capture() {
  local tree="$1"
  local gh_identity="${2:-}"
  local zero_script
  if [[ -f "$tree/scripts/kit/check-zero-edit-zones.sh" ]]; then
    zero_script="$tree/scripts/kit/check-zero-edit-zones.sh"
  else
    zero_script="$ZERO_SCRIPT"
  fi
  if [[ -n "$gh_identity" ]]; then
    ZERO_EDIT_ROOT="$tree" GITHUB_REPOSITORY="$gh_identity" bash "$zero_script" 2>&1
  else
    ZERO_EDIT_ROOT="$tree" bash "$zero_script" 2>&1
  fi
}

# ADR-0013: workflow inventory — product- prefix OK unlisted; other unlisted FAIL.
# Uses a working-tree copy of checker+zones so uncommitted kit HEAD still exercises the gate.
run_workflow_inventory_cases() {
  local tree="$1"
  local identity="Roxabi/roxabi-boilerplate-cf"

  rm -rf "$tree"
  git init -q "$tree"
  mkdir -p "$tree/config/kit" "$tree/scripts/kit" "$tree/.github/workflows"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
  cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$tree/scripts/kit/check-zero-edit-zones.sh"
  git -C "$tree" add -- config/kit/zero-edit-zones.json scripts/kit/check-zero-edit-zones.sh

  printf '%s\n' 'name: product-thing' >"$tree/.github/workflows/product-thing.yml"
  printf '%s\n' 'name: product-thing-yaml' >"$tree/.github/workflows/product-thing.yaml"
  git -C "$tree" add -N -- .github/workflows/product-thing.yml .github/workflows/product-thing.yaml

  local pass_out pass
  set +e
  pass_out="$(run_zero_edit_capture "$tree" "$identity")"
  pass=$?
  set -e
  if [[ "$pass" -ne 0 ]]; then
    echo "FAIL: product- prefix workflow must pass inventory without being in protected_files" >&2
    echo "$pass_out" >&2
    exit 1
  fi
  if [[ "$pass_out" != *"mode=kit"* ]]; then
    echo "FAIL: workflow prefix fixture must run in kit mode" >&2
    echo "$pass_out" >&2
    exit 1
  fi
  echo "dogfood workflow inventory: product-thing.yml unlisted prefix → pass"

  # GitHub loads .yml AND .yaml — the gate matches the basename prefix, not an
  # extension, so an unlisted rogue.yaml must fail exactly like rogue.yml.
  printf '%s\n' 'name: rogue' >"$tree/.github/workflows/rogue.yml"
  printf '%s\n' 'name: rogue-yaml' >"$tree/.github/workflows/rogue.yaml"
  git -C "$tree" add -N -- .github/workflows/rogue.yml .github/workflows/rogue.yaml

  local fail_out fail
  set +e
  fail_out="$(run_zero_edit_capture "$tree" "$identity")"
  fail=$?
  set -e
  if [[ "$fail" -eq 0 ]]; then
    echo "FAIL: expected workflow inventory gate to fail on unlisted rogue.yml" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  if [[ "$fail_out" != *"check-zero-edit-zones: unclassified workflows under .github/workflows (name product-*.yml / product-*.yaml or add to protected_files):"* ]]; then
    echo "FAIL: expected workflow inventory header" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  if [[ "$fail_out" != *"UNCLASSIFIED WORKFLOW .github/workflows/rogue.yml"* ]]; then
    echo "FAIL: expected UNCLASSIFIED WORKFLOW .github/workflows/rogue.yml" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  if [[ "$fail_out" != *"UNCLASSIFIED WORKFLOW .github/workflows/rogue.yaml"* ]]; then
    echo "FAIL: expected UNCLASSIFIED WORKFLOW .github/workflows/rogue.yaml (.yaml is not exempt)" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  if [[ "$fail_out" == *"UNCLASSIFIED WORKFLOW .github/workflows/product-thing."* ]]; then
    echo "FAIL: product- prefix must not be unclassified" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  if [[ "$fail_out" != *"workflow inventory gate failed (ADR-0009 D6, ADR-0013)"* ]]; then
    echo "FAIL: expected workflow inventory die message" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  echo "dogfood workflow inventory: rogue.yml + rogue.yaml unlisted → fail"
}

# Roxabi/roxabi-boilerplate-cf#259, ADR-0009 D1 amendment: a path outside */kit is classified only when listed exactly in
# tool_mandated_paths (and protected). protected_files alone classifies nothing under
# config|scripts|docs, and neither a sibling nor a same-basename path rides along.
run_docs_inventory_cases() {
  local tree="$1"
  local identity="Roxabi/roxabi-boilerplate-cf"

  rm -rf "$tree"
  git init -q "$tree"
  mkdir -p "$tree/config/kit" "$tree/scripts/kit" "$tree/docs/agents" "$tree/docs/other" "$tree/docs/extra"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
  cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$tree/scripts/kit/check-zero-edit-zones.sh"
  # A protected-only entry under docs/ that no tool mandates: must still be unclassified.
  bun -e '
    const p = process.argv[1]; const z = JSON.parse(await Bun.file(p).text());
    z.protected_files.push("docs/extra/listed.md"); await Bun.write(p, JSON.stringify(z, null, 2));
  ' "$tree/config/kit/zero-edit-zones.json"
  git -C "$tree" add -- config/kit/zero-edit-zones.json scripts/kit/check-zero-edit-zones.sh

  printf '%s\n' '# Issue tracker' >"$tree/docs/agents/issue-tracker.md"
  git -C "$tree" add -N -- docs/agents/issue-tracker.md

  local pass_out pass
  set +e
  pass_out="$(run_zero_edit_capture "$tree" "$identity")"
  pass=$?
  set -e
  if [[ "$pass" -ne 0 || "$pass_out" != *"mode=kit"* ]]; then
    echo "FAIL: tool-mandated docs/agents/issue-tracker.md must pass the inventory gate (kit mode)" >&2
    echo "$pass_out" >&2
    exit 1
  fi
  echo "dogfood docs inventory: tool-mandated docs/agents/issue-tracker.md → pass"

  local stray
  local strays=(docs/other/x.md docs/agents/other.md docs/agents/issue-tracker.md.orig docs/other/issue-tracker.md docs/other/README.md docs/extra/listed.md)
  for stray in "${strays[@]}"; do
    printf '%s\n' '# stray' >"$tree/$stray"
    git -C "$tree" add -N -- "$stray"
  done

  local fail_out fail
  set +e
  fail_out="$(run_zero_edit_capture "$tree" "$identity")"
  fail=$?
  set -e
  if [[ "$fail" -eq 0 ]]; then
    echo "FAIL: stray docs paths must fail the inventory gate" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  for stray in "${strays[@]}"; do
    if [[ "$fail_out" != *"UNCLASSIFIED ${stray}"$'\n'* && "$fail_out" != *"UNCLASSIFIED ${stray}" ]]; then
      echo "FAIL: expected UNCLASSIFIED ${stray} (sibling, same basename, prefix-extended, or protected-only)" >&2
      echo "$fail_out" >&2
      exit 1
    fi
  done
  if [[ "$fail_out" == *"UNCLASSIFIED docs/agents/issue-tracker.md"$'\n'* || "$fail_out" == *"UNCLASSIFIED docs/agents/issue-tracker.md" ]]; then
    echo "FAIL: tool-mandated docs/agents/issue-tracker.md must not be reported unclassified" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  echo "dogfood docs inventory: sibling / same-basename / prefix-extended / protected-only docs paths → fail"

  # A tool-mandated path that is not also protected would be classified yet product-editable.
  bun -e '
    const p = process.argv[1]; const z = JSON.parse(await Bun.file(p).text());
    z.protected_files = z.protected_files.filter((f) => f !== "docs/agents/issue-tracker.md");
    await Bun.write(p, JSON.stringify(z, null, 2));
  ' "$tree/config/kit/zero-edit-zones.json"
  set +e
  fail_out="$(run_zero_edit_capture "$tree" "$identity")"
  fail=$?
  set -e
  if [[ "$fail" -eq 0 || "$fail_out" != *"tool_mandated_paths entry not in protected_files: docs/agents/issue-tracker.md"* ]]; then
    echo "FAIL: an unprotected tool_mandated_paths entry must be a config error" >&2
    echo "$fail_out" >&2
    exit 1
  fi
  echo "dogfood docs inventory: unprotected tool-mandated path → config error"

  # Roxabi/roxabi-boilerplate-cf#318: a narrowed kit-app prefix stays protected but would read the app as a product app.
  local narrowed
  for narrowed in apps/example-api/src/ apps/ ./apps/example-api/; do
    cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
    bun -e '
      const [p, entry] = process.argv.slice(1); const z = JSON.parse(await Bun.file(p).text());
      z.protected_prefixes = z.protected_prefixes.map((e) => (e === "apps/example-api/" ? entry : e));
      await Bun.write(p, JSON.stringify(z, null, 2));
    ' "$tree/config/kit/zero-edit-zones.json" "$narrowed"
    set +e
    fail_out="$(run_zero_edit_capture "$tree" "$identity")"
    fail=$?
    set -e
    if [[ "$fail" -eq 0 || "$fail_out" != *"protected_prefixes apps entry must be exactly apps/<name>/ (the kit-app list, Roxabi/roxabi-boilerplate-cf#318): ${narrowed}"* ]]; then
      echo "FAIL: protected_prefixes entry ${narrowed} must be a config error" >&2
      echo "$fail_out" >&2
      exit 1
    fi
  done
  echo "dogfood docs inventory: narrowed / bare / dot-prefixed apps protected_prefixes entry → config error"
}
# Roxabi/roxabi-boilerplate-cf#260: .dev/stack.yml is product-owned after inheritance. A product edit passes
# with no zero-edit exception. A still-protected root file stays forbidden, so a
# green stack edit is not a disabled gate. Copies the working-tree zones file.
run_stack_ownership_case() {
  local tree="$1"
  local identity="example/acme-product"

  rm -rf "$tree"
  git init -q -b main "$tree"
  mkdir -p "$tree/config/kit" "$tree/scripts/kit" "$tree/.dev" "$tree/config/product"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
  cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$tree/scripts/kit/check-zero-edit-zones.sh"
  printf '%s\n' 'schema_version: "1.0"' 'name: kit' >"$tree/.dev/stack.yml"
  printf '%s\n' '{ "name": "kit" }' >"$tree/package.json"
  git -C "$tree" add -- config/kit/zero-edit-zones.json scripts/kit/check-zero-edit-zones.sh .dev/stack.yml package.json
  LEFTHOOK=0 git -C "$tree" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: kit tip"
  local tip
  tip="$(git -C "$tree" rev-parse HEAD)"
  printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${tip}\"}" >"$tree/config/product/inheritance.json"
  git -C "$tree" add -- config/product/inheritance.json
  LEFTHOOK=0 git -C "$tree" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: pin inheritance"

  printf '\n' >>"$tree/package.json"
  local neg_out neg
  set +e
  neg_out="$(run_zero_edit_capture "$tree" "$identity")"
  neg=$?
  set -e
  if [[ "$neg" -eq 0 || "$neg_out" != *"FORBIDDEN package.json"* ]]; then
    echo "FAIL: package.json dual-edit must stay FORBIDDEN while stack.yml ownership moves" >&2
    echo "$neg_out" >&2
    exit 1
  fi
  git -C "$tree" checkout -q -- package.json

  printf '%s\n' 'name: acme' >>"$tree/.dev/stack.yml"
  if [[ -e "$tree/config/product/zero-edit-exceptions.json" ]]; then
    echo "FAIL: stack ownership fixture must not plant an exception" >&2
    exit 1
  fi
  local pass_out pass
  set +e
  pass_out="$(run_zero_edit_capture "$tree" "$identity")"
  pass=$?
  set -e
  if [[ "$pass" -ne 0 || "$pass_out" == *"FORBIDDEN .dev/stack.yml"* || "$pass_out" != *"mode=product"* ]]; then
    echo "FAIL: a product edit of .dev/stack.yml must pass zero-edit with no exception" >&2
    echo "$pass_out" >&2
    exit 1
  fi
  echo "dogfood stack ownership: product edit of .dev/stack.yml → pass (no exception)"
}
# Roxabi/roxabi-boilerplate-cf#260: working-tree checker, product mode. The self-sim clone is committed HEAD and
# does not yet contain this script; this fixture is what dogfood actually runs.
run_stack_contract_case() {
  local tree="$1"
  local scanner="$ROOT/scripts/kit/check-stack-contract.ts"
  rm -rf "$tree"
  git init -q -b main "$tree"
  mkdir -p "$tree/.dev"
  cat >"$tree/.dev/stack.yml" <<'EOF'
schema_version: "1.0"
name: cf-chemin-a
landing:
  mode: merge-on-green
commands:
  validate: bun run validate
  validate_full: bun run validate:full
  lint: bun run lint
  test: bun run test
  typecheck: bun run typecheck
  zero_edit: bun run zero-edit
  quality_gates_check: bun run quality-gates:check
  worktree_setup: scripts/kit/worktree-setup.sh
release:
  model: trunk
  component: roxabi-boilerplate-cf
worktree:
  copy: []
  seed: []
  setup: bash scripts/kit/worktree-setup.sh
EOF
  git -C "$tree" add -A
  LEFTHOOK=0 git -C "$tree" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: kit tip"
  local tip
  tip="$(git -C "$tree" rev-parse HEAD)"
  mkdir -p "$tree/config/product"
  printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${tip}\"}" >"$tree/config/product/inheritance.json"
  git -C "$tree" add -A
  LEFTHOOK=0 git -C "$tree" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: pin inheritance"
  python3 - "$tree/.dev/stack.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
text = text.replace("name: cf-chemin-a", "name: acme", 1)
text = text.replace("component: roxabi-boilerplate-cf", "component: acme", 1)
p.write_text(text)
PY
  local out rc
  set +e
  out="$(STACK_CONTRACT_ROOT="$tree" bun "$scanner" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 || "$out" != *"check-stack-contract: OK (product)"* ]]; then
    echo "FAIL: a filled product .dev/stack.yml must pass stack-contract" >&2
    echo "$out" >&2
    exit 1
  fi
  printf '%s\n' 'review:' '  roster:' '    agents:' '      R-tester: never' >>"$tree/.dev/stack.yml"
  set +e
  out="$(STACK_CONTRACT_ROOT="$tree" bun "$scanner" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 || "$out" != *"review.roster never override not in upstream: R-tester"* ]]; then
    echo "FAIL: a new review.roster never override must fail stack-contract" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "dogfood stack contract: filled product → pass; new never → fail"
}

# Fixture plumbing for the marker-lineage and exception-expiry cases below (ADR-0009 D4 threat model).
fx_git() {
  local tree="$1"
  shift
  LEFTHOOK=0 git -C "$tree" -c user.email=dogfood@example.com -c user.name=dogfood "$@"
}

fx_commit() {
  local tree="$1"
  local msg="$2"
  git -C "$tree" add -A
  fx_git "$tree" commit -q -m "$msg"
}

# assert_zero_edit <label> <tree> <0|1> <needle>: product-mode run of the working-tree checker.
assert_zero_edit() {
  local label="$1" tree="$2" want_rc="$3" needle="$4"
  local out rc ok=1
  set +e
  out="$(run_zero_edit_capture "$tree" "$SELF_SIM_PRODUCT_IDENTITY")"
  rc=$?
  set -e
  if [[ "$want_rc" == "0" ]]; then
    [[ "$rc" -eq 0 ]] || ok=0
  else
    [[ "$rc" -ne 0 ]] || ok=0
  fi
  [[ "$out" == *"$needle"* ]] || ok=0
  if [[ "$ok" -ne 1 ]]; then
    echo "FAIL: ${label} (want rc=${want_rc} with '${needle}', got rc=${rc})" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "dogfood lineage/expiry: ${label}"
}

# Kit tip carrying the working-tree checker + zones, so the fixture exercises the code under test
# (a committed-HEAD clone would run the checker the tip was cut with).
seed_fixture_kit() {
  local tree="$1"
  rm -rf "$tree"
  git init -q -b main "$tree"
  mkdir -p "$tree/config/kit" "$tree/scripts/kit"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
  cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$tree/scripts/kit/check-zero-edit-zones.sh"
  printf '%s\n' '{ "name": "kit" }' >"$tree/package.json"
  printf '%s\n' '# kit' >"$tree/README.md"
  fx_commit "$tree" "chore: kit tip"
}

# Product fixture that uses the working-tree checker and forces Git's C-style quoting. The paths in
# the cases below must still be reported readably by the checker.
seed_nonascii_product_fixture() {
  local tree="$1" inherited_path="${2:-}" base
  seed_fixture_kit "$tree"
  git -C "$tree" config core.quotePath true
  if [[ -n "$inherited_path" ]]; then
    mkdir -p "$tree/$(dirname "$inherited_path")"
    printf '%s\n' 'export const inherited = true' >"$tree/$inherited_path"
    fx_commit "$tree" "chore: seed inherited non-ASCII path"
  fi
  base="$(git -C "$tree" rev-parse HEAD)"
  write_inheritance "$tree" "$base"
  fx_commit "$tree" "chore: pin inheritance"
}

# Git quotes non-ASCII paths by default. Exercise every changed-path listing through the actual
# product-mode checker, with one isolated repository per source; the staged addition is index-only.
run_nonascii_path_cases() {
  local work="$1" tree path
  rm -rf "$work"
  mkdir -p "$work"

  tree="$work/clean"
  seed_nonascii_product_fixture "$tree"
  assert_zero_edit "clean product mode with core.quotePath=true → accepted" \
    "$tree" 0 "OK (product mode"

  tree="$work/product-owned"
  seed_nonascii_product_fixture "$tree"
  path="apps/acme-web/équipe.ts"
  mkdir -p "$tree/$(dirname "$path")"
  printf '%s\n' 'export const productOwned = true' >"$tree/$path"
  fx_commit "$tree" "feat: product-owned non-ASCII path"
  assert_zero_edit "product-owned non-ASCII path → accepted" "$tree" 0 "OK (product mode"

  tree="$work/committed-addition"
  seed_nonascii_product_fixture "$tree"
  path="packages/équipe/committed-addition.ts"
  mkdir -p "$tree/$(dirname "$path")"
  printf '%s\n' 'export const added = true' >"$tree/$path"
  fx_commit "$tree" "feat: protected non-ASCII addition"
  assert_zero_edit "committed protected non-ASCII addition → FORBIDDEN" \
    "$tree" 1 "FORBIDDEN ${path}"

  tree="$work/committed-edit"
  path="packages/équipe/committed-edit.ts"
  seed_nonascii_product_fixture "$tree" "$path"
  printf '%s\n' 'export const inherited = false' >"$tree/$path"
  fx_commit "$tree" "feat: protected non-ASCII edit"
  assert_zero_edit "committed protected non-ASCII edit → FORBIDDEN" \
    "$tree" 1 "FORBIDDEN ${path}"

  tree="$work/unstaged-edit"
  path="packages/équipe/unstaged-edit.ts"
  seed_nonascii_product_fixture "$tree" "$path"
  printf '%s\n' 'export const inherited = false' >"$tree/$path"
  assert_zero_edit "unstaged tracked protected non-ASCII edit → FORBIDDEN" \
    "$tree" 1 "FORBIDDEN ${path}"

  tree="$work/staged-addition"
  seed_nonascii_product_fixture "$tree"
  path="packages/équipe/staged-addition.ts"
  mkdir -p "$tree/$(dirname "$path")"
  printf '%s\n' 'export const staged = true' >"$tree/$path"
  git -C "$tree" add -- "$path"
  rm -f -- "$tree/$path"
  assert_zero_edit "index-only staged protected non-ASCII addition → FORBIDDEN" \
    "$tree" 1 "FORBIDDEN ${path}"

  tree="$work/untracked-addition"
  seed_nonascii_product_fixture "$tree"
  path="packages/équipe/untracked-addition.ts"
  mkdir -p "$tree/$(dirname "$path")"
  printf '%s\n' 'export const untracked = true' >"$tree/$path"
  assert_zero_edit "untracked protected non-ASCII addition → FORBIDDEN" \
    "$tree" 1 "FORBIDDEN ${path}"
}

# The marker must point at an inherited kit/mirror tip. Accepted: mirror chain, re-inherit of a newer
# tip. Refused: the delete-and-re-add launder and a base that is a product commit (RED-01).
run_base_lineage_cases() {
  local work="$1"
  rm -rf "$work"
  mkdir -p "$work"

  # kit → mirror (adds the silex-only feedback package + docs/product note) → product
  seed_fixture_kit "$work/kit"
  git clone -q "file://$work/kit" "$work/mirror"
  mkdir -p "$work/mirror/packages/feedback" "$work/mirror/docs/product"
  printf '%s\n' '{ "name": "@kit/feedback" }' >"$work/mirror/packages/feedback/package.json"
  printf '%s\n' '# feedback org' >"$work/mirror/docs/product/spark-feedback-org.md"
  fx_commit "$work/mirror" "feat: mirror adds feedback"
  local mirror_tip
  mirror_tip="$(git -C "$work/mirror" rev-parse HEAD)"
  git clone -q "file://$work/mirror" "$work/product"
  write_inheritance "$work/product" "$mirror_tip"
  fx_commit "$work/product" "chore: pin inheritance to mirror tip"
  mkdir -p "$work/product/apps/acme-web" "$work/product/config/product"
  printf '%s\n' 'export {}' >"$work/product/apps/acme-web/index.ts"
  printf '%s\n' '{}' >"$work/product/config/product/acme.json"
  fx_commit "$work/product" "feat: product app"

  assert_zero_edit "mirror chain: product pinned to the mirror tip → accepted" \
    "$work/product" 0 "OK (product mode, base=${mirror_tip}"
  local mirror_out mirror_rc
  set +e
  mirror_out="$(run_zero_edit_capture "$work/mirror" "$SELF_SIM_MIRROR_IDENTITY")"
  mirror_rc=$?
  set -e
  if [[ "$mirror_rc" -ne 0 || "$mirror_out" != *"mode=kit"* ]]; then
    echo "FAIL: mirror chain: the mirror must stay kit mode" >&2
    echo "$mirror_out" >&2
    exit 1
  fi

  # Legit re-inherit: the mirror ships a kit-path change, the product merges it and moves the marker.
  printf '%s\n' '{ "name": "kit", "mirror": 2 }' >"$work/mirror/package.json"
  fx_commit "$work/mirror" "chore: mirror advances"
  local tip2
  tip2="$(git -C "$work/mirror" rev-parse HEAD)"
  fx_git "$work/product" fetch -q origin
  fx_git "$work/product" merge -q --no-edit "$tip2"
  write_inheritance "$work/product" "$tip2"
  fx_commit "$work/product" "chore: re-inherit mirror tip"
  assert_zero_edit "legit re-inherit: marker moved to a newer mirror tip → accepted" \
    "$work/product" 0 "OK (product mode, base=${tip2}"

  # Launder (a): C1 deletes the marker and edits a kit file, C2 re-adds the marker pinned to C1.
  local lt="$work/launder-readd" c1
  git clone -q "file://$work/product" "$lt"
  git -C "$lt" rm -q config/product/inheritance.json
  printf '%s\n' '{ "name": "kit", "tampered": true }' >"$lt/package.json"
  fx_commit "$lt" "chore: tamper (drops marker)"
  c1="$(git -C "$lt" rev-parse HEAD)"
  write_inheritance "$lt" "$c1"
  fx_commit "$lt" "chore: re-add marker at the tampering commit"
  if [[ -n "$(git -C "$lt" diff --name-only "$c1" HEAD -- package.json)" ]]; then
    echo "FAIL: launder (a) fixture must leave no protected diff against the pinned base" >&2
    exit 1
  fi
  assert_zero_edit "launder (a): marker deleted then re-added at the editing commit → refused" \
    "$lt" 1 "descends from"

  # Launder (b): the marker stays, but is moved onto a product commit that edited a kit file.
  lt="$work/launder-product-base"
  git clone -q "file://$work/product" "$lt"
  printf '%s\n' '{ "name": "kit", "tampered": true }' >"$lt/package.json"
  fx_commit "$lt" "chore: tamper"
  c1="$(git -C "$lt" rev-parse HEAD)"
  write_inheritance "$lt" "$c1"
  fx_commit "$lt" "chore: re-pin to a product commit"
  if [[ -n "$(git -C "$lt" diff --name-only "$c1" HEAD -- package.json)" ]]; then
    echo "FAIL: launder (b) fixture must leave no protected diff against the pinned base" >&2
    exit 1
  fi
  assert_zero_edit "launder (b): marker pinned to a product commit → refused" \
    "$lt" 1 "descends from"

  # A shallow clone cannot prove the lineage: fail closed, never skip.
  lt="$work/shallow"
  # depth 3 keeps the pinned tip (second parent of the re-inherit merge) but cuts the older history.
  git clone -q --depth 3 "file://$work/product" "$lt"
  assert_zero_edit "shallow clone: lineage unverifiable → refused" "$lt" 1 "shallow clone"
}

# today + N days as YYYY-MM-DD in the checker's local calendar.
day_in() {
  node -e '
    const d = new Date(); d.setDate(d.getDate() + Number(process.argv[1]));
    const p = (n) => String(n).padStart(2, "0");
    console.log(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  ' "$1"
}

# write_exceptions <file> <path> <expires> [<path> <expires> ...]
write_exceptions() {
  local file="$1" body="" sep=""
  shift
  while [[ $# -ge 2 ]]; do
    body+="${sep}{\"path\":\"$1\",\"reason\":\"dogfood fixture reason\",\"owner\":\"dogfood\",\"expires\":\"$2\",\"ticket\":\"https://example.com/ticket/1\",\"alternatives_considered\":[\"design override\"],\"why_not_alternative\":\"design override cannot express this\"}"
    sep=","
    shift 2
  done
  mkdir -p "$(dirname "$file")"
  printf '{"version":1,"exceptions":[%s]}\n' "$body" >"$file"
}

# Exceptions are capped from the day their expiry was granted; earlier grants are grandfathered.
run_exception_expiry_cases() {
  local tree="$1"
  local ex="$tree/config/product/zero-edit-exceptions.json"
  local legacy_date="2026-01-01T12:00:00+00:00" # before zones exception_expiry.effective_from
  local d30 d60 d120
  d30="$(day_in 30)"
  d60="$(day_in 60)"
  d120="$(day_in 120)"

  seed_fixture_kit "$tree"
  write_inheritance "$tree" "$(git -C "$tree" rev-parse HEAD)"
  fx_commit "$tree" "chore: pin inheritance"
  printf '%s\n' '{ "name": "acme" }' >"$tree/package.json"
  # README.md is edited together with its exception below.

  # Legacy: granted before the effective date, far beyond the cap → grandfathered.
  write_exceptions "$ex" package.json 2099-12-31
  GIT_AUTHOR_DATE="$legacy_date" fx_commit "$tree" "chore: legacy exception"
  assert_zero_edit "legacy exception (granted before the cap) beyond 90 days → accepted" \
    "$tree" 0 "OK  package.json"

  # New entry within the cap → accepted; same entry pushed past the cap → refused.
  printf '%s\n' '# acme' >"$tree/README.md"
  write_exceptions "$ex" package.json 2099-12-31 README.md "$d60"
  fx_commit "$tree" "chore: new exception within the cap"
  assert_zero_edit "new exception within 90 days → accepted" "$tree" 0 "OK  README.md"
  write_exceptions "$ex" package.json 2099-12-31 README.md "$d120"
  fx_commit "$tree" "chore: extend the new exception"
  assert_zero_edit "new exception beyond 90 days → refused (legacy one not flagged)" \
    "$tree" 1 "OVER CAP README.md"
  if run_zero_edit_capture "$tree" "$SELF_SIM_PRODUCT_IDENTITY" | grep -q "OVER CAP package.json"; then
    echo "FAIL: the grandfathered legacy exception must not be flagged" >&2
    exit 1
  fi

  # Shortening never re-dates a grant; extending a legacy exception does.
  write_exceptions "$ex" package.json 2099-12-31 README.md "$d60"
  fx_commit "$tree" "chore: shorten the new exception"
  assert_zero_edit "shortened exception → accepted" "$tree" 0 "OK  README.md"
  write_exceptions "$ex" package.json 2098-12-31 README.md "$d60"
  fx_commit "$tree" "chore: shorten the legacy exception"
  assert_zero_edit "legacy exception shortened (still beyond 90 days) → accepted" \
    "$tree" 0 "OK  package.json"
  write_exceptions "$ex" package.json 2100-12-31 README.md "$d60"
  fx_commit "$tree" "chore: extend the legacy exception"
  assert_zero_edit "legacy exception extended after the effective date → refused" \
    "$tree" 1 "OVER CAP package.json"
  write_exceptions "$ex" package.json "$d30" README.md "$d60"
  fx_commit "$tree" "chore: shorten within the cap"
  assert_zero_edit "extension cut back within 90 days → accepted" "$tree" 0 "OK  package.json"

  # Uncommitted edits count as granted today.
  write_exceptions "$ex" package.json "$d30" README.md "$d120"
  assert_zero_edit "uncommitted extension beyond 90 days → refused" "$tree" 1 "OVER CAP README.md"
}

assert_no_push() {
  local tree="${1:-.}"
  local push_url
  push_url="$(git -C "$tree" remote get-url --push upstream 2>/dev/null || true)"
  if [[ "$push_url" != "no_push" ]]; then
    echo "FAIL: upstream push URL must be 'no_push' (got: ${push_url:-empty})" >&2
    exit 1
  fi
}

write_inheritance() {
  local tree="$1"
  local sha="$2"
  mkdir -p "$tree/config/product"
  printf '%s\n' "{\"version\":1,\"upstreamCommit\":\"${sha}\"}" >"$tree/config/product/inheritance.json"
}

assert_distinct_shas() {
  local a="$1"
  local b="$2"
  local c="$3"
  if [[ "$a" == "$b" || "$a" == "$c" || "$b" == "$c" ]]; then
    echo "FAIL: expected three distinct commit SHAs (kit=${a:0:12} mirror=${b:0:12} product=${c:0:12})" >&2
    exit 1
  fi
}

# Seed kit fixture at exact source HEAD — works on named branches and detached HEAD (CI).
seed_kit_from_head() {
  local dest="$1"
  local source="$2"
  local want_head
  want_head="$(git -C "$source" rev-parse HEAD)"
  rm -rf "$dest"
  git init -q "$dest"
  git -C "$dest" remote add kit-seed "file://${source}"
  git -C "$dest" -c user.email=dogfood@example.com -c user.name=dogfood fetch -q kit-seed HEAD
  git -C "$dest" checkout -q -B main FETCH_HEAD
  local got_head
  got_head="$(git -C "$dest" rev-parse HEAD)"
  if [[ "$got_head" != "$want_head" ]]; then
    echo "FAIL: kit seed HEAD mismatch (want ${want_head}, got ${got_head})" >&2
    exit 1
  fi
}

run_self_sim_chain() {
  local source_root="$1"
  local work="$2"
  local label="$3"

  echo "== dogfood chain (${label}): source=$(git -C "$source_root" rev-parse --short HEAD) =="

  seed_kit_from_head "$work/kit" "$source_root"
  local KIT_TIP MIRROR_TIP PRODUCT_TIP STALE_REF STALE_HITS
  KIT_TIP="$(git -C "$work/kit" rev-parse HEAD)"

  git clone "file://$work/kit" "$work/mirror"
  git -C "$work/mirror" remote set-url origin "https://github.com/go-silex/silex-boilerplate.git"
  mkdir -p "$work/mirror/config/product"
  printf '%s\n' '{"version":1,"chain":"mirror"}' >"$work/mirror/config/product/mirror-stamp.json"
  printf '\n<!-- dogfood mirror inherit -->\n' >>"$work/mirror/README.md"
  git -C "$work/mirror" add config/product/mirror-stamp.json README.md
  LEFTHOOK=0 git -C "$work/mirror" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: mirror stamp for dogfood chain"
  MIRROR_TIP="$(git -C "$work/mirror" rev-parse HEAD)"

  git clone "file://$work/mirror" "$work/product"
  git -C "$work/product" remote rename origin kit-origin
  git -C "$work/product" remote add origin "https://github.com/example/acme-product.git"
  git -C "$work/product" remote add upstream "file://$work/mirror"
  git -C "$work/product" remote set-url --push upstream no_push

  write_inheritance "$work/product" "$MIRROR_TIP"
  git -C "$work/product" add config/product/inheritance.json
  LEFTHOOK=0 git -C "$work/product" -c user.email=dogfood@example.com -c user.name=dogfood \
    commit -q -m "chore: pin inheritance to mirror tip"
  PRODUCT_TIP="$(git -C "$work/product" rev-parse HEAD)"

  assert_distinct_shas "$KIT_TIP" "$MIRROR_TIP" "$PRODUCT_TIP"

  git -C "$work/product" update-ref "refs/remotes/upstream/main" "$KIT_TIP"
  STALE_REF="$(git -C "$work/product" rev-parse refs/remotes/upstream/main)"
  if [[ "$STALE_REF" == "$MIRROR_TIP" ]]; then
    echo "FAIL: stale upstream/main ref must differ from inheritance upstreamCommit" >&2
    exit 1
  fi

  assert_no_push "$work/product"

  if [[ -f "$work/mirror/config/product/inheritance.json" ]]; then
    echo "FAIL: mirror must not carry product inheritance marker" >&2
    exit 1
  fi
  run_gates "$work/mirror" "$SELF_SIM_MIRROR_IDENTITY"
  run_gates "$work/product" "$SELF_SIM_PRODUCT_IDENTITY"

  STALE_HITS="$(git -C "$work/product" diff --name-only "$STALE_REF" HEAD -- README.md package.json 2>/dev/null || true)"
  if [[ -z "$STALE_HITS" ]]; then
    echo "FAIL: expected stale upstream/main to differ from inheritance base on protected paths (Roxabi/roxabi-boilerplate-cf#103 fixture)" >&2
    exit 1
  fi
  echo "dogfood Roxabi/roxabi-boilerplate-cf#103 (${label}): stale upstream/main would flag: $(echo "$STALE_HITS" | tr '\n' ' ')"

  # Roxabi/roxabi-boilerplate-cf#259: the product inherits the tracker contract unchanged (the gates above passed with it).
  if [[ -z "$(git -C "$work/product" ls-files -- docs/agents/issue-tracker.md)" ]]; then
    echo "FAIL: product fixture must track the inherited docs/agents/issue-tracker.md" >&2
    exit 1
  fi

  echo "/* dogfood dual-edit probe */" >>"$work/product/package.json"
  set +e
  neg_out="$(run_zero_edit_capture "$work/product" "$SELF_SIM_PRODUCT_IDENTITY")"
  neg=$?
  set -e
  if [[ "$neg" -eq 0 ]]; then
    echo "FAIL: expected zero-edit to fail after package.json dual-edit" >&2
    echo "$neg_out" >&2
    exit 1
  fi
  if [[ "$neg_out" != *"mode=product identity=${SELF_SIM_PRODUCT_IDENTITY}"* ]]; then
    echo "FAIL: negative zero-edit must run in product mode with fixture identity (got contamination from outer GITHUB_REPOSITORY?)" >&2
    echo "$neg_out" >&2
    exit 1
  fi
  if [[ "$neg_out" == *"inheritance marker present on kit-allowlisted origin"* ]]; then
    echo "FAIL: negative test failed for identity contamination, not dual-edit" >&2
    echo "$neg_out" >&2
    exit 1
  fi
  if [[ "$neg_out" != *"FORBIDDEN package.json"* ]]; then
    echo "FAIL: negative test must fail specifically on FORBIDDEN package.json" >&2
    echo "$neg_out" >&2
    exit 1
  fi

  # Roxabi/roxabi-boilerplate-cf#259: the contract is kit-owned — a product edit is a dual-edit, not an extension point.
  echo "<!-- dogfood dual-edit probe -->" >>"$work/product/docs/agents/issue-tracker.md"
  set +e
  neg_out="$(run_zero_edit_capture "$work/product" "$SELF_SIM_PRODUCT_IDENTITY")"
  neg=$?
  set -e
  if [[ "$neg" -eq 0 || "$neg_out" != *"FORBIDDEN docs/agents/issue-tracker.md"* ]]; then
    echo "FAIL: a product edit of docs/agents/issue-tracker.md must be FORBIDDEN" >&2
    echo "$neg_out" >&2
    exit 1
  fi

  # Roxabi/roxabi-boilerplate-cf#422: Knip takes the workspace set from a root pnpm-workspace.yaml
  # whatever --config names; the kit ships none, so a product file is FORBIDDEN, untracked included.
  # The probes above stay applied: only the needle proves this path, not the exit code.
  printf '%s\n' 'packages:' "  - 'apps/*'" "  - '!apps/dogfood-hidden'" >"$work/product/pnpm-workspace.yaml"
  set +e
  neg_out="$(run_zero_edit_capture "$work/product" "$SELF_SIM_PRODUCT_IDENTITY")"
  neg=$?
  set -e
  if [[ "$neg" -eq 0 || "$neg_out" != *"FORBIDDEN pnpm-workspace.yaml"* ]]; then
    echo "FAIL: a product root pnpm-workspace.yaml must be FORBIDDEN" >&2
    echo "$neg_out" >&2
    exit 1
  fi

  set +e
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -C "$work/product" \
    bash "$DENY_SCRIPT" upstream "file://$work/mirror"
  local deny=$?
  set -e
  if [[ "$deny" -ne 1 ]]; then
    echo "FAIL: deny-upstream must block product push to remote name upstream (exit 1, got ${deny})" >&2
    exit 1
  fi
}

# Independent public root (new git init — not seed_kit_from_head). Direct and mirror-mediated
# products each merge that root once with --allow-unrelated-histories, then ordinary-upgrade.
# License states, not a topology matrix: direct differs, mediated matches public P0, one
# direct-topology journey has no LICENSE. Both merges are --no-ff --no-commit. Presence and
# bytes are restored from the pre-merge HEAD before the unprotected conflict resolver.
# Disposable file:// transport only; identity comes from fixture origins, never from env overrides.
pc_fail() {
  echo "FAIL: publication continuity: $*" >&2
  exit 1
}

pc_scrub() {
  env -u GITHUB_REPOSITORY -u ZERO_EDIT_MODE -u ZERO_EDIT_HARNESS_SENTINEL \
    -u EXTRACT_MODE -u EXTRACT_HARNESS_SENTINEL -u ZERO_EDIT_BASE_REF \
    "$@"
}

pc_classify() {
  local tree="$1" want_mode="$2" want_id="$3" out
  out="$(pc_scrub ROOT="$tree" node "$ROOT/scripts/kit/resolve-tree-identity.mjs")"
  if [[ "$out" != "mode=${want_mode} identity=${want_id}" ]]; then
    pc_fail "${tree} classify want mode=${want_mode} identity=${want_id}, got ${out}"
  fi
}

pc_zero() {
  local tree="$1" want_rc="$2"
  shift 2
  local out rc=0 needle
  set +e
  out="$(pc_scrub ZERO_EDIT_ROOT="$tree" bash "$ZERO_SCRIPT" 2>&1)"
  rc=$?
  set -e
  if [[ "$want_rc" == "0" && "$rc" -ne 0 ]] || [[ "$want_rc" != "0" && "$rc" -eq 0 ]]; then
    pc_fail "zero-edit ${tree} want rc=${want_rc} got ${rc}: ${out}"
  fi
  for needle in "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      pc_fail "zero-edit ${tree} missing '${needle}': ${out}"
    fi
  done
}

pc_stack() {
  local tree="$1" out rc=0
  set +e
  out="$(pc_scrub STACK_CONTRACT_ROOT="$tree" bun "$ROOT/scripts/kit/check-stack-contract.ts" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 || "$out" != *"check-stack-contract: OK (product)"* ]]; then
    pc_fail "stack-contract ${tree}: ${out}"
  fi
}

pc_merge() {
  local tree="$1"
  shift
  local out rc=0
  set +e
  out="$(fx_git "$tree" merge "$@" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -gt 1 || "$out" == *"refusing to merge unrelated histories"* ]]; then
    pc_fail "merge ($*) rc=${rc}: ${out}"
  fi
}

pc_origin() {
  printf 'https://github.com/%s.git' "$1"
}

pc_init() {
  local tree="$1" identity="$2"
  rm -rf "$tree"
  git init -q -b main "$tree"
  git -C "$tree" config core.autocrlf false
  git -C "$tree" remote add origin "$(pc_origin "$identity")"
}

pc_kit_baseline() {
  local tree="$1" pkg="$2" readme="$3" catalog="$4"
  mkdir -p "$tree/config/kit" "$tree/scripts/kit" "$tree/packages/continuity" "$tree/.dev"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$tree/config/kit/zero-edit-zones.json"
  cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$tree/scripts/kit/check-zero-edit-zones.sh"
  printf '%s\n' "$pkg" >"$tree/package.json"
  printf '%s\n' "$readme" >"$tree/README.md"
  printf '%s\n' "$catalog" >"$tree/config/kit/kit-schema-modules.json"
  printf '%s\n' "$catalog" >"$tree/packages/continuity/note.txt"
}

pc_write_public_stack() {
  cat >"$1/.dev/stack.yml" <<'EOF'
schema_version: "1.0"
name: cf-chemin-a
landing:
  mode: merge-on-green
commands:
  validate: bun run validate
  validate_full: bun run validate:full
  lint: bun run lint
  test: bun run test
  typecheck: bun run typecheck
  zero_edit: bun run zero-edit
  quality_gates_check: bun run quality-gates:check
  worktree_setup: scripts/kit/worktree-setup.sh
release:
  model: trunk
  component: roxabi-boilerplate-cf
backend:
  path: apps/example-api
frontend:
  path: apps/example-web
worktree:
  copy: []
  seed: []
  setup: bash scripts/kit/worktree-setup.sh
EOF
}

pc_derive_product_stack() {
  node -e '
    const fs = require("node:fs")
    let text = fs.readFileSync(process.argv[1], "utf8")
    const reps = [
      ["name: cf-chemin-a", "name: acme"],
      ["component: roxabi-boilerplate-cf", "component: acme"],
      ["path: apps/example-api", "path: apps/acme-api"],
      ["path: apps/example-web", "path: apps/acme-web"],
      ["copy: []", "copy:\n    - apps/acme-api/.dev.vars"],
    ]
    for (const [from, to] of reps) {
      if (!text.includes(from)) process.exit(2)
      text = text.replace(from, to)
    }
    fs.writeFileSync(process.argv[2], text)
  ' "$1" "$2"
}

pc_resolve_kit() {
  local tree="$1" sha="$2" exception="$3"
  node - "$tree" "$sha" "$exception" <<'NODE'
const { execFileSync } = require("node:child_process")
const tree = process.argv[2]
const sha = process.argv[3]
const exception = process.argv[4]
const git = (args, opts = {}) =>
  execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", ...opts })
const zones = JSON.parse(git(["show", sha + ":config/kit/zero-edit-zones.json"]))
const prefs = zones.protected_prefixes
const files = new Set(zones.protected_files)
const kit = (p) =>
  files.has(p) || prefs.some((pref) => p === pref.replace(/\/$/, "") || p.startsWith(pref))
const list = (rev) => git(["ls-tree", "-r", "--name-only", rev]).split("\n").filter(Boolean)
const ours = new Set(list("HEAD"))
const theirs = new Set(list(sha))
for (const p of new Set([...ours, ...theirs])) {
  if (!kit(p) || p === exception) continue
  if (theirs.has(p)) git(["checkout", "-q", sha, "--", p], { stdio: "inherit" })
  else if (ours.has(p)) git(["rm", "-q", "-f", "--", p], { stdio: "inherit" })
}
NODE
  git -C "$tree" checkout -q HEAD -- "$exception"
  git -C "$tree" add -- "$exception"
  local path
  # Before --ours. A missing pre-merge LICENSE must drop a P0 auto-add and clear a
  # P1 modify/delete. A present one is restored even when the upgrade is clean.
  if git -C "$tree" cat-file -e 'HEAD:LICENSE'; then
    git -C "$tree" checkout -q HEAD -- LICENSE
  else
    git -C "$tree" rm -q -f --ignore-unmatch -- LICENSE
  fi
  git -C "$tree" diff --quiet HEAD -- LICENSE || pc_fail "root notice was not restored to pre-merge HEAD"
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    git -C "$tree" checkout -q --ours -- "$path"
    git -C "$tree" add -- "$path"
  done < <(git -C "$tree" diff --name-only --diff-filter=U)
  if [[ -n "$(git -C "$tree" diff --name-only --diff-filter=U)" ]]; then
    pc_fail "unresolved conflicts in ${tree}"
  fi
}

pc_snapshot() {
  local tree="$1" dest="$2"
  mkdir -p "$dest"
  cp "$tree/README.md" "$dest/README.md"
  cp "$tree/.dev/stack.yml" "$dest/stack.yml"
  cp "$tree/config/product/zero-edit-exceptions.json" "$dest/exceptions.json"
  if [[ -e "$tree/LICENSE" ]]; then
    cp "$tree/LICENSE" "$dest/LICENSE"
  else
    rm -f "$dest/LICENSE"
  fi
  cp "$tree/apps/acme-web/index.ts" "$dest/app.ts"
  cp "$tree/config/product/acme.json" "$dest/acme.json"
  cp "$tree/apps/acme-api/migrations/0001_kit_init.sql" "$dest/0001_kit_init.sql"
  cp "$tree/apps/acme-api/migrations/0009_lgu_domain.sql" "$dest/0009_lgu_domain.sql"
  cp "$tree/apps/acme-api/kit-schema-manifest.json" "$dest/manifest.json"
}

pc_sha256() {
  node -e '
    const fs = require("node:fs")
    const crypto = require("node:crypto")
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))
  ' "$1"
}

pc_assert_preserved() {
  local tree="$1" snap="$2" label="$3" sha
  cmp -s "$tree/README.md" "$snap/README.md" || pc_fail "${label} README patch lost"
  if [[ -e "$snap/LICENSE" ]]; then
    cmp -s "$tree/LICENSE" "$snap/LICENSE" || pc_fail "${label} root notice lost"
  else
    test ! -e "$tree/LICENSE" || pc_fail "${label} root notice added"
  fi
  cmp -s "$tree/.dev/stack.yml" "$snap/stack.yml" || pc_fail "${label} stack overrides lost"
  cmp -s "$tree/config/product/zero-edit-exceptions.json" "$snap/exceptions.json" || pc_fail "${label} exception lost"
  cmp -s "$tree/apps/acme-web/index.ts" "$snap/app.ts" || pc_fail "${label} product app lost"
  cmp -s "$tree/config/product/acme.json" "$snap/acme.json" || pc_fail "${label} product file lost"
  cmp -s "$tree/apps/acme-api/migrations/0001_kit_init.sql" "$snap/0001_kit_init.sql" || pc_fail "${label} applied kit SQL bytes lost"
  cmp -s "$tree/apps/acme-api/migrations/0009_lgu_domain.sql" "$snap/0009_lgu_domain.sql" || pc_fail "${label} domain SQL bytes lost"
  cmp -s "$tree/apps/acme-api/kit-schema-manifest.json" "$snap/manifest.json" || pc_fail "${label} schema manifest lost"
  test -f "$tree/apps/acme-api/migrations/0001_kit_init.sql" || pc_fail "${label} kit SQL filename renamed"
  test -f "$tree/apps/acme-api/migrations/0009_lgu_domain.sql" || pc_fail "${label} domain SQL filename renamed"
  sha="$(pc_sha256 "$snap/0001_kit_init.sql")"
  node -e '
    const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const init = m.modules && m.modules.init
    if (!init || init.productFile !== "migrations/0001_kit_init.sql" || init.kitSha256 !== process.argv[2]) process.exit(1)
  ' "$tree/apps/acme-api/kit-schema-manifest.json" "$sha" || pc_fail "${label} manifest identity drifted"
  test ! -e "$tree/.nvmrc" || pc_fail "${label} retired .nvmrc kept"
  test ! -e "$tree/packages/retired/retired.txt" || pc_fail "${label} retired kit path kept"
}

pc_assert_public_kit() {
  local tree="$1" public_dir="$2" pin="$3" label="$4" rel
  for rel in package.json packages/continuity/note.txt config/kit/kit-schema-modules.json; do
    git -C "$public_dir" show "${pin}:${rel}" >"$tree/.pc-public-blob"
    cmp -s "$tree/$rel" "$tree/.pc-public-blob" || pc_fail "${label} ${rel} is not public ${pin:0:12}"
  done
  rm -f "$tree/.pc-public-blob"
}

pc_plant_product() {
  local tree="$1" pin="$2" label="$3" public_stack="$4" exp="$5" notice="${6:-}"
  local sql_init sql_domain manifest_sha
  pc_derive_product_stack "$public_stack" "$tree/.dev/stack.yml"
  printf '%s\n' '# acme exception patch' >"$tree/README.md"
  mkdir -p "$tree/apps/acme-web" "$tree/apps/acme-api/migrations" "$tree/config/product"
  if [[ "$notice" == "absent" ]]; then
    rm -f "$tree/LICENSE"
  elif [[ -n "$notice" ]]; then
    cp "$notice" "$tree/LICENSE"
  else
    printf '%s\n' 'Acme root notice' 'Owned by the product repository.' >"$tree/LICENSE"
  fi
  printf '%s\n' 'export const product = "acme"' >"$tree/apps/acme-web/index.ts"
  printf '%s\n' '{"product":"acme"}' >"$tree/config/product/acme.json"
  sql_init=$'-- applied kit init\nCREATE TABLE kit_init (id TEXT PRIMARY KEY);\n'
  sql_domain=$'-- product domain\nCREATE TABLE lgu_domain (id TEXT PRIMARY KEY);\n'
  printf '%s' "$sql_init" >"$tree/apps/acme-api/migrations/0001_kit_init.sql"
  printf '%s' "$sql_domain" >"$tree/apps/acme-api/migrations/0009_lgu_domain.sql"
  manifest_sha="$(pc_sha256 "$tree/apps/acme-api/migrations/0001_kit_init.sql")"
  node -e '
    const fs = require("node:fs")
    fs.writeFileSync(process.argv[1], JSON.stringify({
      version: 1,
      sets: ["core"],
      modules: { init: { kitSha256: process.argv[2], productFile: "migrations/0001_kit_init.sql" } },
    }, null, 2) + "\n")
  ' "$tree/apps/acme-api/kit-schema-manifest.json" "$manifest_sha"
  write_exceptions "$tree/config/product/zero-edit-exceptions.json" README.md "$exp"
  write_inheritance "$tree" "$pin"
  fx_commit "$tree" "chore: ${label} product payload"
}

pc_marker_intro() {
  # Consumer-line adds only. An unrelated merge adds this path relative to the public
  # parent; that second-parent add is not a rewrite. -1 --reverse returns the newest
  # add, so it cannot identify the original introduction after the merge.
  git -C "$1" log --first-parent --no-renames --diff-filter=A --format=%H -- config/product/inheritance.json
}

pc_finish_merge() {
  local tree="$1" sha="$2" msg="$3" parent="$4"
  write_inheritance "$tree" "$sha"
  git -C "$tree" add -- config/product/inheritance.json
  fx_git "$tree" commit -q -m "$msg"
  [[ "$(git -C "$tree" rev-parse 'HEAD^1')" == "$parent" ]] || pc_fail "${msg} first parent is not ${parent:0:12}"
  [[ "$(git -C "$tree" rev-parse 'HEAD^2')" == "$sha" ]] || pc_fail "${msg} second parent is not ${sha:0:12}"
}

pc_transition_consumer() {
  local tree="$1" label="$2" origin_id="$3" public_dir="$4" p0="$5" p1="$6"
  local old intro url
  old="$(git -C "$tree" rev-parse HEAD)"
  intro="$(pc_marker_intro "$tree")"
  [[ "$intro" =~ ^[0-9a-f]{40}$ ]] || pc_fail "${label} expected one marker introduction, got ${intro}"
  pc_classify "$tree" product "$origin_id"
  pc_zero "$tree" 0 "mode=product identity=${origin_id}" "OK  README.md"
  if git -C "$tree" remote get-url upstream >/dev/null 2>&1; then
    git -C "$tree" remote set-url upstream "$(pc_origin go-silex/unkillable-kit)"
  else
    git -C "$tree" remote add upstream "$(pc_origin go-silex/unkillable-kit)"
  fi
  git -C "$tree" remote set-url --push upstream no_push
  url="$(git -C "$tree" remote get-url upstream)"
  node -e '
    const id = process.argv[1].replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "")
    const z = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))
    if (id !== "go-silex/unkillable-kit" || !(z.kit_origin_allowlist || []).includes(id)) process.exit(1)
  ' "$url" "$tree/config/kit/zero-edit-zones.json" || pc_fail "${label} upstream identity not allowlisted"
  git -C "$tree" fetch -q "file://${public_dir}" '+refs/heads/*:refs/remotes/upstream/*'
  if git -C "$tree" merge-base --is-ancestor "$p0" HEAD >/dev/null 2>&1; then
    pc_fail "${label} histories already related to public P0"
  fi
  pc_merge "$tree" --allow-unrelated-histories --no-ff --no-commit "$p0"
  pc_resolve_kit "$tree" "$p0" README.md
  pc_finish_merge "$tree" "$p0" "chore: transition ${label} to independent public parent" "$old"
  [[ "$(git -C "$tree" rev-parse 'HEAD^1')" == "$old" ]] || pc_fail "${label} dropped old consumer tip"
  pc_classify "$tree" product "$origin_id"
  pc_zero "$tree" 0 "mode=product identity=${origin_id}" "OK (product mode, base=${p0}" "diverged_covered=1" "OK  README.md"
  pc_stack "$tree"
  pc_assert_preserved "$tree" "$tree.snap" "$label P0"
  pc_assert_public_kit "$tree" "$public_dir" "$p0" "$label P0"
  [[ "$(pc_marker_intro "$tree")" == "$intro" ]] || pc_fail "${label} marker introduction rewritten"
  [[ -z "$(git -C "$tree" diff --name-status --diff-filter=A "${old}" HEAD -- config/product/inheritance.json)" ]] || pc_fail "${label} merge re-added the marker"
  [[ -z "$(git -C "$tree" log --first-parent --no-renames --diff-filter=D --format=%H -- config/product/inheritance.json)" ]] || pc_fail "${label} marker deleted"
  echo "dogfood publication continuity: ${label} unrelated transition → gates"
  write_inheritance "$tree" "$p1"
  pc_zero "$tree" 1 "is not an ancestor of HEAD"
  git -C "$tree" checkout -q -- config/product/inheritance.json
  [[ -z "$(git -C "$tree" status --porcelain)" ]] || pc_fail "${label} negative pin left the tree dirty"
  echo "dogfood publication continuity: ${label} fetched-unmerged pin → refused"
  local transition
  transition="$(git -C "$tree" rev-parse HEAD)"
  pc_merge "$tree" --no-ff --no-commit "$p1"
  pc_resolve_kit "$tree" "$p1" README.md
  pc_finish_merge "$tree" "$p1" "chore: inherit ${label} public upgrade" "$transition"
  pc_classify "$tree" product "$origin_id"
  pc_zero "$tree" 0 "mode=product identity=${origin_id}" "OK (product mode, base=${p1}" "diverged_covered=1" "OK  README.md"
  pc_stack "$tree"
  pc_assert_preserved "$tree" "$tree.snap" "$label P1"
  pc_assert_public_kit "$tree" "$public_dir" "$p1" "$label P1"
  [[ "$(pc_marker_intro "$tree")" == "$intro" ]] || pc_fail "${label} upgrade rewrote marker introduction"
  [[ -z "$(git -C "$tree" diff --name-status --diff-filter=A "${transition}" HEAD -- config/product/inheritance.json)" ]] || pc_fail "${label} upgrade re-added the marker"
  git -C "$tree" merge-base --is-ancestor "$old" HEAD || pc_fail "${label} old tip is not an ancestor after upgrade"
  git -C "$tree" merge-base --is-ancestor "$p0" HEAD || pc_fail "${label} public P0 is not an ancestor after upgrade"
  [[ "$(git -C "$tree" remote get-url origin)" == "$(pc_origin "$origin_id")" ]] || pc_fail "${label} origin changed"
  assert_no_push "$tree"
  echo "dogfood publication continuity: ${label} ordinary upgrade → gates"
}

run_publication_continuity() {
  local work="$1" exp public private mirror direct mediated absent
  local p0 p1 private_tip mirror_tip
  rm -rf "$work"
  mkdir -p "$work"
  exp="$(day_in 60)"
  public="$work/public"
  pc_init "$public" go-silex/unkillable-kit
  pc_kit_baseline "$public" '{ "name": "kit" }' '# public kit' '{"id":"init","kitSha256":"public-catalog"}'
  pc_write_public_stack "$public"
  printf '%s\n' 'Public root notice' 'revision 0' >"$public/LICENSE"
  fx_commit "$public" "chore: independent public root"
  p0="$(git -C "$public" rev-parse HEAD)"
  git -C "$public" branch publish-p0
  printf '%s\n' '{ "name": "kit", "rev": 2 }' >"$public/package.json"
  printf '%s\n' 'Public root notice' 'revision 1' >"$public/LICENSE"
  fx_commit "$public" "chore: public protected-file upgrade"
  p1="$(git -C "$public" rev-parse HEAD)"
  p1_names="$(git -C "$public" diff --name-only "$p0" "$p1" | sort | paste -sd' ' -)"
  [[ "$p1_names" == "LICENSE package.json" ]] || pc_fail "P1 must change the root notice and package.json only, got ${p1_names}"
  test ! -e "$public/config/product/inheritance.json" || pc_fail "public root carries a product marker"
  pc_classify "$public" kit go-silex/unkillable-kit
  pc_zero "$public" 0 "mode=kit identity=go-silex/unkillable-kit" "OK (kit mode"
  private="$work/private"
  pc_init "$private" Roxabi/roxabi-boilerplate-cf
  pc_kit_baseline "$private" '{ "name": "private-kit" }' '# private kit' '{"id":"init","kitSha256":"private-catalog"}'
  printf '%s\n' 'name: private-kit' >"$private/.dev/stack.yml"
  printf '%s\n' '1' >"$private/.nvmrc"
  mkdir -p "$private/packages/retired"
  printf '%s\n' 'retired' >"$private/packages/retired/retired.txt"
  fx_commit "$private" "chore: legacy private root"
  private_tip="$(git -C "$private" rev-parse HEAD)"
  pc_classify "$private" kit Roxabi/roxabi-boilerplate-cf
  test ! -e "$private/config/product/inheritance.json"
  mirror="$work/mirror"
  git clone -q -c core.autocrlf=false "file://${private}" "$mirror"
  git -C "$mirror" remote set-url origin "$(pc_origin go-silex/silex-boilerplate)"
  mkdir -p "$mirror/config/product"
  printf '%s\n' '{"chain":"mirror"}' >"$mirror/config/product/mirror-stamp.json"
  fx_commit "$mirror" "chore: marker-free mirror stamp"
  mirror_tip="$(git -C "$mirror" rev-parse HEAD)"
  test ! -e "$mirror/config/product/inheritance.json" || pc_fail "mirror carries a product marker"
  pc_classify "$mirror" kit go-silex/silex-boilerplate
  pc_zero "$mirror" 0 "mode=kit identity=go-silex/silex-boilerplate" "OK (kit mode"
  direct="$work/direct"
  git clone -q -c core.autocrlf=false "file://${private}" "$direct"
  git -C "$direct" remote set-url origin "$(pc_origin example/acme-product)"
  git -C "$public" show "${p0}:LICENSE" >"$work/notice-p0"
  git -C "$public" show "${p1}:LICENSE" >"$work/notice-p1"
  cmp -s "$work/notice-p0" "$work/notice-p1" && pc_fail "public root notice did not change"
  pc_plant_product "$direct" "$private_tip" direct "$public/.dev/stack.yml" "$exp"
  pc_snapshot "$direct" "$direct.snap"
  cmp -s "$direct/LICENSE" "$work/notice-p0" && pc_fail "direct notice matches public P0"
  cmp -s "$direct/LICENSE" "$work/notice-p1" && pc_fail "direct notice matches public P1"
  mediated="$work/mediated"
  git clone -q -c core.autocrlf=false "file://${mirror}" "$mediated"
  git -C "$mediated" remote set-url origin "$(pc_origin example/acme-mediated)"
  pc_plant_product "$mediated" "$mirror_tip" mediated "$public/.dev/stack.yml" "$exp" "$work/notice-p0"
  pc_snapshot "$mediated" "$mediated.snap"
  cmp -s "$mediated/LICENSE" "$work/notice-p0" || pc_fail "mediated notice must match public P0"
  cmp -s "$mediated/LICENSE" "$work/notice-p1" && pc_fail "mediated notice matches public P1"
  absent="$work/absent"
  git clone -q -c core.autocrlf=false "file://${private}" "$absent"
  git -C "$absent" remote set-url origin "$(pc_origin example/acme-absent)"
  pc_plant_product "$absent" "$private_tip" absent "$public/.dev/stack.yml" "$exp" absent
  pc_snapshot "$absent" "$absent.snap"
  test ! -e "$absent/LICENSE" || pc_fail "absence journey planted a root notice"
  test ! -e "$absent.snap/LICENSE" || pc_fail "absence snapshot recorded a root notice"
  if git -C "$direct" cat-file -e "${mirror_tip}^{commit}" >/dev/null 2>&1; then
    pc_fail "direct consumer must not contain the mirror tip"
  fi
  git -C "$mediated" merge-base --is-ancestor "$mirror_tip" HEAD || pc_fail "mediated consumer must descend from the mirror"
  pc_transition_consumer "$direct" direct example/acme-product "$public" "$p0" "$p1"
  pc_transition_consumer "$mediated" mediated example/acme-mediated "$public" "$p0" "$p1"
  pc_transition_consumer "$absent" absent example/acme-absent "$public" "$p0" "$p1"
  [[ "$(git -C "$public" rev-parse HEAD)" == "$p1" ]] || pc_fail "public root moved during consumer transition"
  [[ "$(git -C "$mirror" rev-parse HEAD)" == "$mirror_tip" ]] || pc_fail "mirror was used as a history bridge"
  test ! -e "$public/config/product/inheritance.json" || pc_fail "public root gained a product marker"
  test ! -e "$mirror/config/product/inheritance.json" || pc_fail "mirror gained a product marker"
  local sha
  for sha in "$private_tip" "$mirror_tip" "$(git -C "$direct" rev-parse HEAD)" "$(git -C "$mediated" rev-parse HEAD)" "$(git -C "$absent" rev-parse HEAD)"; do
    if git -C "$public" cat-file -e "${sha}^{commit}" >/dev/null 2>&1; then
      pc_fail "public root contains legacy commit ${sha:0:12}"
    fi
  done
  echo "dogfood publication continuity: public root stayed independent and marker-free"
}

if [[ "$MODE" == "--self-sim" ]]; then
  TMP="$(mktemp -d -t kit-dogfood-XXXXXX)"
  trap 'rm -rf "$TMP"' EXIT
  SOURCE_ROOT="$ROOT"
  SOURCE_BRANCH="$(git -C "$ROOT" branch --show-current || true)"

  # A product checkout carries product-owned paths and an inheritance marker, so it
  # cannot seed the kit→mirror fixture directly. Re-run the kit contract from the
  # exact parent tip the product inherited instead.
  if [[ -f "$ROOT/config/product/inheritance.json" ]]; then
    SOURCE_HEAD="$(
      node -e "const j=require(process.argv[1]); process.stdout.write(String(j.upstreamCommit || '').trim())" \
        "$ROOT/config/product/inheritance.json"
    )"
    if [[ ! "$SOURCE_HEAD" =~ ^[0-9a-fA-F]{40}$ ]] ||
      ! git -C "$ROOT" rev-parse --verify "${SOURCE_HEAD}^{commit}" >/dev/null 2>&1; then
      echo "FAIL: product inheritance marker does not reference a local commit" >&2
      exit 1
    fi
    git clone --no-checkout "file://$ROOT" "$TMP/parent-src"
    git -C "$TMP/parent-src" checkout -q --detach "$SOURCE_HEAD"
    SOURCE_ROOT="$TMP/parent-src"
    SOURCE_BRANCH="inherited-parent"
  else
    SOURCE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
  fi
  echo "== dogfood: self-sim in $TMP (source_head=${SOURCE_HEAD:0:12} branch=${SOURCE_BRANCH:-detached}) =="
  run_workflow_inventory_cases "$TMP/wf-inventory"
  run_docs_inventory_cases "$TMP/docs-inventory"
  run_stack_ownership_case "$TMP/stack-ownership"
  run_stack_contract_case "$TMP/stack-contract"
  run_base_lineage_cases "$TMP/base-lineage"
  run_nonascii_path_cases "$TMP/nonascii-paths"
  run_exception_expiry_cases "$TMP/exception-expiry"
  run_publication_continuity "$TMP/publication"


  run_self_sim_chain "$SOURCE_ROOT" "$TMP/primary" "primary"

  # Detached-HEAD source probe — does not alter the real checkout.
  echo "== dogfood: detached-HEAD source probe =="
  git clone --no-checkout "file://$SOURCE_ROOT" "$TMP/detached-src"
  git -C "$TMP/detached-src" checkout -q --detach "$SOURCE_HEAD"
  if [[ -n "$(git -C "$TMP/detached-src" branch --show-current)" ]]; then
    echo "FAIL: detached-src fixture is not detached" >&2
    exit 1
  fi
  run_self_sim_chain "$TMP/detached-src" "$TMP/detached" "detached"

  echo "dogfood self-sim: OK (HEAD seed + kit→mirror→product + Roxabi/roxabi-boilerplate-cf#103 + dual-edit fail + protected non-ASCII Git path listings + product pnpm-workspace.yaml FORBIDDEN + no_push + deny-upstream + detached source + workflow inventory + docs inventory + stack ownership + stack contract + marker lineage (launders refused, re-inherit + mirror chain accepted) + exception expiry cap + publication continuity (independent public root, direct + mediated transition, ordinary upgrade, product root notice preserved, unmerged pin refused))"
  exit 0
fi

if [[ "$MODE" == "--generated-product" ]]; then
  [[ $# -eq 2 ]] || { echo "Usage: $0 --generated-product /path/to/product-repo" >&2; exit 2; }
  PRODUCT="$2"
  [[ -f "$PRODUCT/config/product/inheritance.json" ]] || { echo "FAIL: generated Product lacks inheritance marker" >&2; exit 1; }
else
  PRODUCT="${1:-}"
fi
if [[ -z "$PRODUCT" || ! -d "$PRODUCT/.git" ]]; then
  echo "Usage: $0 /path/to/product-repo | --generated-product /path/to/product-repo | --self-sim" >&2
  exit 2
fi

PRODUCT="$(cd "$PRODUCT" && pwd)"
cd "$PRODUCT"
echo "== dogfood product: $PRODUCT =="

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "FAIL: missing remote 'upstream' (add kit as upstream)" >&2
  exit 1
fi

assert_no_push "$PRODUCT"
run_gates "$PRODUCT"
echo "dogfood product: OK"
exit 0
