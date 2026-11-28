#!/usr/bin/env bash
# CP-TSCONFIG-ORPHAN — self-test for scripts/kit/check-tsconfig-orphans.ts
#
# The gate reads `git ls-files`, so a planted file must be TRACKED to be seen.
# Planting it in the live checkout would mean staging a file in the real index
# (and leaving residue on any early exit), so each case gets its own throwaway
# `git init` tree under $TMPDIR instead: `git add -A` there is a real index the
# gate can read, and `trap … EXIT` removes the whole tree even on failure. The
# live repo index is never touched. `tsc` still comes from the kit checkout's
# node_modules (the gate resolves it from its own location, not from ROOT).
#
# Exit 0 only if every case passes.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="${ROOT}/scripts/kit/check-tsconfig-orphans.ts"
[[ -f "${SCANNER}" ]] || { echo "FAIL: missing ${SCANNER}" >&2; exit 1; }

PASS=0
FAIL=0

assert_case() {
  local name="$1" expected="$2" tree="$3" marker="${4:-}"
  local output rc=0
  output="$(TSCONFIG_ORPHANS_ROOT="${tree}" bun "${SCANNER}" 2>&1)" || rc=$?
  if [[ "${rc}" -ne "${expected}" ]]; then
    echo "  FAIL: ${name} — expected exit ${expected}, got ${rc}" >&2
    echo "${output}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "${marker}" ]] && [[ "${output}" != *"${marker}"* ]]; then
    echo "  FAIL: ${name} — expected output to contain '${marker}'" >&2
    echo "${output}" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${rc})"
  # Echo the line that carries the evidence, so a reader sees the verdict.
  if [[ -n "${marker}" ]]; then
    printf '%s\n' "${output}" | grep -F -m1 -- "${marker}" | sed 's/^/    /'
  else
    echo "    ${output##*$'\n'}"
  fi
  PASS=$((PASS + 1))
}

# Root project of the throwaway tree: no `extends`, include globs passed in.
write_tsconfig() {
  local tree="$1" include="$2"
  cat >"${tree}/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "noEmit": true,
    "skipLibCheck": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext"
  },
  "include": [${include}]
}
EOF
}

# Throwaway monorepo: a root project covering scripts/kit/**, one real workspace
# (manifest + project + typecheck script) owning its src/ — invisible to the
# root project on purpose. The manifest is what makes that ownership real: see
# the manifest-less case below.
seed_tree() {
  local tree="$1"
  mkdir -p "${tree}/scripts/kit" "${tree}/packages/core/src"
  write_tsconfig "${tree}" '"scripts/kit/**/*.ts"'
  echo 'export const covered = 1' >"${tree}/scripts/kit/covered.ts"
  printf '{\n  "name": "@kit/core",\n  "private": true,\n  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" }\n}\n' \
    >"${tree}/packages/core/package.json"
  write_project "${tree}/packages/core/tsconfig.json" '"src"'
  echo 'export const ownedByWorkspace = 1' >"${tree}/packages/core/src/owned.ts"
  git -C "${tree}" -c init.defaultBranch=main init -q
  git -C "${tree}" add -A
}

# A workspace-level project: declares its own inputs, so the gate must see it
# run by a `typecheck` script. JSONC on purpose — every citation case below
# therefore also proves the gate reads comments and a trailing comma, which is
# what real tsconfig files contain and `JSON.parse` rejects.
write_project() {
  local path="$1" include="$2"
  cat >"${path}" <<EOF
{
  // Comments are legal in a tsconfig; the gate must still read this file.
  "compilerOptions": { "noEmit": true, "skipLibCheck": true },
  "include": [${include}],
}
EOF
}

# A shared base: no files/include/references, so `tsc -p` on it would sweep the
# whole directory. Not a runnable project, must not be demanded of any script.
write_base() {
  cat >"$1" <<'EOF'
{
  "compilerOptions": { "noEmit": true, "strict": true }
}
EOF
}

# A workspace inside the throwaway tree: manifest with the given `typecheck`
# script (none when the argument is empty) and one project covering its src/.
seed_workspace() {
  local tree="$1" ws="$2" script="$3"
  mkdir -p "${tree}/${ws}/src"
  if [[ -n "${script}" ]]; then
    printf '{\n  "name": "@kit/%s",\n  "private": true,\n  "scripts": { "typecheck": "%s" }\n}\n' \
      "$(basename "${ws}")" "${script}" >"${tree}/${ws}/package.json"
  else
    printf '{\n  "name": "@kit/%s",\n  "private": true\n}\n' \
      "$(basename "${ws}")" >"${tree}/${ws}/package.json"
  fi
  write_project "${tree}/${ws}/tsconfig.json" '"src"'
  echo 'export const owned = 1' >"${tree}/${ws}/src/owned.ts"
}

echo "== CP-TSCONFIG-ORPHAN self-test =="
TMP="$(mktemp -d -t cp-tsconfig-orphan-XXXXXX)"
trap 'rm -rf "${TMP}"' EXIT

# --- clean tree → 0 (workspace src file is tracked, uncovered by the root
#     project, and must NOT be reported: its workspace owns it) ---
CLEAN="${TMP}/clean"
seed_tree "${CLEAN}"
assert_case "clean tree, workspace src not an orphan → 0" 0 "${CLEAN}" "0 orphan(s)"

# --- a directory under packages/ with NO manifest is not a workspace: nothing
#     runs a project for it, so its tracked TS must be reported (the hole the
#     coverage subtraction used to open — Roxabi/roxabi-boilerplate-cf#245 made it reachable) ---
NOMANIFEST="${TMP}/nomanifest"
seed_tree "${NOMANIFEST}"
mkdir -p "${NOMANIFEST}/packages/assets/src"
echo 'export const stray = 1' >"${NOMANIFEST}/packages/assets/src/stray.ts"
git -C "${NOMANIFEST}" add -A
assert_case "src under a manifest-less packages/ dir → 1" 1 "${NOMANIFEST}" \
  "ORPHAN packages/assets/src/stray.ts"

# --- same tree, covered from the root project → back to green ---
write_tsconfig "${NOMANIFEST}" '"scripts/kit/**/*.ts", "packages/assets/src/**/*.ts"'
git -C "${NOMANIFEST}" add -A
assert_case "after covering it from the root project → 0" 0 "${NOMANIFEST}" "0 orphan(s)"

# --- tracked tooling file outside every include glob → 1 ---
ORPHAN="${TMP}/orphan"
seed_tree "${ORPHAN}"
mkdir -p "${ORPHAN}/tools"
echo 'export const orphan = 1' >"${ORPHAN}/tools/orphan.ts"
git -C "${ORPHAN}" add -A
assert_case "tracked orphan → 1 naming the path" 1 "${ORPHAN}" "ORPHAN tools/orphan.ts"

# --- same tree, include extended → back to green (the documented fix) ---
write_tsconfig "${ORPHAN}" '"scripts/kit/**/*.ts", "tools/**/*.ts"'
git -C "${ORPHAN}" add -A
assert_case "after extending include → 0" 0 "${ORPHAN}" "0 orphan(s)"

# Workspace tests outside src belong to a cited project, including imports.
WSTEST="${TMP}/workspace-test"
seed_tree "${WSTEST}"
mkdir -p "${WSTEST}/packages/core/test"
echo "import './helper'" >"${WSTEST}/packages/core/test/owned.test.ts"
echo 'export const helper = 1' >"${WSTEST}/packages/core/test/helper.ts"
write_project "${WSTEST}/packages/core/tsconfig.json" '"src", "test/*.test.ts"'
git -C "${WSTEST}" add -A
assert_case "cited workspace project opens test and transitive helper → 0" 0 "${WSTEST}" "0 orphan(s)"

seed_workspace "${WSTEST}" "packages/core" "tsc --noEmit"
write_project "${WSTEST}/packages/core/tsconfig.json" '"src", "test/*.test.ts"'
git -C "${WSTEST}" add -A
assert_case "implicit workspace project owns test → 0" 0 "${WSTEST}" "0 orphan(s)"

seed_workspace "${WSTEST}" "packages/core" "bun check --no-script"
write_project "${WSTEST}/packages/core/tsconfig.json" '"src", "test/*.test.ts"'
git -C "${WSTEST}" add -A
assert_case "implicit bun check project owns test → 0" 0 "${WSTEST}" "0 orphan(s)"

seed_workspace "${WSTEST}" "packages/core" "tsc --noEmit -p tsconfig.json"

write_project "${WSTEST}/packages/core/tsconfig.json" '"src"'
git -C "${WSTEST}" add -A
assert_case "test excluded from workspace project → 1" 1 "${WSTEST}" \
  "ORPHAN packages/core/test/owned.test.ts"

write_project "${WSTEST}/packages/core/tsconfig.test.json" '"test/*.test.ts"'
git -C "${WSTEST}" add -A
assert_case "unused test project cannot own test → 1" 1 "${WSTEST}" \
  "ORPHAN packages/core/test/owned.test.ts"

seed_workspace "${WSTEST}" "packages/core" "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json || true"
git -C "${WSTEST}" add -A
assert_case "swallowed test project cannot own test → 1" 1 "${WSTEST}" \
  "ORPHAN packages/core/test/owned.test.ts"

# Textual citations are not sufficient proof that a checking command runs.
UNSAFE="${TMP}/unsafe-coverage"
seed_tree "${UNSAFE}"
mkdir -p "${UNSAFE}/packages/core/test"
echo 'export const test = 1' >"${UNSAFE}/packages/core/test/owned.test.ts"
for script in \
  'echo ok # tsc --noEmit -p tsconfig.json' \
  'tsc --noEmit -p tsconfig.json; true' \
  'true || tsc --noEmit -p tsconfig.json' \
  'tsc --noEmit -p tsconfig.json --noCheck' \
  'tsc --noEmit -p tsconfig.json --showConfig' \
  'bun check --no-script -p tsconfig.json --noCheck' \
  'bun check --no-script -p tsconfig.json --build' \
  'bun check --no-script -p tsconfig.json src' \
  'tsc --noEmit -p tsconfig.json & true' \
  'echo $(tsc --noEmit -p tsconfig.json)'; do
  seed_workspace "${UNSAFE}" "packages/core" "${script}"
  write_project "${UNSAFE}/packages/core/tsconfig.json" '"src", "test"'
  git -C "${UNSAFE}" add -A
  assert_case "unsupported checking command: ${script} → orphan" 1 "${UNSAFE}" \
    "ORPHAN packages/core/test/owned.test.ts"
done

# A newline after -p changes the shell command, despite looking like whitespace
# to the legacy citation parser. The nested decoy avoids a PHANTOM diagnostic.
NEWLINE="${TMP}/newline-coverage"
seed_tree "${NEWLINE}"
mkdir -p "${NEWLINE}/packages/core/test" "${NEWLINE}/packages/core/true"
echo 'export const test = 1' >"${NEWLINE}/packages/core/test/owned.test.ts"
write_project "${NEWLINE}/packages/core/tsconfig.test.json" '"test"'
write_project "${NEWLINE}/packages/core/true/tsconfig.json" '"../src"'
cat >"${NEWLINE}/packages/core/package.json" <<'EOF'
{"name":"@kit/core","private":true,"scripts":{"typecheck":"tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p\ntrue"}}
EOF
git -C "${NEWLINE}" add -A
assert_case "newline command cannot own test → 1" 1 "${NEWLINE}" \
  "ORPHAN packages/core/test/owned.test.ts"

# noCheck inherited through extends is as unsafe as the command-line flag.
seed_workspace "${UNSAFE}" "packages/core" "tsc --noEmit -p tsconfig.json"
cat >"${UNSAFE}/packages/core/tsconfig.base.json" <<'EOF'
{ "compilerOptions": { "noCheck": true } }
EOF
cat >"${UNSAFE}/packages/core/tsconfig.json" <<'EOF'
{ "extends": "./tsconfig.base.json", "include": ["src", "test"] }
EOF
git -C "${UNSAFE}" add -A
assert_case "inherited noCheck cannot own test → 1" 1 "${UNSAFE}" \
  "ORPHAN packages/core/test/owned.test.ts"

# Imports outside the workspace still need root-program ownership.
OUTSIDE="${TMP}/outside-workspace"
seed_tree "${OUTSIDE}"
mkdir -p "${OUTSIDE}/packages/core/test" "${OUTSIDE}/tools"
echo "import '../../../tools/helper'" >"${OUTSIDE}/packages/core/test/owned.test.ts"
echo 'export const helper = 1' >"${OUTSIDE}/tools/helper.ts"
write_project "${OUTSIDE}/packages/core/tsconfig.json" '"src", "test"'
git -C "${OUTSIDE}" add -A
assert_case "workspace import cannot own external tooling → 1" 1 "${OUTSIDE}" \
  "ORPHAN tools/helper.ts"

# A syntactically valid but invalid compiler configuration cannot own tests.
BADTEST="${TMP}/bad-test"
seed_tree "${BADTEST}"
mkdir -p "${BADTEST}/packages/core/test"
echo 'export const test = 1' >"${BADTEST}/packages/core/test/bad.test.ts"
cat >"${BADTEST}/packages/core/tsconfig.json" <<'EOF'
{ "compilerOptions": { "target": "not-a-target" }, "include": ["src", "test"] }
EOF
git -C "${BADTEST}" add -A
assert_case "invalid workspace configuration cannot own test → 1" 1 "${BADTEST}" \
  "ORPHAN packages/core/test/bad.test.ts"

# A base with no explicit inputs cannot claim files by tsc's default sweep.
BASETEST="${TMP}/base-test"
seed_tree "${BASETEST}"
mkdir -p "${BASETEST}/packages/core/test"
echo 'export const test = 1' >"${BASETEST}/packages/core/test/stray.test.ts"
write_base "${BASETEST}/packages/core/tsconfig.base.json"
seed_workspace "${BASETEST}" "packages/core" "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.base.json"
git -C "${BASETEST}" add -A
assert_case "cited base cannot own test by default sweep → 1" 1 "${BASETEST}" \
  "ORPHAN packages/core/test/stray.test.ts"

# --- .tsx / .mts / .cts are in scope too ---
EXTS="${TMP}/exts"
seed_tree "${EXTS}"
mkdir -p "${EXTS}/tools"
echo 'export const a = 1' >"${EXTS}/tools/widget.tsx"
echo 'export const b = 1' >"${EXTS}/tools/loader.mts"
echo 'exports.c = 1' >"${EXTS}/tools/legacy.cts"
git -C "${EXTS}" add -A
assert_case "tsx + mts + cts orphans → 1" 1 "${EXTS}" "3 orphan file(s)"

# --- untracked file is out of scope (git ls-files is the source of truth) ---
UNTRACKED="${TMP}/untracked"
seed_tree "${UNTRACKED}"
mkdir -p "${UNTRACKED}/tools"
echo 'export const scratch = 1' >"${UNTRACKED}/tools/scratch.ts"
assert_case "untracked orphan ignored → 0" 0 "${UNTRACKED}" "0 orphan(s)"

# --- fail-closed: no git checkout → 2 ---
NOGIT="${TMP}/nogit"
mkdir -p "${NOGIT}/scripts/kit"
cp "${CLEAN}/tsconfig.json" "${NOGIT}/tsconfig.json"
echo 'export const covered = 1' >"${NOGIT}/scripts/kit/covered.ts"
assert_case "no git checkout → 2" 2 "${NOGIT}" "git ls-files failed"

# --- fail-closed: unloadable root project → 2 ---
BADCONF="${TMP}/badconf"
seed_tree "${BADCONF}"
echo '{ "include": [' >"${BADCONF}/tsconfig.json"
assert_case "unloadable root project → 2" 2 "${BADCONF}" "listed no file"

echo ""
echo "-- citation: every runnable workspace project is run by its own script --"

# --- both workspace programs cited by `typecheck` → 0 (the shape of
#     apps/example-web: browser project + Node test project) ---
CITED="${TMP}/cited"
seed_tree "${CITED}"
seed_workspace "${CITED}" "apps/web" "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json"
write_project "${CITED}/apps/web/tsconfig.test.json" '"src/**/*.test.ts"'
git -C "${CITED}" add -A
assert_case "both workspace projects cited → 0" 0 "${CITED}" "project(s) all cited"

# --- the attack: drop the second half of the `typecheck` script → 1 ---
UNCITED="${TMP}/uncited"
seed_tree "${UNCITED}"
seed_workspace "${UNCITED}" "apps/web" "tsc --noEmit -p tsconfig.json"
write_project "${UNCITED}/apps/web/tsconfig.test.json" '"src/**/*.test.ts"'
git -C "${UNCITED}" add -A
assert_case "test project dropped from typecheck → 1 naming it" 1 "${UNCITED}" \
  "UNCITED apps/web/tsconfig.test.json"

# --- same tree, citation restored → back to green (the documented fix) ---
seed_workspace "${UNCITED}" "apps/web" "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json"
git -C "${UNCITED}" add -A
assert_case "after restoring the citation → 0" 0 "${UNCITED}" "project(s) all cited"

# Bun commands cite projects with either project flag syntax and a direct path.
# Put the test outside src/ to prove the second command adds coverage too.
BUNCITED="${TMP}/bun-cited"
seed_tree "${BUNCITED}"
seed_workspace "${BUNCITED}" "apps/web" \
  "bun check --no-pretty -p tsconfig.json --no-script && /fake/bin/bun check --no-script --project=tsconfig.test.json"
mkdir -p "${BUNCITED}/apps/web/test"
echo 'export const owned = 1' >"${BUNCITED}/apps/web/test/owned.test.ts"
write_project "${BUNCITED}/apps/web/tsconfig.test.json" '"test"'
git -C "${BUNCITED}" add -A
assert_case "both bun check projects cited and eligible → 0" 0 "${BUNCITED}" "project(s) all cited"

seed_workspace "${BUNCITED}" "apps/web" "bun check --no-script --project tsconfig.json"
git -C "${BUNCITED}" add -A
assert_case "test project dropped from bun check → 1 naming it" 1 "${BUNCITED}" \
  "UNCITED apps/web/tsconfig.test.json"

# Bun only checks the last project flag. Put the witness in src/ so only
# the citation invariant can catch the first project's missing check.
BUNLAST="${TMP}/bun-last-project"
seed_tree "${BUNLAST}"
seed_workspace "${BUNLAST}" "apps/web" "bun check --no-script -p tsconfig.json -p tsconfig.test.json"
echo 'export const broken: number = "not a number"' >"${BUNLAST}/apps/web/src/owned.ts"
write_project "${BUNLAST}/apps/web/tsconfig.test.json" '"src/**/*.test.ts"'
echo 'export const test = 1' >"${BUNLAST}/apps/web/src/owned.test.ts"
git -C "${BUNLAST}" add -A
assert_case "only the last bun project flag counts → 1 naming the first project" 1 "${BUNLAST}" \
  "UNCITED apps/web/tsconfig.json"

# An actual `check` script makes the risk concrete; refusal must not depend on
# whether that script exists today or on workspace tests needing coverage.
SCRIPTED="${TMP}/scripted"
seed_tree "${SCRIPTED}"
seed_workspace "${SCRIPTED}" "apps/web" "bun check -p tsconfig.json"
cat >"${SCRIPTED}/apps/web/package.json" <<'EOF'
{"name":"@kit/web","private":true,"scripts":{"check":"true","typecheck":"bun check -p tsconfig.json"}}
EOF
git -C "${SCRIPTED}" add -A
assert_case "workspace bun check without --no-script → 1" 1 "${SCRIPTED}" \
  'SCRIPTED apps/web — "bun check" without --no-script'

for script in 'bun check -p tsconfig.json # --no-script' 'bun check -p tsconfig.json -- --no-script'; do
  seed_workspace "${SCRIPTED}" "apps/web" "${script}"
  git -C "${SCRIPTED}" add -A
  assert_case "bun check needs --no-script as a flag: ${script} → 1" 1 "${SCRIPTED}" \
    'SCRIPTED apps/web — "bun check" without --no-script'
done

seed_workspace "${SCRIPTED}" "apps/web" "bun check --no-script -p tsconfig.json"
cat >"${SCRIPTED}/package.json" <<'EOF'
{"name":"fixture","private":true,"scripts":{"typecheck:tooling":"bun check -p tsconfig.json"}}
EOF
git -C "${SCRIPTED}" add -A
assert_case "root bun check without --no-script → 1" 1 "${SCRIPTED}" \
  'SCRIPTED root — "bun check" without --no-script'

# --- a project present but not yet staged is audited too: it is already the
#     program vite/vitest/tsserver load ---
UNSTAGED="${TMP}/unstaged"
seed_tree "${UNSTAGED}"
seed_workspace "${UNSTAGED}" "apps/web" "tsc --noEmit -p tsconfig.json"
git -C "${UNSTAGED}" add -A
write_project "${UNSTAGED}/apps/web/tsconfig.test.json" '"src/**/*.test.ts"'
assert_case "untracked-but-present project audited → 1" 1 "${UNSTAGED}" \
  "UNCITED apps/web/tsconfig.test.json"

# --- bare `tsc --noEmit` runs <cwd>/tsconfig.json: a citation, not a hole ---
IMPLICIT="${TMP}/implicit"
seed_tree "${IMPLICIT}"
seed_workspace "${IMPLICIT}" "apps/web" "tsc --noEmit"
git -C "${IMPLICIT}" add -A
assert_case "implicit cwd project counted as cited → 0" 0 "${IMPLICIT}" "project(s) all cited"

# --- no `typecheck` script at all → 1 (nothing runs the project) ---
NOSCRIPT="${TMP}/noscript"
seed_tree "${NOSCRIPT}"
seed_workspace "${NOSCRIPT}" "apps/web" ""
git -C "${NOSCRIPT}" add -A
assert_case "workspace without typecheck script → 1" 1 "${NOSCRIPT}" \
  'apps/web has no "typecheck" script'

# --- a base declaring no inputs is not runnable → not demanded (the rule is
#     structural: the same file gains an `include` below and is demanded) ---
BASE="${TMP}/base"
seed_tree "${BASE}"
seed_workspace "${BASE}" "packages/cfg" "tsc --noEmit -p tsconfig.json"
write_base "${BASE}/packages/cfg/tsconfig.shared.json"
git -C "${BASE}" add -A
assert_case "base without files/include/references ignored → 0" 0 "${BASE}" "project(s) all cited"

write_project "${BASE}/packages/cfg/tsconfig.shared.json" '"src"'
git -C "${BASE}" add -A
assert_case "same file once it declares inputs → 1" 1 "${BASE}" \
  "UNCITED packages/cfg/tsconfig.shared.json"

# --- script citing a project that does not exist → 1 ---
PHANTOM="${TMP}/phantom"
seed_tree "${PHANTOM}"
seed_workspace "${PHANTOM}" "apps/web" "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json"
git -C "${PHANTOM}" add -A
assert_case "typecheck citing a missing project → 1" 1 "${PHANTOM}" \
  "PHANTOM apps/web/tsconfig.test.json"

# --- fail-closed: an unreadable workspace tsconfig must not read as "this
#     workspace has no project" (that would be silently green) → 2 ---
BADWS="${TMP}/badws"
seed_tree "${BADWS}"
seed_workspace "${BADWS}" "apps/web" "tsc --noEmit -p tsconfig.json"
printf '{ "compilerOptions": { ' >"${BADWS}/apps/web/tsconfig.json"
git -C "${BADWS}" add -A
assert_case "unparseable workspace tsconfig → 2" 2 "${BADWS}" \
  "cannot parse apps/web/tsconfig.json"

# --- the complete case: workspace src/ with no project at all. Coverage
#     subtracts src/, citation used to audit 0 projects and print OK. ---
GHOST="${TMP}/ghost"
seed_tree "${GHOST}"
mkdir -p "${GHOST}/packages/ghost/src"
printf '{\n  "name": "@kit/ghost",\n  "private": true\n}\n' >"${GHOST}/packages/ghost/package.json"
echo 'export const broken: number = "not a number"' >"${GHOST}/packages/ghost/src/index.ts"
git -C "${GHOST}" add -A
assert_case "workspace src without a project → 1" 1 "${GHOST}" \
  "NO PROJECT packages/ghost"

# --- `echo … -p` names the project without running tsc ---
ECHO="${TMP}/echo"
seed_tree "${ECHO}"
seed_workspace "${ECHO}" "apps/web" "echo skipping -p tsconfig.json"
git -C "${ECHO}" add -A
assert_case "echo naming -p is not a citation → 1" 1 "${ECHO}" \
  "UNCITED apps/web/tsconfig.json"

# These checkers never run. A tracked source error would escape a green gate.
UNREACHED="${TMP}/unreached"
seed_tree "${UNREACHED}"
for script in \
  'echo done # && bun check --no-script -p tsconfig.json' \
  'true || bun check --no-script -p tsconfig.json' \
  'true || tsc --noEmit -p tsconfig.json'; do
  seed_workspace "${UNREACHED}" "apps/web" "${script}"
  echo 'export const broken: number = "not a number"' >"${UNREACHED}/apps/web/src/owned.ts"
  git -C "${UNREACHED}" add -A
  assert_case "checker does not cite a project: ${script} → 1" 1 "${UNREACHED}" \
    "UNCITED apps/web/tsconfig.json"
done

seed_workspace "${UNREACHED}" "apps/web" "echo '#' && bun check --no-script -p tsconfig.json"
git -C "${UNREACHED}" add -A
assert_case "quoted hash does not comment out a checker → 0" 0 "${UNREACHED}" "project(s) all cited"

# --- `|| true` runs tsc but the script cannot fail ---
SWALLOW="${TMP}/swallow"
seed_tree "${SWALLOW}"
seed_workspace "${SWALLOW}" "apps/web" "tsc --noEmit -p tsconfig.json || true"
git -C "${SWALLOW}" add -A
assert_case "typecheck || true swallows tsc status → 1" 1 "${SWALLOW}" \
  "SWALLOWED apps/web"

# --- a pipe: tsc's status is the last command's, not tsc's ---
PIPE="${TMP}/pipe"
seed_tree "${PIPE}"
seed_workspace "${PIPE}" "apps/web" "tsc --noEmit -p tsconfig.json | tail -1"
git -C "${PIPE}" add -A
assert_case "typecheck piped swallows tsc status → 1" 1 "${PIPE}" \
  "SWALLOWED apps/web"


echo ""
echo "== CP-TSCONFIG-ORPHAN summary: ${PASS} pass, ${FAIL} fail =="
[[ "${FAIL}" -eq 0 ]]
