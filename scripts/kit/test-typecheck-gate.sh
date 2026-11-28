#!/usr/bin/env bash
# Hermetic self-test for the live bun check scripts and the Kit-only tsc reference.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="$ROOT/scripts/kit/typecheck-reference.ts"
TSC="$ROOT/node_modules/.bin/tsc"
source "$ROOT/scripts/kit/lib/gate-launch.sh"

unset GITHUB_REPOSITORY TYPECHECK_REFERENCE_ROOT

TMP="$(mktemp -d -t typecheck-gate.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

# Run the command, then require each literal marker (or forbid it with a leading !).
assert_case() {
  local name="$1" expected="$2" markers="$3" output rc=0 marker ok=1
  shift 3
  output="$("$@" 2>&1)" || rc=$?
  if [[ "$expected" == nonzero ]]; then
    [[ "$rc" -ne 0 ]] || ok=0
  else
    [[ "$rc" -eq "$expected" ]] || ok=0
  fi
  while IFS= read -r marker; do
    if [[ "$marker" == '!'* ]]; then
      [[ "$output" != *"${marker#!}"* ]] || ok=0
    else
      [[ "$output" == *"$marker"* ]] || ok=0
    fi
  done <<<"$markers"
  if [[ "$ok" -eq 1 ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s (expected rc=%s and markers:\n%s\n; got rc=%s)\n%s\n' \
      "$name" "$expected" "$markers" "$rc" "$output" >&2
    FAIL=$((FAIL + 1))
  fi
}

seed_error() {
  mkdir -p "$1/src"
  printf '%s\n' '{"compilerOptions":{"strict":true},"include":["src"]}' >"$1/tsconfig.json"
  printf '%s\n' "export const n: number = 'x'" >"$1/src/index.ts"
}

write_workspace_manifest() {
  bun "${GATE[@]}" -e '
    const live = await Bun.file(process.argv[1]).json()
    const typecheck = live.scripts.typecheck
    if (typeof typecheck !== "string") throw new Error("missing live core typecheck script")
    // Bun forwards -p to a shadowing script; the comment makes exit 0 ignore those arguments.
    const scripts = process.argv[2] === "shadow"
      ? { typecheck, check: "exit 0 # ignore forwarded arguments" }
      : { typecheck }
    console.log(JSON.stringify({ name: "typecheck-fixture", scripts }))
  ' "$ROOT/packages/core/package.json" "$1"
}

in_workspace() { (cd "$WORKSPACE" && "$@"); }
reference() { bun "${GATE[@]}" run "$TREE/scripts/kit/typecheck-reference.ts"; }
reference_task() { (cd "$TREE" && bun run typecheck:reference); }

write_root_manifest() {
  bun "${GATE[@]}" -e '
    const [, liveManifest, workspaces, tooling] = process.argv
    const { scripts } = await Bun.file(liveManifest).json()
    const typecheck = scripts["typecheck:reference"]
    if (typeof typecheck !== "string") throw new Error("missing live reference script")
    console.log(JSON.stringify({
      workspaces: JSON.parse(workspaces),
      scripts: { "typecheck:tooling": tooling, "typecheck:reference": typecheck },
    }))
  ' "$ROOT/package.json" "$1" "$2"
}

check_live_flags() {
  (cd "$ROOT" && bun "${GATE[@]}" -e '
    const { workspaces } = await Bun.file("package.json").json()
    const manifests = ["package.json", ...workspaces.flatMap(pattern =>
      [...new Bun.Glob(`${pattern}/package.json`).scanSync(".")])]
    for (const path of manifests) {
      const { scripts } = await Bun.file(path).json()
      const task = path === "package.json" ? "typecheck:tooling" : "typecheck"
      const commands = (scripts?.[task] ?? "").split("&&").filter(line => /\bbun\s+check\b/.test(line))
      if (path === "package.json" && commands.length === 0) throw new Error(`${path} ${task}: no bun check`)
      for (const command of commands) {
        if (!command.trim().split(/\s+/).includes("--no-script")) {
          throw new Error(`${path} ${task}: missing --no-script in ${command.trim()}`)
        }
      }
    }
  ')
}

echo '== typecheck gate self-test =='
WORKSPACE="$TMP/workspace"
seed_error "$WORKSPACE"
write_workspace_manifest plain >"$WORKSPACE/package.json"
assert_case 'live workspace checker surfaces TS2322' nonzero 'error TS2322' in_workspace bun run typecheck
assert_case 'tsc reports the same diagnostic' nonzero 'error TS2322' \
  in_workspace "$TSC" --noEmit --pretty false -p tsconfig.json

write_workspace_manifest shadow >"$WORKSPACE/package.json"
assert_case 'manifest check script cannot replace the gate' nonzero 'error TS2322' in_workspace bun run typecheck
assert_case 'dropping --no-script lets the manifest check script hide the error' 0 '!TS2322' \
  in_workspace bun check -p tsconfig.json
assert_case 'all live Bun checker commands pass --no-script' 0 '' check_live_flags

TREE="$TMP/tree"
WORKSPACE="$TREE/packages/x"
seed_error "$TREE"
mv "$TREE/src/index.ts" "$TREE/src/root.ts"
seed_error "$WORKSPACE"
write_workspace_manifest plain >"$WORKSPACE/package.json"
TOOLING='bun check --no-script --no-pretty -p tsconfig.json'
write_root_manifest '["packages/*"]' "$TOOLING" >"$TREE/package.json"
mkdir -p "$TREE/config/kit" "$TREE/config/product" "$TREE/scripts/kit"
cp "$ROOT/config/kit/"{zero-edit-zones.json,bunfig.gates.toml} "$TREE/config/kit/"
cp "$SCANNER" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$TREE/scripts/kit/"
ln -s "$ROOT/node_modules" "$TREE/node_modules"
git -C "$TREE" init -q
git -C "$TREE" remote add origin https://github.com/example/acme-product.git
MARKER="$TREE/config/product/inheritance.json"
printf '{"version":1,"upstreamCommit":"%040d"}\n' 1 >"$MARKER"
SKIP='typecheck-reference: skipped (Product tree'
assert_case 'Product reference skips both broken projects' 0 "$SKIP"$'\n!error TS' reference

rm "$MARKER"
DIAGNOSTICS=$'src/root.ts(1,14): error TS2322\npackages/x/src/index.ts(1,14): error TS2322\ntsc output (exit 1):\nbun check output (exit 1):\n2 project(s); tsc \n2 failed, 0 divergence(s)'
GITHUB_REPOSITORY=go-silex/unkillable-kit \
  assert_case 'Kit reference checks both projects' 1 "$DIAGNOSTICS" reference
assert_case 'unclassifiable tree still checks both projects' 1 \
  "$DIAGNOSTICS"$'\ntree classification failed; running reference:\ncannot classify repo' reference

git -C "$TREE" remote set-url origin https://github.com/go-silex/unkillable-kit.git
CLEAN="$TMP/clean"
cp -R "$TREE" "$CLEAN"
printf '%s\n' 'export const n: number = 1' >"$CLEAN/src/root.ts"
printf '%s\n' 'export const n: number = 1' >"$CLEAN/packages/x/src/index.ts"
TREE="$CLEAN" assert_case 'alternate checkout is clean' 0 '0 failed, 0 divergence(s)' reference
printf 'TYPECHECK_REFERENCE_ROOT="%s"\n' "$CLEAN" >"$TREE/.env"
assert_case 'outer package script cannot redirect reference through .env' 1 \
  "$DIAGNOSTICS" reference_task

EXTRA="$TREE/extensions/extra"
seed_error "$EXTRA"
write_workspace_manifest plain >"$EXTRA/package.json"
write_root_manifest '["packages/*","extensions/*"]' "$TOOLING" >"$TREE/package.json"
assert_case 'declared workspace outside apps and packages is checked' 1 \
  $'extensions/extra/src/index.ts(1,14): error TS2322\n3 project(s); tsc \n3 failed, 0 divergence(s)' reference

write_root_manifest '["packages/*"]' "$TOOLING || true" >"$TREE/package.json"
assert_case 'unmappable script fails instead of dropping projects' 2 \
  'package.json scripts.typecheck:tooling: cannot map command to a tsc project' reference

write_root_manifest 'null' "$TOOLING" >"$TREE/package.json"
assert_case 'invalid workspace declaration fails closed' 2 \
  'package.json workspaces must be an array of strings' reference

echo "== typecheck gate summary: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
