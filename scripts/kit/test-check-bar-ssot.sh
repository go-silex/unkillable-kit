#!/usr/bin/env bash
# Self-test for scripts/kit/check-bar-ssot.sh
#
# Exit 0 only if fixture matrix + live kit tree pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/kit/check-bar-ssot.sh"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "FAIL: missing ${SCRIPT}" >&2
  exit 1
fi
chmod +x "${SCRIPT}" 2>/dev/null || true

PASS=0
FAIL=0

assert_exit() {
  local name="$1"
  local expect="$2"
  local tree="$3"
  local got=0
  local out
  set +e
  out="$(BAR_SSOT_ROOT="${tree}" bash "${SCRIPT}" 2>&1)"
  got=$?
  set -e
  if [[ "${got}" -ne "${expect}" ]]; then
    echo "  FAIL: ${name} expected exit ${expect}, got ${got}" >&2
    echo "    out: $(echo "${out}" | tr '\n' ' ')" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  PASS: ${name} (exit ${got})"
  PASS=$((PASS + 1))
}

seed_ok() {
  local tree="$1"
  mkdir -p "${tree}/docs/kit/standards" "${tree}/docs/kit/processes" "${tree}/scripts/kit" \
    "${tree}/config/kit"
  cp "${ROOT}/config/kit/bunfig.gates.toml" "${tree}/config/kit/bunfig.gates.toml"
  mkdir -p "${tree}/.lefthook/pre-push"
  cp "${ROOT}/scripts/kit/root-gate.ts" "${tree}/scripts/kit/root-gate.ts"
  local module
  for module in "${ROOT}"/scripts/kit/root-gate-*.ts; do
    [[ -f "${module}" && "${module}" != *.test.ts ]] || continue
    cp "${module}" "${tree}/scripts/kit/"
  done
  cat >"${tree}/scripts/kit/test-coverage.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "${COVERAGE_LIST_PARTS:-}" == 1 ]]; then
  echo 'apps/example-api 2'
elif [[ "${COVERAGE_LIST_ONLY:-}" == 1 ]]; then
  echo 'apps/example-api'
fi
EOF
  cat >"${tree}/package.json" <<'EOF'
{
  "scripts": {
    "validate:full": "bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/root-gate.ts uniquely-zz-gate lint typecheck banlist zod-major ts-major import-boundary test:kit-schema-sync wrangler-migrations:check test:wrangler-migrations zero-edit extract-dry-run test:coverage",
    "validate:tooling": "bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/root-gate.ts tooling-one tooling-two tooling-three",
    "tooling-one": "true", "tooling-two": "true", "tooling-three": "true",
    "uniquely-zz-gate": "true", "lint": "true", "typecheck": "true", "banlist": "true",
    "zod-major": "true", "ts-major": "true", "import-boundary": "true",
    "test:kit-schema-sync": "true", "wrangler-migrations:check": "true",
    "test:wrangler-migrations": "true", "zero-edit": "true", "extract-dry-run": "true",
    "test:coverage": "true"
  }
}
EOF
  cat >"${tree}/AGENTS.md" <<'EOF'
# kit
pre-push runs `bun run validate:full` (SSoT: root package.json).
EOF
  cat >"${tree}/docs/kit/testing.md" <<'EOF'
# testing
Primary bar: `bun run validate:full`.
EOF
  cat >"${tree}/docs/kit/README.md" <<'EOF'
# docs
Primary bar: `bun run validate:full`.
EOF
  cat >"${tree}/docs/kit/standards/stack.md" <<'EOF'
# stack
Primary bar: `bun run validate:full`.
EOF
  cat >"${tree}/docs/kit/processes/dev-process.md" <<'EOF'
# development process
Primary bar: `bun run validate:full`.
EOF
  cat >"${tree}/lefthook.yml" <<'EOF'
# steps = package.json `validate:full` — do not copy them here.
pre-push:
  scripts:
    "validate-full.sh":
      runner: bash
      args: "--"
      skip: false
    "validate-tooling.sh":
      runner: bash
      args: '"{1}"'
      skip: false
      use_stdin: true
EOF
  cat >"${tree}/.lefthook/pre-push/validate-full.sh" <<'EOF'
exec bun run validate:full
EOF
  cat >"${tree}/.lefthook/pre-push/validate-tooling.sh" <<'EOF'
bun scripts/kit/select-tooling.ts --pre-push "$1"
bun run validate:tooling
EOF
}

echo "== CP-BAR-SSOT =="
TMP="$(mktemp -d -t cp-bar-ssot-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

assert_exit "live kit tree → 0" 0 "${ROOT}"

OK="${TMP}/ok"
seed_ok "${OK}"
assert_exit "pointer-only docs → 0" 0 "${OK}"

BAD_LINE="${TMP}/bad-line"
seed_ok "${BAD_LINE}"
cat >"${BAD_LINE}/AGENTS.md" <<'EOF'
# kit
CI = validate:full (= lint · typecheck · banlist · zod-major · test:kit-schema-sync · wrangler-migrations)
EOF
assert_exit "single-line inventory → 1" 1 "${BAD_LINE}"

BAD_STANDARD="${TMP}/bad-standard"
seed_ok "${BAD_STANDARD}"
cat >"${BAD_STANDARD}/docs/kit/standards/stack.md" <<'EOF'
# stack
CI = validate:full (= lint · typecheck · banlist · zod-major)
EOF
assert_exit "normative stack inventory → 1" 1 "${BAD_STANDARD}"

BAD_SPLIT="${TMP}/bad-split"
seed_ok "${BAD_SPLIT}"
mkdir -p "${BAD_SPLIT}/docs/kit/testing"
printf '%s\n' 'validate:full = lint · typecheck · banlist' >"${BAD_SPLIT}/docs/kit/testing/section.md"
assert_exit "split testing section inventory → 1" 1 "${BAD_SPLIT}"

BAD_WRAP="${TMP}/bad-wrap"
seed_ok "${BAD_WRAP}"
cat >"${BAD_WRAP}/.lefthook/pre-push/validate-full.sh" <<'EOF'
# validate:full = uniquely-zz-gate · lint ·
#                 typecheck · banlist
exec bun run validate:full
EOF
assert_exit "wrapped middot inventory → 1" 1 "${BAD_WRAP}"

TWO="${TMP}/two-markers"
seed_ok "${TWO}"
cat >"${TWO}/docs/kit/testing.md" <<'EOF'
| **CP-KIT-SCHEMA** | sync + wrangler | `bun run test:kit-schema-sync` · `bun run wrangler-migrations:check` |
EOF
assert_exit "two markers on a CP row → 0" 0 "${TWO}"

THREE="${TMP}/three-no-vf"
seed_ok "${THREE}"
cat >"${THREE}/docs/kit/testing.md" <<'EOF'
| **CP-KIT-SCHEMA** | sync + wrangler | `bun run test:kit-schema-sync` · `bun run wrangler-migrations:check` · `bun run test:wrangler-migrations` |
EOF
assert_exit "three markers without validate:full → 0" 0 "${THREE}"

NEW_MARKERS="${TMP}/new-markers"
seed_ok "${NEW_MARKERS}"
cat >"${NEW_MARKERS}/AGENTS.md" <<'EOF'
# kit
CI = validate:full (= uniquely-zz-gate · lint · typecheck)
EOF
assert_exit "tokenizer unique name from fixture package.json → 1" 1 "${NEW_MARKERS}"

BAD_LH="${TMP}/bad-lefthook"
seed_ok "${BAD_LH}"
cat >"${BAD_LH}/.lefthook/pre-push/validate-full.sh" <<'EOF'
bun run lint && bun run typecheck && bun run ts-major && bun run import-boundary
EOF
assert_exit "lefthook copies inner steps → 1" 1 "${BAD_LH}"

PLAN_LH="${TMP}/plan-lefthook"
seed_ok "${PLAN_LH}"
cat >"${PLAN_LH}/.lefthook/pre-push/validate-full.sh" <<'EOF'
exec bun run validate:full -- --plan
EOF
assert_exit "lefthook plan is not full execution → 1" 1 "${PLAN_LH}"

PLAN_CI="${TMP}/plan-ci"
seed_ok "${PLAN_CI}"
mkdir -p "${PLAN_CI}/.github/workflows"
cat >"${PLAN_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full -- --plan
      - run: bun scripts/kit/select-tooling.ts
      - run: bun run validate:tooling
EOF
assert_exit "ci plan is not full execution → 1" 1 "${PLAN_CI}"

PARTIAL_CI="${TMP}/partial-ci"
seed_ok "${PARTIAL_CI}"
mkdir -p "${PARTIAL_CI}/.github/workflows"
cat >"${PARTIAL_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full -- --ci-group core --receipt /tmp/root-core.json
      - run: bun scripts/kit/select-tooling.ts
      - run: bun run validate:tooling
EOF
assert_exit "ci partial group is not full execution → 1" 1 "${PARTIAL_CI}"

BAD_CI="${TMP}/bad-ci"
seed_ok "${BAD_CI}"
mkdir -p "${BAD_CI}/.github/workflows"
cat >"${BAD_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: echo "bun run validate:full"
      - run: bun scripts/kit/select-tooling.ts
      - run: bun run validate:tooling
EOF
assert_exit "ci echo substring is not invoke by name → 1" 1 "${BAD_CI}"

COMMENT_CI="${TMP}/comment-ci"
seed_ok "${COMMENT_CI}"
mkdir -p "${COMMENT_CI}/.github/workflows"
printf '%s\n' '# bun run validate:full' >"${COMMENT_CI}/.github/workflows/ci.yml"
assert_exit "ci comment is not invocation → 1" 1 "${COMMENT_CI}"

BAD_RECIPE="${TMP}/bad-recipe"
seed_ok "${BAD_RECIPE}"
TREE="${BAD_RECIPE}" bun -e 'const p = `${process.env.TREE}/package.json`; const j = await Bun.file(p).json(); j.scripts["validate:full"] += " test:coverage"; await Bun.write(p, JSON.stringify(j))'
assert_exit "duplicate coverage in canonical recipe → 1" 1 "${BAD_RECIPE}"

OK_CI="${TMP}/ok-ci"
seed_ok "${OK_CI}"
mkdir -p "${OK_CI}/.github/workflows"
cat >"${OK_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full
      - run: bun scripts/kit/select-tooling.ts
      - run: bun run validate:tooling
EOF
assert_exit "ci run: bun run validate:full → 0" 0 "${OK_CI}"

SHARDED_CI="${TMP}/sharded-ci"
seed_ok "${SHARDED_CI}"
mkdir -p "${SHARDED_CI}/.github/workflows"
cat >"${SHARDED_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full -- --ci-join "$RUNNER_TEMP/root-receipts" --producers-result "$PRODUCERS_RESULT" --coverage-result "$COVERAGE_RESULT" --parts-result "$PARTS_RESULT"
      - run: bun scripts/kit/select-tooling.ts
      - run: |
          bun run validate:tooling -- --ci-tooling-shard '${{ matrix.shard.index }}/${{ matrix.shard.count }}' --receipt "$RUNNER_TEMP/tooling-receipts/tooling-${{ matrix.shard.index }}.json"
      - run: bun run validate:tooling -- --ci-tooling-join "$RUNNER_TEMP/tooling-receipts" --producers-result "$PRODUCERS_RESULT"
EOF
assert_exit "ci canonical shard and join → 0" 0 "${SHARDED_CI}"

workflow="$(<"${SHARDED_CI}/.github/workflows/ci.yml")"
for omitted in ' --coverage-result "$COVERAGE_RESULT"' ' --parts-result "$PARTS_RESULT"'; do
  printf '%s\n' "${workflow/"${omitted}"/}" >"${SHARDED_CI}/.github/workflows/ci.yml"
  assert_exit "root join missing a coverage producer result → 1" 1 "${SHARDED_CI}"
done
shard="bun run validate:tooling -- --ci-tooling-shard '\${{ matrix.shard.index }}/\${{ matrix.shard.count }}' --receipt \"\$RUNNER_TEMP/tooling-receipts/tooling-\${{ matrix.shard.index }}.json\""
join='bun run validate:tooling -- --ci-tooling-join "$RUNNER_TEMP/tooling-receipts" --producers-result "$PRODUCERS_RESULT"'
for replacement in \
  'bun run validate:tooling -- --plan' \
  'bun run validate:tooling -- --ci-tooling-shard 1/3' \
  "echo \"${shard}\""; do
  printf '%s\n' "${workflow/"${shard}"/"${replacement}"}" >"${SHARDED_CI}/.github/workflows/ci.yml"
  assert_exit "missing or non-executing tooling shard → 1" 1 "${SHARDED_CI}"
done
for replacement in \
  'bun run validate:tooling -- --plan' \
  "# ${join}" \
  'bun run validate:tooling -- --ci-tooling-join receipts'; do
  printf '%s\n' "${workflow/"${join}"/"${replacement}"}" >"${SHARDED_CI}/.github/workflows/ci.yml"
  assert_exit "missing or non-executing tooling join → 1" 1 "${SHARDED_CI}"
done

BAD_TOOLING_LIST="${TMP}/bad-tooling-list"
seed_ok "${BAD_TOOLING_LIST}"
echo 'validate:tooling = tooling-one · tooling-two · tooling-three' >"${BAD_TOOLING_LIST}/AGENTS.md"
assert_exit "tooling inventory copied to docs → 1" 1 "${BAD_TOOLING_LIST}"

BAD_TOOLING_WRAP="${TMP}/bad-tooling-wrap"
seed_ok "${BAD_TOOLING_WRAP}"
cat >"${BAD_TOOLING_WRAP}/docs/kit/testing.md" <<'EOF'
validate:tooling = tooling-one · tooling-two ·
  tooling-three
EOF
assert_exit "wrapped tooling inventory → 1" 1 "${BAD_TOOLING_WRAP}"

BAD_TOOLING_RECIPE="${TMP}/bad-tooling-recipe"
seed_ok "${BAD_TOOLING_RECIPE}"
TREE="${BAD_TOOLING_RECIPE}" bun -e 'const p = `${process.env.TREE}/package.json`; const j = await Bun.file(p).json(); j.scripts["validate:tooling"] += " validate:tooling"; await Bun.write(p, JSON.stringify(j))'
assert_exit "recursive tooling recipe → 1" 1 "${BAD_TOOLING_RECIPE}"

MISSING_TOOLING_HOOK="${TMP}/missing-tooling-hook"
seed_ok "${MISSING_TOOLING_HOOK}"
cat >"${MISSING_TOOLING_HOOK}/lefthook.yml" <<'EOF'
pre-push:
  scripts:
    "validate-full.sh":
      runner: bash
      args: "--"
      skip: false
  # validate-tooling.sh exists but isn't registered
EOF
assert_exit "missing tooling script registration → 1" 1 "${MISSING_TOOLING_HOOK}"

COMMAND_HOOK="${TMP}/command-hook"
seed_ok "${COMMAND_HOOK}"
cat >"${COMMAND_HOOK}/lefthook.yml" <<'EOF'
pre-push:
  commands:
    validate-full:
      run: bun run validate:full
    validate-tooling:
      run: |
        bun scripts/kit/select-tooling.ts --pre-push "{1}"
        bun run validate:tooling
EOF
assert_exit "inline pre-push commands are not scripts → 1" 1 "${COMMAND_HOOK}"

ECHO_HOOK="${TMP}/echo-hook"
seed_ok "${ECHO_HOOK}"
cat >"${ECHO_HOOK}/lefthook.yml" <<'EOF'
pre-push:
  scripts:
    "validate-full.sh":
      runner: bash
      args: "--"
      skip: false
    "validate-tooling.sh":
      runner: echo
      args: '"{1}"'
      skip: false
      use_stdin: true
EOF
assert_exit "echo runner does not execute the tooling wrapper → 1" 1 "${ECHO_HOOK}"

MISSING_TOOLING_CI="${TMP}/missing-tooling-ci"
seed_ok "${MISSING_TOOLING_CI}"
mkdir -p "${MISSING_TOOLING_CI}/.github/workflows"
cat >"${MISSING_TOOLING_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full
      - run: bun scripts/kit/select-tooling.ts
      - run: echo "bun run validate:tooling"
EOF
assert_exit "missing tooling ci invocation → 1" 1 "${MISSING_TOOLING_CI}"

MISSING_SELECTOR_HOOK="${TMP}/missing-selector-hook"
seed_ok "${MISSING_SELECTOR_HOOK}"
cat >"${MISSING_SELECTOR_HOOK}/.lefthook/pre-push/validate-tooling.sh" <<'EOF'
bun run validate:tooling
EOF
assert_exit "missing hook selector → 1" 1 "${MISSING_SELECTOR_HOOK}"

MISSING_SELECTOR_CI="${TMP}/missing-selector-ci"
seed_ok "${MISSING_SELECTOR_CI}"
mkdir -p "${MISSING_SELECTOR_CI}/.github/workflows"
cat >"${MISSING_SELECTOR_CI}/.github/workflows/ci.yml" <<'EOF'
jobs:
  quality:
    steps:
      - run: bun run validate:full
      - run: bun run validate:tooling
EOF
assert_exit "missing ci selector → 1" 1 "${MISSING_SELECTOR_CI}"

MISSING_DOCS="${TMP}/missing-docs"
seed_ok "${MISSING_DOCS}"
rm -f "${MISSING_DOCS}/docs/kit/testing.md"
assert_exit "missing docs/kit/testing.md → 1" 1 "${MISSING_DOCS}"

MISSING_PKG="${TMP}/missing-pkg"
mkdir -p "${MISSING_PKG}"
echo '# only agents' >"${MISSING_PKG}/AGENTS.md"
assert_exit "missing package.json → 1" 1 "${MISSING_PKG}"

# Git passes a literal URL as the remote name when pushing to it directly.
(
  unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  # shellcheck source=lib/hermetic-git.sh
  XDG_RUNTIME_DIR="${TMP}" source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
  export PATH="${TMP}/bin:${ROOT}/node_modules/.bin:${PATH}"
  export PUSH_URL="${TMP}/remote's.git"
  probe="${TMP}/push-probe"
  git init -q --template='' --initial-branch=main --bare "$PUSH_URL"
  git init -q --template='' --initial-branch=main "$probe"
  cd "$probe"
  tree="$(git mktree </dev/null)"
  head="$(git -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree "$tree" -m init)"
  git update-ref refs/heads/main "$head"
  git push -q "$PUSH_URL" main

  mkdir -p "${TMP}/bin" .lefthook/pre-push scripts/kit config/product
  cp "${ROOT}/lefthook.yml" .
  cp "${ROOT}"/.lefthook/pre-push/{deny-upstream,validate-tooling}.sh .lefthook/pre-push/
  cp "${ROOT}/scripts/kit/deny-upstream-push.sh" scripts/kit/
  for gate in trufflehog validate-full; do
    printf '#!/usr/bin/env bash\nexit 0\n' >".lefthook/pre-push/${gate}.sh"
  done
  chmod +x .lefthook/pre-push/*.sh
  cat >"${TMP}/bin/bun" <<'SH'
#!/usr/bin/env bash
set -eu
if [[ "$*" == 'run validate:tooling' ]]; then
  echo 'fixture tooling lane ran'
else
  [[ $# == 3 && $1 == scripts/kit/select-tooling.ts && $2 == --pre-push && $3 == "$PUSH_URL" ]]
  IFS=' ' read -r local_ref local_sha remote_ref remote_sha
  [[ $local_ref == refs/heads/main && $remote_ref == refs/heads/probe ]]
  [[ $local_sha == "$(git rev-parse HEAD)" && $remote_sha == 0000000000000000000000000000000000000000 ]]
fi
SH
  chmod +x "${TMP}/bin/bun"
  lefthook install
  out="$(git push "$PUSH_URL" main:probe 2>&1)" || { echo "$out" >&2; exit 1; }
  grep -Fq 'fixture tooling lane ran' <<< "$out"

  printf '{"version":1,"upstreamCommit":"%s"}\n' "$head" >config/product/inheritance.json
  git remote add upstream "$PUSH_URL"
  if out="$(git push upstream main:blocked 2>&1)"; then
    echo 'FAIL: deny-upstream allowed the Product push' >&2
    exit 1
  fi
  grep -Fq "remote=upstream url=$PUSH_URL" <<< "$out"
  echo '  PASS: pre-push forwards apostrophe URL and stdin; deny-upstream still blocks'
)
PASS=$((PASS + 1))

echo "== summary: ${PASS} passed, ${FAIL} failed =="
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
echo "CP-BAR-SSOT: OK"
exit 0
