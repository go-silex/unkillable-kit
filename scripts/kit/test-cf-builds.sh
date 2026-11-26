#!/usr/bin/env bash
# Exercise Cloudflare entrypoints from an unrelated cwd with network/deploy tools stubbed.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(dirname "$0")/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TMP="$(mktemp -d -t kit-cf-builds-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

FIXTURE="${TMP}/repo"
BIN="${TMP}/bin"
LOG="${TMP}/calls.log"
mkdir -p "${FIXTURE}/scripts/kit/cf-builds" \
  "${FIXTURE}/apps/example-api" \
  "${FIXTURE}/apps/example-web" \
  "${BIN}"
cp "${ROOT}/scripts/kit/cf-builds/"*.sh "${FIXTURE}/scripts/kit/cf-builds/"
# packageManager of the fixture: the bun stub answers it by default, CF_STUB_BUN_VERSION overrides.
FIXTURE_BUN=9.8.7
printf '{\n  "name": "fixture",\n  "packageManager": "bun@%s"\n}\n' "${FIXTURE_BUN}" >"${FIXTURE}/package.json"
# A git checkout, as Workers Builds clones it: the version tag is its HEAD (require-deploy-sha.sh).
git init -q -b fixture "${FIXTURE}"
git -C "${FIXTURE}" add -A
git -C "${FIXTURE}" -c user.email=kit@example.com -c user.name=kit -c commit.gpgsign=false \
  commit -q -m fixture
FIXTURE_SHA="$(git -C "${FIXTURE}" rev-parse HEAD)"

cat >"${BIN}/bun" <<STUB
#!/usr/bin/env bash
printf 'bun|%s|%s\n' "\$PWD" "\$*" >>"\${CF_BUILDS_TEST_LOG}"
[[ "\$*" != --version ]] || printf '%s\n' "\${CF_STUB_BUN_VERSION:-${FIXTURE_BUN}}"
STUB
# bunx stub: logs every call; answers `d1 migrations list` and `d1 time-travel info` the way
# wrangler 4.132 does (rehearsal on a throwaway remote D1, Roxabi/roxabi-boilerplate-cf#258). CF_STUB_LIST / CF_STUB_TT replace
# the answers, CF_STUB_LIST_ERR is printed on stderr by the listing, CF_STUB_LIST_RC /
# CF_STUB_TT_RC / CF_STUB_APPLY_RC make that call fail. `migrations apply` prints APPLY-RAN.
cat >"${BIN}/bunx" <<'STUB'
#!/usr/bin/env bash
printf 'bunx|%s|%s\n' "$PWD" "$*" >>"${CF_BUILDS_TEST_LOG}"
case "$*" in
  *"d1 migrations list"*)
    [[ -z "${CF_STUB_LIST_RC:-}" ]] || exit "${CF_STUB_LIST_RC}"
    [[ -z "${CF_STUB_LIST_ERR:-}" ]] || printf '%s\n' "${CF_STUB_LIST_ERR}" >&2
    printf '%s\n' "${CF_STUB_LIST:-✅ No migrations to apply!}"
    ;;
  *"d1 time-travel info"*)
    [[ -z "${CF_STUB_TT_RC:-}" ]] || exit "${CF_STUB_TT_RC}"
    printf '%s\n' "${CF_STUB_TT:-{\"bookmark\": \"00000097-0000000a-000050f1-feedface\"}}"
    ;;
  *"d1 migrations apply"*)
    echo APPLY-RAN
    [[ -z "${CF_STUB_APPLY_RC:-}" ]] || exit "${CF_STUB_APPLY_RC}"
    ;;
esac
STUB
chmod +x "${BIN}/bun" "${BIN}/bunx"

run_entrypoint() {
  local script="$1"
  shift
  : >"${LOG}"
  (
    cd "${TMP}"
    # Only what the case passes: never a CF branch variable or a stub answer inherited from the caller.
    unset WORKERS_CI_BRANCH CF_PAGES_BRANCH WORKERS_CI WORKERS_CI_COMMIT_SHA CF_STUB_LIST CF_STUB_LIST_ERR \
      CF_STUB_LIST_RC CF_STUB_TT CF_STUB_TT_RC CF_STUB_APPLY_RC CF_STUB_BUN_VERSION
    env \
      BUN_INSTALL="${TMP}" \
      CF_BUILDS_TEST_LOG="${LOG}" \
      KIT_SHOWCASE_DEPLOY=1 \
      PATH="${BIN}:/usr/bin:/bin" \
      "$@" \
      bash "${FIXTURE}/scripts/kit/cf-builds/${script}"
  )
}

assert_calls() {
  local expected="$1"
  if ! diff -u <(printf '%s' "${expected}") "${LOG}"; then
    echo "FAIL: unexpected calls for Cloudflare build entrypoint" >&2
    exit 1
  fi
}

run_entrypoint install-monorepo.sh
assert_calls "bun|${FIXTURE}|--version
bun|${FIXTURE}|install --frozen-lockfile --minimum-release-age 0
"

# Roxabi/roxabi-boilerplate-cf#316: a Bun other than packageManager (the build image's own, or a stale BUN_VERSION) refuses
# before any install, migration, deploy or build, and names the build variable that fixes it.
assert_bun_refused() {
  local script="$1" want_calls="$2" out
  shift 2
  if out="$(run_entrypoint "${script}" CF_STUB_BUN_VERSION=1.2.15 "$@" 2>&1)"; then
    echo "FAIL: ${script} ran with bun 1.2.15 against packageManager bun@${FIXTURE_BUN}" >&2
    exit 1
  fi
  assert_calls "${want_calls}"
  if [[ "$out" != *"BUN_VERSION=${FIXTURE_BUN}"* ]]; then
    echo "FAIL: ${script} refused without naming BUN_VERSION=${FIXTURE_BUN}:" >&2
    echo "$out" >&2
    exit 1
  fi
}
assert_bun_refused install-monorepo.sh "bun|${FIXTURE}|--version
"
# Product builds run none of the showcase entrypoints: the helper runs standalone as their first step.
run_entrypoint require-bun-version.sh
assert_calls "bun|${TMP}|--version
"
assert_bun_refused require-bun-version.sh "bun|${TMP}|--version
"
# The image pre-installed node_modules, so the deploy and SPA commands skip install-monorepo.sh:
# they check the Bun themselves (Pages runs no other kit command).
mkdir "${FIXTURE}/node_modules"
assert_bun_refused api-deploy.sh "bun|${FIXTURE}|--version
" WORKERS_CI_BRANCH=deploy/main
assert_bun_refused web-build.sh "bun|${FIXTURE}|--version
" CF_PAGES_BRANCH=deploy/main
run_entrypoint web-build.sh CF_PAGES_BRANCH=deploy/main
assert_calls "bun|${FIXTURE}|--version
bun|${FIXTURE}/apps/example-web|run build
"
rmdir "${FIXTURE}/node_modules"

# Roxabi/roxabi-boilerplate-cf#316: no bun@<version> in packageManager is a refusal, never a guess.
cp "${FIXTURE}/package.json" "${TMP}/package.json.keep"
printf '{\n  "name": "fixture"\n}\n' >"${FIXTURE}/package.json"
if out="$(run_entrypoint install-monorepo.sh 2>&1)"; then
  echo "FAIL: install-monorepo.sh installed with no packageManager Bun version" >&2
  exit 1
fi
assert_calls ""
if [[ "$out" != *"packageManager names no bun@<version>"* ]]; then
  echo "FAIL: missing packageManager refused without saying so:" >&2
  echo "$out" >&2
  exit 1
fi

# Roxabi/roxabi-boilerplate-cf#316: a Corepack pin (bun@<x.y.z>+sha512.<digest>) is its x.y.z — the grammar check-bun-version.ts
# accepts — so a matching Bun passes and a refusal names an installable BUN_VERSION.
printf '{\n  "name": "fixture",\n  "packageManager": "bun@%s+sha512.abc"\n}\n' "${FIXTURE_BUN}" >"${FIXTURE}/package.json"
run_entrypoint require-bun-version.sh
assert_calls "bun|${TMP}|--version
"
if out="$(run_entrypoint require-bun-version.sh CF_STUB_BUN_VERSION=1.2.15 2>&1)"; then
  echo "FAIL: require-bun-version.sh ran with bun 1.2.15 against bun@${FIXTURE_BUN}+sha512.abc" >&2
  exit 1
fi
if [[ "$out" != *"BUN_VERSION=${FIXTURE_BUN} on"* ]]; then
  echo "FAIL: a Corepack pin refused without naming BUN_VERSION=${FIXTURE_BUN}:" >&2
  echo "$out" >&2
  exit 1
fi
# A spec outside that grammar refuses before asking Bun anything.
printf '{\n  "name": "fixture",\n  "packageManager": "bun@latest"\n}\n' >"${FIXTURE}/package.json"
if out="$(run_entrypoint require-bun-version.sh 2>&1)"; then
  echo "FAIL: require-bun-version.sh accepted packageManager bun@latest" >&2
  exit 1
fi
assert_calls ""
if [[ "$out" != *"packageManager names no bun@<version>"* ]]; then
  echo "FAIL: bun@latest refused without saying so:" >&2
  echo "$out" >&2
  exit 1
fi
mv "${TMP}/package.json.keep" "${FIXTURE}/package.json"

LIST_CALL="bunx|${FIXTURE}/apps/example-api|wrangler d1 migrations list boilerplate-api --remote --env production"
INFO_CALL="bunx|${FIXTURE}/apps/example-api|wrangler d1 time-travel info boilerplate-api --env production --json"
APPLY_CALL="bunx|${FIXTURE}/apps/example-api|wrangler d1 migrations apply boilerplate-api --remote --env production"
DEPLOY_CALL="bunx|${FIXTURE}/apps/example-api|wrangler deploy --env production --tag ${FIXTURE_SHA}"
INSTALL_CALLS="bun|${FIXTURE}|--version
bun|${FIXTURE}|install --frozen-lockfile --minimum-release-age 0"

# Roxabi/roxabi-boilerplate-cf#258: nothing pending → no recovery point, nothing extra in the log.
out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main 2>&1)"
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
if [[ "$out" == *"recovery point"* || "$out" == *bookmark* ]]; then
  echo "FAIL: a recovery point was printed with no pending migration" >&2
  exit 1
fi

# Roxabi/roxabi-boilerplate-cf#258: pending migrations → the Time Travel bookmark and the pending list are in the build log
# before anything is applied, with the restore command.
PENDING_TABLE='Migrations to be applied:
┌─────────────────────────┐
│ Name                    │
├─────────────────────────┤
│ 0016_add_extra.sql      │
├─────────────────────────┤
│ 0017_fails_mid_file.sql │
└─────────────────────────┘'
out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "CF_STUB_LIST=${PENDING_TABLE}" 2>&1)"
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${INFO_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
# assert_recovery_point <output> — bookmark, pending list and restore command, all printed before
# `migrations apply` ran (APPLY-RAN comes from the apply stub).
assert_recovery_point() {
  local out="$1" want before
  for want in "bookmark: 00000097-0000000a-000050f1-feedface" "pending:  0016_add_extra.sql 0017_fails_mid_file.sql" \
    "restore:  (runbook step 4 only, human in a TTY) cd apps/example-api && bunx wrangler d1 time-travel restore boilerplate-api --env production --bookmark=00000097-0000000a-000050f1-feedface"; do
    before="${out%%APPLY-RAN*}"
    if [[ "$before" != *"$want"* ]]; then
      echo "FAIL: recovery point missing '${want}' before the migration in:" >&2
      echo "$out" >&2
      exit 1
    fi
  done
}
assert_recovery_point "$out"

# Roxabi/roxabi-boilerplate-cf#258: the migration fails (the Nth-file case of §5b) → the deploy stops, and the recovery point is
# already in the log.
if out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "CF_STUB_LIST=${PENDING_TABLE}" CF_STUB_APPLY_RC=1 2>&1)"; then
  echo "FAIL: api-deploy.sh succeeded although the migration failed" >&2
  exit 1
fi
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${INFO_CALL}
${APPLY_CALL}
"
assert_recovery_point "$out"

# Roxabi/roxabi-boilerplate-cf#258: wrangler's stderr (warnings, hints naming *.sql files) is not the pending list.
out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main \
  "CF_STUB_LIST_ERR=▲ [WARNING] no files matching migrations/*/migration.sql; seed.sql ignored" 2>&1)"
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
if [[ "$out" == *"recovery point"* ]]; then
  echo "FAIL: a stderr hint was read as a pending migration" >&2
  exit 1
fi

# Roxabi/roxabi-boilerplate-cf#258: nested migration names are kept whole, colour codes are stripped.
NESTED_TABLE=$'Migrations to be applied:\n┌──────────────────────────┐\n│ \e[32mName\e[0m │\n├──────────────────────────┤\n│ \e[32m0016_add_extra/migration.sql\e[0m │\n└──────────────────────────┘'
out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "CF_STUB_LIST=${NESTED_TABLE}" 2>&1)"
if [[ "$out" != *"pending:  0016_add_extra/migration.sql"$'\n'* ]]; then
  echo "FAIL: nested or coloured pending names were mangled in:" >&2
  echo "$out" >&2
  exit 1
fi

# Roxabi/roxabi-boilerplate-cf#258: no recovery point → no migration and no deploy (listing fails, unknown listing, Time
# Travel fails, no bookmark in its answer).
assert_no_migrate() {
  local label="$1" want_calls="$2"
  shift 2
  if run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "$@" >/dev/null 2>&1; then
    echo "FAIL: api-deploy.sh succeeded when ${label}" >&2
    exit 1
  fi
  assert_calls "${want_calls}"
}
assert_no_migrate "the pending list fails" "${INSTALL_CALLS}
${LIST_CALL}
" CF_STUB_LIST_RC=1
assert_no_migrate "the pending list is unrecognised" "${INSTALL_CALLS}
${LIST_CALL}
" "CF_STUB_LIST=Something else entirely"
assert_no_migrate "time-travel info fails" "${INSTALL_CALLS}
${LIST_CALL}
${INFO_CALL}
" "CF_STUB_LIST=${PENDING_TABLE}" CF_STUB_TT_RC=1
assert_no_migrate "time-travel info has no bookmark" "${INSTALL_CALLS}
${LIST_CALL}
${INFO_CALL}
" "CF_STUB_LIST=${PENDING_TABLE}" "CF_STUB_TT={}"
assert_no_migrate "the pending header has an empty table" "${INSTALL_CALLS}
${LIST_CALL}
" $'CF_STUB_LIST=Migrations to be applied:\n┌──────┐\n│ Name │\n├──────┤\n└──────┘'

# Roxabi/roxabi-boilerplate-cf#258: only rows under the stdout header are pending — not a table row on stderr, not a box drawn
# before the header.
for noise in $'CF_STUB_LIST_ERR=Migrations to be applied:\n│ 0099_from_stderr.sql │' \
  $'CF_STUB_LIST=│ 0099_banner.sql │\n✅ No migrations to apply!'; do
  out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "${noise}" 2>&1)"
  assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
  if [[ "$out" == *"recovery point"* ]]; then
    echo "FAIL: '${noise}' was read as a pending migration" >&2
    exit 1
  fi
done

# Roxabi/roxabi-boilerplate-cf#258: the stub speaks the rehearsed wrangler text; the locked wrangler must still print it, or
# every showcase deploy would stop at the listing while CI stays green.
WRANGLER_CLI="${ROOT}/apps/example-api/node_modules/wrangler/wrangler-dist/cli.js"
[[ -f "${WRANGLER_CLI}" ]] || WRANGLER_CLI="${ROOT}/node_modules/wrangler/wrangler-dist/cli.js"
for literal in "Migrations to be applied:" "No migrations to apply"; do
  if ! grep -qF "${literal}" "${WRANGLER_CLI}" 2>/dev/null; then
    echo "FAIL: the installed wrangler (${WRANGLER_CLI}) no longer prints '${literal}' — update api-deploy.sh and this stub" >&2
    exit 1
  fi
done

run_entrypoint web-build.sh CF_PAGES_BRANCH=deploy/main
assert_calls "bun|${FIXTURE}|--version
bun|${FIXTURE}|install --frozen-lockfile --minimum-release-age 0
bun|${FIXTURE}/apps/example-web|run build
"

# Roxabi/roxabi-boilerplate-cf#256: only the CI-gated deploy/main branch ships. main itself (a push CI has not passed yet),
# deploy/staging, an empty or an unset branch must refuse before any install, migration, deploy or
# build call. With no variable the git fallback runs, and the fixture's branch is not deploy/main.
assert_refused() {
  local script="$1" label="$2"
  shift 2
  : >"${LOG}"
  if run_entrypoint "${script}" "$@" 2>/dev/null; then
    echo "FAIL: ${script} shipped with ${label} (must require deploy/main)" >&2
    exit 1
  fi
  if [[ -s "${LOG}" ]]; then
    echo "FAIL: ${script} ran tools before refusing ${label}:" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}
for pair in "api-deploy.sh:WORKERS_CI_BRANCH" "web-build.sh:CF_PAGES_BRANCH"; do
  script="${pair%%:*}"
  var="${pair#*:}"
  assert_refused "${script}" "${var}=main" "${var}=main"
  assert_refused "${script}" "${var}=deploy/staging" "${var}=deploy/staging"
  assert_refused "${script}" "${var}=deploy/main-x" "${var}=deploy/main-x"
  assert_refused "${script}" "an empty ${var}" "${var}="
  assert_refused "${script}" "no branch variable" KIT_TEST_NO_BRANCH=1
done

# A refs/heads/ prefix, if a builder ever reports one, is the same branch.
run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=refs/heads/deploy/main
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"

# go-silex/unkillable-kit#215: the version is tagged with the commit it ships. In Workers Builds that is
# WORKERS_CI_COMMIT_SHA, held to the checkout HEAD; elsewhere HEAD of a clean worktree. Anything
# unverifiable refuses before install, migration or deploy.
run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main WORKERS_CI=1 "WORKERS_CI_COMMIT_SHA=${FIXTURE_SHA}"
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
assert_sha_refused() {
  local label="$1" want="$2" out
  shift 2
  if out="$(run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main "$@" 2>&1)"; then
    echo "FAIL: api-deploy.sh shipped with ${label}" >&2
    exit 1
  fi
  assert_calls ""
  if [[ "$out" != *"${want}"* ]]; then
    echo "FAIL: ${label} refused without saying '${want}':" >&2
    echo "$out" >&2
    exit 1
  fi
}
assert_sha_refused "Workers Builds and no commit SHA" "set no WORKERS_CI_COMMIT_SHA" WORKERS_CI=1
assert_sha_refused "another commit SHA" "is not the checkout HEAD" WORKERS_CI=1 \
  "WORKERS_CI_COMMIT_SHA=$(printf '%040d' 0)"
assert_sha_refused "an uppercase SHA" "is not a full lowercase commit SHA" WORKERS_CI=1 \
  "WORKERS_CI_COMMIT_SHA=${FIXTURE_SHA^^}"
assert_sha_refused "a short SHA" "is not a full lowercase commit SHA" WORKERS_CI=1 \
  "WORKERS_CI_COMMIT_SHA=${FIXTURE_SHA:0:12}"
# Outside Workers Builds, other bytes than HEAD's would ship under its name: an untracked or a
# modified file refuses, even when WORKERS_CI_COMMIT_SHA names HEAD and whatever
# status.showUntrackedFiles hides. Workers Builds checks out the commit it names and is not held to that.
touch "${FIXTURE}/apps/example-api/stray.ts"
assert_sha_refused "an untracked file" "uncommitted changes"
assert_sha_refused "an untracked file and the HEAD SHA outside Workers Builds" "uncommitted changes" \
  "WORKERS_CI_COMMIT_SHA=${FIXTURE_SHA}"
git -C "${FIXTURE}" config status.showUntrackedFiles no
assert_sha_refused "an untracked file git status is told to hide" "uncommitted changes"
git -C "${FIXTURE}" config --unset status.showUntrackedFiles
run_entrypoint api-deploy.sh WORKERS_CI_BRANCH=deploy/main WORKERS_CI=1 "WORKERS_CI_COMMIT_SHA=${FIXTURE_SHA}"
assert_calls "${INSTALL_CALLS}
${LIST_CALL}
${APPLY_CALL}
${DEPLOY_CALL}
"
rm "${FIXTURE}/apps/example-api/stray.ts"
printf '\n' >>"${FIXTURE}/package.json"
assert_sha_refused "a modified tracked file" "uncommitted changes"
git -C "${FIXTURE}" checkout -q -- package.json
mv "${FIXTURE}/.git" "${TMP}/fixture.git"
assert_sha_refused "no git checkout" "is not a git checkout" "GIT_CEILING_DIRECTORIES=${TMP}"
mv "${TMP}/fixture.git" "${FIXTURE}/.git"
# Product deploy scripts run the helper directly: the SHA alone on stdout, no tool call.
out="$(run_entrypoint require-deploy-sha.sh 2>/dev/null)"
assert_calls ""
if [[ "$out" != "${FIXTURE_SHA}" ]]; then
  echo "FAIL: require-deploy-sha.sh printed '${out}', not ${FIXTURE_SHA}" >&2
  exit 1
fi

echo "cf-builds: OK"
