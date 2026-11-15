#!/usr/bin/env bash
# Hermetic self-test for promote-deploy.ts (Roxabi/roxabi-boilerplate-cf#256): `deploy/<branch>` only ever moves, fast-forward,
# to the newest first-parent commit whose required workflows all succeeded on their push run for
# that exact SHA. `gh` is stubbed with per-SHA workflow-run fixtures and fails on any other query;
# git runs against a local bare "origin". The harness plays the workflow's push step.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/kit/promote-deploy.ts"
[[ -f "$SCRIPT" ]] || {
  echo "missing ${SCRIPT}" >&2
  exit 1
}

PASS=0
FAIL=0
ok() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}
ko() {
  echo "FAIL: $1" >&2
  FAIL=$((FAIL + 1))
}

TMP="$(mktemp -d -t promote-deploy.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# gh stub: only the exact runs query the gate is allowed to make; fixture per branch/SHA.
BIN="${TMP}/bin"
RUNS="${TMP}/runs"
mkdir -p "$BIN" "$RUNS"
cat >"${BIN}/gh" <<'EOF'
#!/usr/bin/env bash
q="${2:-}"
if [ "$1" = api ] && [ "$#" -eq 2 ] &&
  [[ "$q" =~ ^repos/example/kit/actions/runs\?head_sha=([0-9a-f]{40})\&event=push\&branch=(main|staging)\&per_page=100$ ]]; then
  f="${PROMOTE_TEST_RUNS:?}/${BASH_REMATCH[2]}/${BASH_REMATCH[1]}.json"
  if [ -f "$f" ]; then cat "$f"; else echo '{"total_count":0,"workflow_runs":[]}'; fi
  exit 0
fi
echo "gh stub: unexpected call: $*" >&2
exit 1
EOF
chmod +x "${BIN}/gh"

NEXT_ID=100
# run_json <path> <state> [name] — sets RUN_JSON; state: success|failure|cancelled|skipped|
# in_progress|queued. Ids grow with every call (no subshell), so a later run is always the newer one.
run_json() {
  local name="${3:-}"
  if [[ -z "$name" ]]; then
    case "$1" in
      */ci.yml) name=CI ;;
      */secret-scan.yml) name="Secret scan" ;;
      *) name="Product CI" ;;
    esac
  fi
  NEXT_ID=$((NEXT_ID + 1))
  case "$2" in
    in_progress | queued) RUN_JSON="$(printf '{"id":%d,"name":"%s","path":"%s","status":"%s","conclusion":null}' "$NEXT_ID" "$name" "$1" "$2")" ;;
    *) RUN_JSON="$(printf '{"id":%d,"name":"%s","path":"%s","status":"completed","conclusion":"%s"}' "$NEXT_ID" "$name" "$1" "$2")" ;;
  esac
}

# runs <branch> <sha> <ci> <scan> [product] — "absent" omits that workflow's run.
runs() {
  local branch="$1" sha="$2" out="" i state
  local -a paths=(.github/workflows/ci.yml .github/workflows/secret-scan.yml .github/workflows/product-ci.yml)
  local -a states=("$3" "$4" "${5:-absent}")
  for i in 0 1 2; do
    state="${states[$i]}"
    [[ "$state" == absent ]] && continue
    run_json "${paths[$i]}" "$state"
    out+="${RUN_JSON},"
  done
  mkdir -p "${RUNS}/${branch}"
  printf '{"total_count":%d,"workflow_runs":[%s]}\n' "$(grep -o '"id"' <<<"$out" | wc -l | tr -d ' ')" "${out%,}" >"${RUNS}/${branch}/${sha}.json"
}

# add_run <branch> <sha> <path> <state> [name] — append a newer run for an existing fixture.
add_run() {
  local f="${RUNS}/$1/$2.json" extra
  run_json "$3" "$4" "${5:-}"
  extra="$RUN_JSON"
  bun -e '
    const [p, extra] = process.argv.slice(1); const d = JSON.parse(await Bun.file(p).text());
    d.workflow_runs.push(JSON.parse(extra)); d.total_count = d.workflow_runs.length; await Bun.write(p, JSON.stringify(d));
  ' "$f" "$extra"
}

# reverse_runs <branch> <sha> — GitHub does not promise result order; selection is by run ID.
reverse_runs() {
  local f="${RUNS}/$1/$2.json"
  bun -e '
    const [p] = process.argv.slice(1); const d = JSON.parse(await Bun.file(p).text());
    d.workflow_runs.reverse(); await Bun.write(p, JSON.stringify(d));
  ' "$f"
}

ORIGIN="${TMP}/origin.git"
WORK="${TMP}/work"
git init -q --bare "$ORIGIN"
git init -q -b main "$WORK"
git -C "$WORK" config user.email kit@example.com
git -C "$WORK" config user.name kit
git -C "$WORK" config commit.gpgsign false
git -C "$WORK" remote add origin "$ORIGIN"

commit() {
  printf '%s\n' "$1" >"${WORK}/f.txt"
  git -C "$WORK" add f.txt
  git -C "$WORK" commit -q -m "$1"
  git -C "$WORK" rev-parse HEAD
}

# pin_deploy <sha> [source] — that commit is the source tip and deploy/<source>.
pin_deploy() {
  local sha="$1" source="${2:-main}"
  git -C "$WORK" push -q -f origin "${sha}:refs/heads/${source}" "${sha}:refs/heads/deploy/${source}"
}

# commit_product <message> <json|-> — inheritance.json plus a gate file, or "-" to omit the gate file.
commit_product() {
  local msg="$1" json="$2"
  mkdir -p "${WORK}/config/product"
  printf '{"version":1}\n' >"${WORK}/config/product/inheritance.json"
  if [[ "$json" == "-" ]]; then
    rm -rf "${WORK}/config/product/deploy-gate.json"
  else
    printf '%s\n' "$json" >"${WORK}/config/product/deploy-gate.json"
  fi
  git -C "$WORK" add -A -- config/product
  git -C "$WORK" commit -q -m "$msg"
  git -C "$WORK" rev-parse HEAD
}
remote_ref() {
  git -C "$ORIGIN" rev-parse --verify --quiet "refs/heads/$1" || echo none
}

# gate [source] [env…] — decide, then push like the workflow does. Sets RC, OUT, PROMOTED.
gate() {
  local source="${1:-main}"
  shift || true
  local outfile="${TMP}/gh-output"
  : >"$outfile"
  RC=0
  OUT="$(cd "$WORK" && env PATH="${BIN}:${PATH}" PROMOTE_TEST_RUNS="$RUNS" GITHUB_REPOSITORY=example/kit \
    SOURCE_BRANCH="$source" GITHUB_OUTPUT="$outfile" "$@" bun "$SCRIPT" 2>&1)" || RC=$?
  PROMOTED="$(sed -n 's/^promote=//p' "$outfile")"
  local target
  target="$(sed -n 's/^target=//p' "$outfile")"
  if [[ -n "$PROMOTED" ]]; then
    git -C "$WORK" push -q origin "${PROMOTED}:refs/heads/${target}"
  fi
}

echo "== promote-deploy self-test =="

A="$(commit a)"
git -C "$WORK" push -q origin main
runs main "$A" success success

# 1 — no deploy branch: bootstrap is an operator step, never an implicit trust.
gate main
if [[ "$RC" -ne 0 && "$(remote_ref deploy/main)" == none && "$OUT" == *"bootstrap"* ]]; then
  ok "missing deploy/main is refused (bootstrap)"
else
  ko "missing deploy/main was not refused (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" push -q origin "${A}:refs/heads/deploy/main"

# 2 — green: promoted to exactly that SHA.
B="$(commit b)"
git -C "$WORK" push -q origin main
runs main "$B" success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$B" ]]; then
  ok "green push runs promote that SHA"
else
  ko "green SHA not promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi

# 3..7 — anything short of success on either kit workflow keeps deploy/main where it is.
check_blocked() {
  local label="$1" ci="$2" scan="$3" sha
  sha="$(commit "$label")"
  git -C "$WORK" push -q origin main
  runs main "$sha" "$ci" "$scan"
  gate main
  if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$B" && -z "$PROMOTED" ]]; then
    ok "$label keeps deploy/main"
  else
    ko "$label moved deploy/main (rc=$RC, deploy=$(remote_ref deploy/main))"
    echo "$OUT" >&2
  fi
  git -C "$WORK" reset -q --hard "$B"
  git -C "$WORK" push -q -f origin main
}
check_blocked "red ci" failure success
check_blocked "cancelled secret scan" success cancelled
check_blocked "skipped ci" skipped success
check_blocked "queued secret scan" success queued
check_blocked "missing secret scan run" success absent

# 8 — each workflow path is decided by its highest run ID, regardless of API result order.
C="$(commit c)"
git -C "$WORK" push -q origin main

# An older green CI run must not outvote a newer red CI run in either API order.
runs main "$C" success success
add_run main "$C" .github/workflows/ci.yml failure
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$B" && -z "$PROMOTED" ]]; then
  ok "latest run of a workflow decides (newer failure beats older success)"
else
  ko "an older success outvoted a newer failure (deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
reverse_runs main "$C"
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$B" && -z "$PROMOTED" ]]; then
  ok "newer failure beats older success when the API returns newest first"
else
  ko "API order let an older success outvote a newer failure (deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi

# The inverse remains promotable in either order: an older red CI run yields to a newer green rerun.
runs main "$C" failure success
add_run main "$C" .github/workflows/ci.yml success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$C" && "$PROMOTED" == "$C" ]]; then
  ok "newer success beats older failure"
else
  ko "a newer success did not outvote an older failure (deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" push -q origin "+${B}:refs/heads/deploy/main"
reverse_runs main "$C"
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$C" && "$PROMOTED" == "$C" ]]; then
  ok "newer success beats older failure when the API returns newest first"
else
  ko "API order let an older failure outvote a newer success (deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" push -q origin "+${B}:refs/heads/deploy/main"

# 9 — newest not green yet, an older one is: promote the older, never the untested newer.
D="$(commit d)"
git -C "$WORK" push -q origin main
runs main "$D" in_progress success
runs main "$C" success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$C" ]]; then
  ok "promotes the newest green commit, never a newer untested one"
else
  ko "deploy/main is not the newest green commit (deploy=$(remote_ref deploy/main), want $C)"
  echo "$OUT" >&2
fi

# 10 — deploy/main already at the tip's newest green: nothing to do, never backwards.
runs main "$D" success success
gate main
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$D" && -z "$PROMOTED" && "$OUT" == *"nothing to promote"* ]]; then
  ok "up to date: no push, no rewind"
else
  ko "second run pushed or rewound (deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi

# 11 — deploy/main diverged (hand push off main): refused, never forced.
git -C "$WORK" switch -q -c side "$C"
S="$(commit side)"
git -C "$WORK" switch -q main
git -C "$WORK" push -q origin "+${S}:refs/heads/deploy/main"
E="$(commit e)"
git -C "$WORK" push -q origin main
runs main "$E" success success
gate main
if [[ "$RC" -ne 0 && "$(remote_ref deploy/main)" == "$S" && "$OUT" == *"not an ancestor"* ]]; then
  ok "diverged deploy/main is refused, not forced"
else
  ko "diverged deploy/main was forced or silently kept (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" push -q origin "+${D}:refs/heads/deploy/main"

# 12.. — product mode is the declaration at the resolved deployed SHA, not the worktree.
restore_kit() {
  git -C "$WORK" checkout -q main
  git -C "$WORK" reset -q --hard "$D"
  git -C "$WORK" clean -q -fd
  pin_deploy "$D"
}
restore_kit
MISS="$(commit_product "inheritance only" -)"
pin_deploy "$MISS"
CAND="$(commit candidate-missing-config)"
git -C "$WORK" push -q origin main
runs main "$CAND" success success
gate main
if [[ "$RC" -ne 0 && "$OUT" == *"deploy-gate.json"* && "$(remote_ref deploy/main)" == "$MISS" ]]; then
  ok "product mode without config/product/deploy-gate.json is refused"
else
  ko "product mode without config was not refused (rc=$RC)"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$MISS"
BASE="$(commit_product "valid product ci" '{"workflows":[".github/workflows/product-ci.yml"]}')"
pin_deploy "$BASE"
RED="$(commit red-product)"
git -C "$WORK" push -q origin main
runs main "$RED" success success failure
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$BASE" && -z "$PROMOTED" ]]; then
  ok "product mode: a red product workflow blocks although kit CI is green"
else
  ko "red product CI was promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$BASE"
BAD="$(commit_product "bad path" '{"workflows":[".github/workflows/ci.yml"]}')"
pin_deploy "$BAD"
AHEAD="$(commit ahead-of-bad-config)"
git -C "$WORK" push -q origin main
runs main "$AHEAD" success success success
gate main
if [[ "$RC" -ne 0 && "$OUT" == *"product-*.yml"* && "$(remote_ref deploy/main)" == "$BAD" ]]; then
  ok "product config naming a non-product workflow is refused"
else
  ko "bad product config was accepted (rc=$RC)"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$BASE"
pin_deploy "$BASE"
NAME="$(commit wrong-name)"
git -C "$WORK" push -q origin main
runs main "$NAME" success success absent
add_run main "$NAME" .github/workflows/product-ci.yml success "Product E2E"
gate main
if [[ "$RC" -ne 0 && "$OUT" == *"Product CI"* && "$(remote_ref deploy/main)" == "$BASE" ]]; then
  ok "a declared product workflow not running as 'Product CI' is refused"
else
  ko "a product workflow the gate never hears about was accepted (rc=$RC)"
  echo "$OUT" >&2
fi
runs main "$NAME" success success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$NAME" ]]; then
  ok "product mode: all three green promotes"
else
  ko "green product SHA not promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$BASE"
rm -rf "${WORK}/config/product/deploy-gate.json"
mkdir -p "${WORK}/config/product/deploy-gate.json"
printf 'x\n' >"${WORK}/config/product/deploy-gate.json/nested"
git -C "$WORK" add -A -- config/product
git -C "$WORK" commit -q -m "gate path is a tree"
UNREAD="$(git -C "$WORK" rev-parse HEAD)"
pin_deploy "$UNREAD"
gate main
if [[ "$RC" -ne 0 && "$OUT" == *"REFUSED"*"deploy-gate.json is not readable"* && "$(remote_ref deploy/main)" == "$UNREAD" ]]; then
  ok "an unreadable deploy-gate.json is refused, not a crash"
else
  ko "unreadable deploy-gate.json was not refused cleanly (rc=$RC)"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$BASE"
FORGED="$(commit_product "forged entry" '{"workflows":["x\r\n::error::forged"]}')"
pin_deploy "$FORGED"
gate main
if [[ "$RC" -ne 0 && "$OUT" == *'REFUSED'* && "$OUT" != *$'\r'* && "$(remote_ref deploy/main)" == "$FORGED" ]] &&
  ! grep -Eq '^(::|##\[)' <<<"$OUT"; then
  ok "a line break in a refused declaration entry is escaped"
else
  ko "a declaration entry broke the refusal line (rc=$RC)"
  echo "$OUT" >&2
fi
restore_kit
mkdir -p "${WORK}/config/product"
printf '{"version":1}\n' >"${WORK}/config/product/inheritance.json"
printf '{"workflows":[".github/workflows/product-e2e.yml"]}\n' >"${WORK}/config/product/deploy-gate.json"
CLEAN="$(commit clean-kit)"
git -C "$WORK" push -q origin main
runs main "$CLEAN" success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$CLEAN" ]]; then
  ok "uncommitted worktree declaration is not the deployed baseline"
else
  ko "worktree declaration changed the baseline (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" clean -q -fd
restore_kit
BASE="$(commit_product "deployed product ci" '{"workflows":[".github/workflows/product-ci.yml"]}')"
pin_deploy "$BASE"
OLD="$(commit older-green)"
git -C "$WORK" push -q origin main
runs main "$OLD" success success success
printf '{"workflows":[".github/workflows/product-ci.yml",".github/workflows/product-e2e.yml"]}\n' >"${WORK}/config/product/deploy-gate.json"
mkdir -p "${WORK}/.github/workflows"
printf '%s\n' 'name: Product CI' 'on: [push]' 'jobs:' '  v:' '    runs-on: ubuntu-latest' '    steps:' '      - run: echo ok' >"${WORK}/.github/workflows/product-e2e.yml"
git -C "$WORK" add config/product/deploy-gate.json .github/workflows/product-e2e.yml
git -C "$WORK" commit -q -m "declare product-e2e"
NEW="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$NEW" success success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$OLD" && "$OUT" == *"product-e2e.yml=missing"* ]]; then
  ok "a newly declared workflow with no run excludes that candidate"
else
  ko "missing new workflow was ignored (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
add_run main "$NEW" .github/workflows/product-e2e.yml failure
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$OLD" && "$OUT" == *"product-e2e.yml=failure"* ]]; then
  ok "a newly declared red workflow excludes that candidate"
else
  ko "red new workflow was ignored (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
runs main "$NEW" success success success
add_run main "$NEW" .github/workflows/product-e2e.yml success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$NEW" ]]; then
  ok "a newly declared green workflow promotes that candidate"
else
  ko "green new workflow was not promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
printf '{"workflows":[".github/workflows/product-ci.yml"]}\n' >"${WORK}/config/product/deploy-gate.json"
git -C "$WORK" add config/product/deploy-gate.json
git -C "$WORK" commit -q -m "undeclare product-e2e"
DROP="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$DROP" success success success
add_run main "$DROP" .github/workflows/product-e2e.yml failure
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$NEW" && -z "$PROMOTED" ]]; then
  ok "undeclaring a workflow does not erase the deployed obligation"
else
  ko "undeclaration erased a deployed obligation (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
runs main "$DROP" success success success
add_run main "$DROP" .github/workflows/product-e2e.yml success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$DROP" ]]; then
  ok "undeclaring while the old push run is green can move the baseline"
else
  ko "valid retirement was blocked (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" rm -q .github/workflows/product-e2e.yml
git -C "$WORK" commit -q -m "delete retired workflow"
GONE="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$GONE" success success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$GONE" ]]; then
  ok "after retirement is promoted the old workflow can be deleted"
else
  ko "retired workflow stayed required (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
restore_kit
BASE="$(commit_product "baseline for bad tip" '{"workflows":[".github/workflows/product-ci.yml"]}')"
pin_deploy "$BASE"
OLDER="$(commit older-than-bad-tip)"
git -C "$WORK" push -q origin main
runs main "$OLDER" success success success
printf '%s\n' '{' >"${WORK}/config/product/deploy-gate.json"
git -C "$WORK" add config/product/deploy-gate.json
git -C "$WORK" commit -q -m "invalid tip"
TIP="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$TIP" success success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$OLDER" && "$OUT" == *"deploy-gate.json@${TIP:0:12}"* && "$OUT" != *"REFUSED"* ]]; then
  ok "an invalid tip declaration does not stall an older green candidate"
else
  ko "invalid tip stalled or was promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
git -C "$WORK" reset -q --hard "$BASE"
pin_deploy "$BASE"
OLDER2="$(commit older-than-bad-name)"
git -C "$WORK" push -q origin main
runs main "$OLDER2" success success success
printf '{"workflows":[".github/workflows/product-ci.yml",".github/workflows/product-e2e.yml"]}\n' >"${WORK}/config/product/deploy-gate.json"
git -C "$WORK" add config/product/deploy-gate.json
git -C "$WORK" commit -q -m "candidate-only wrong name"
BADN="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$BADN" success success success
add_run main "$BADN" .github/workflows/product-e2e.yml success "Product E2E"
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$OLDER2" && "$OUT" == *"runs as 'Product E2E'"* && "$OUT" != *"REFUSED"* ]]; then
  ok "a candidate-only wrong workflow name excludes that candidate and does not refuse"
else
  ko "candidate-only wrong name refused or promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
restore_kit
mkdir -p "${WORK}/config/product/deploy-gate.json"
printf 'x\n' >"${WORK}/config/product/deploy-gate.json/nested"
git -C "$WORK" add -A -- config/product
git -C "$WORK" commit -q -m "candidate gate path is a tree"
TREE="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$TREE" success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$D" && "$OUT" == *"git show ${TREE}:config/product/deploy-gate.json"* && "$OUT" == *"not green"* ]]; then
  ok "a git read error on a candidate is not treated as an absent declaration"
else
  ko "candidate git read error was absence or a refusal (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
# Append to the current tip. A reset behind origin/main is not a fast-forward.
rm -rf "${WORK}/config/product"
CMD_OLDER="$(commit_product "green before command payload" '{"workflows":[".github/workflows/product-ci.yml"]}')"
git -C "$WORK" push -q origin main
runs main "$CMD_OLDER" success success success
CMD_JSON="$(bun -e '
  const entry = [
    "x",
    "\r\n::set-output name=promote::aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "\n::set-output name=target::deploy/main",
    "\n##[set-output name=promote]bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "\n::error::forged",
    "\n::add-mask::secret-value",
    "\n::warning::warned",
    "\n::group::grouped",
  ].join("")
  process.stdout.write(JSON.stringify({ workflows: [entry] }))
')"
CMD_TIP="$(commit_product "declaration embeds workflow commands" "$CMD_JSON")"
git -C "$WORK" push -q origin main
runs main "$CMD_TIP" success success success
SPLIT_OUT="${TMP}/gate-stdout"
SPLIT_ERR="${TMP}/gate-stderr"
outfile="${TMP}/gh-output"
: >"$outfile"
RC=0
(
  cd "$WORK" && env PATH="${BIN}:${PATH}" PROMOTE_TEST_RUNS="$RUNS" \
    GITHUB_REPOSITORY=example/kit SOURCE_BRANCH=main GITHUB_OUTPUT="$outfile" \
    bun "$SCRIPT" >"$SPLIT_OUT" 2>"$SPLIT_ERR"
) || RC=$?
OUT="$(cat "$SPLIT_OUT" "$SPLIT_ERR")"
PROMOTED="$(sed -n 's/^promote=//p' "$outfile")"
target="$(sed -n 's/^target=//p' "$outfile")"
if [[ -n "$PROMOTED" ]]; then
  git -C "$WORK" push -q origin "${PROMOTED}:refs/heads/${target}"
fi
if [[ "$RC" -eq 0 && "$PROMOTED" == "$CMD_OLDER" && "$(remote_ref deploy/main)" == "$CMD_OLDER" ]] &&
  [[ "$OUT" == *"product-*.yml"* && "$OUT" == *"not green"* && "$OUT" != *"REFUSED"* && "$OUT" != *$'\r'* ]] &&
  ! grep -F -q -e '::set-output' -e '::error' -e '::add-mask' -e '::warning' -e '::group' \
    -e '##[set-output' -e '##[error' "$SPLIT_OUT" "$SPLIT_ERR" &&
  ! grep -Eq '^(::|##\[)' "$SPLIT_OUT" "$SPLIT_ERR"; then
  ok "embedded workflow commands stay inert and the older green candidate is selected"
else
  ko "embedded workflow command forged a command line or the selection (rc=$RC, promoted=$PROMOTED)"
  echo "$OUT" >&2
fi
NAME_OLDER="$(commit_product "green before command name" '{"workflows":[".github/workflows/product-ci.yml"]}')"
git -C "$WORK" push -q origin main
runs main "$NAME_OLDER" success success success
NAME_TIP="$(commit_product "run name embeds workflow commands" '{"workflows":[".github/workflows/product-ci.yml",".github/workflows/product-e2e.yml"]}')"
git -C "$WORK" push -q origin main
runs main "$NAME_TIP" success success success
add_run main "$NAME_TIP" .github/workflows/product-e2e.yml success "Product E2E"
bun -e '
  const p = process.argv[1]
  const d = JSON.parse(await Bun.file(p).text())
  const run = d.workflow_runs.find((item) => item.path.endsWith("product-e2e.yml"))
  run.name = [
    "Product E2E",
    "\n::set-output name=promote::cccccccccccccccccccccccccccccccccccccccc",
    "\n::add-mask::secret-value",
    "\n##[error]named",
  ].join("")
  await Bun.write(p, JSON.stringify(d))
' "${RUNS}/main/${NAME_TIP}.json"
: >"$outfile"
RC=0
(
  cd "$WORK" && env PATH="${BIN}:${PATH}" PROMOTE_TEST_RUNS="$RUNS" \
    GITHUB_REPOSITORY=example/kit SOURCE_BRANCH=main GITHUB_OUTPUT="$outfile" \
    bun "$SCRIPT" >"$SPLIT_OUT" 2>"$SPLIT_ERR"
) || RC=$?
OUT="$(cat "$SPLIT_OUT" "$SPLIT_ERR")"
PROMOTED="$(sed -n 's/^promote=//p' "$outfile")"
target="$(sed -n 's/^target=//p' "$outfile")"
if [[ -n "$PROMOTED" ]]; then
  git -C "$WORK" push -q origin "${PROMOTED}:refs/heads/${target}"
fi
if [[ "$RC" -eq 0 && "$PROMOTED" == "$NAME_OLDER" && "$(remote_ref deploy/main)" == "$NAME_OLDER" ]] &&
  [[ "$OUT" == *"runs as"* && "$OUT" != *"REFUSED"* ]] &&
  ! grep -F -q -e '::set-output' -e '::add-mask' -e '##[error' "$SPLIT_OUT" "$SPLIT_ERR" &&
  ! grep -Eq '^(::|##\[)' "$SPLIT_OUT" "$SPLIT_ERR"; then
  ok "a run name with workflow commands excludes that candidate and stays inert"
else
  ko "run-name workflow command forged a command line or the selection (rc=$RC, promoted=$PROMOTED)"
  echo "$OUT" >&2
fi
restore_kit
F="$D"


# 16 — an incomplete API answer (more runs than returned) fails closed.
G="$(commit g)"
git -C "$WORK" push -q origin main
runs main "$G" success success
sed -i.bak 's/"total_count":[0-9]*/"total_count":250/' "${RUNS}/main/${G}.json"
gate main
if [[ "$RC" -ne 0 && "$(remote_ref deploy/main)" == "$F" ]]; then
  ok "paginated run list fails closed"
else
  ko "incomplete run list was trusted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi

# 17 — staging promotes to deploy/staging from staging's own push runs.
git -C "$WORK" push -q origin "${F}:refs/heads/staging" "${F}:refs/heads/deploy/staging"
git -C "$WORK" switch -q -c staging "$F"
H="$(commit h)"
git -C "$WORK" push -q origin staging
runs main "$H" success success
gate staging
if [[ "$(remote_ref deploy/staging)" == "$F" && -z "$PROMOTED" ]]; then
  ok "staging ignores main-branch runs"
else
  ko "staging promoted on another branch's runs (deploy/staging=$(remote_ref deploy/staging))"
  echo "$OUT" >&2
fi
runs staging "$H" success success
gate staging
if [[ "$RC" -eq 0 && "$(remote_ref deploy/staging)" == "$H" && "$(remote_ref deploy/main)" == "$F" ]]; then
  ok "staging promotes to deploy/staging only"
else
  ko "staging did not promote to deploy/staging (deploy/staging=$(remote_ref deploy/staging))"
  echo "$OUT" >&2
fi

# 19 — a red secret scan anywhere in the range blocks, even when a later push is all green.
git -C "$WORK" switch -q main
runs main "$G" success success
P1="$(commit p1-with-key)"
git -C "$WORK" push -q origin main
runs main "$P1" success failure
P2="$(commit p2)"
git -C "$WORK" push -q origin main
runs main "$P2" success success
gate main
# The key-free commit before it (G) may still ship; P1 and anything after it may not.
if [[ "$(remote_ref deploy/main)" == "$G" && "$OUT" == *"range has"* ]]; then
  ok "a red secret scan earlier in the range blocks every later commit"
else
  ko "a range with a red secret scan was promoted (deploy=$(remote_ref deploy/main), want $G)"
  echo "$OUT" >&2
fi

# 20 — break-glass: deploy/main = hand-pushed hotfix off main. Once main merges it (merge commit),
# only commits that descend from the hotfix are candidates, never an older green one without it.
git -C "$WORK" switch -q -c hotfix "$P2"
printf 'hotfix\n' >"${WORK}/hotfix.txt"
git -C "$WORK" add hotfix.txt
git -C "$WORK" commit -q -m hotfix
HF="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin "+${HF}:refs/heads/deploy/main"
git -C "$WORK" switch -q main
P3="$(commit p3)"
runs main "$P3" success success
git -C "$WORK" merge -q --no-ff -m merge-hotfix hotfix
MH="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push -q origin main
runs main "$MH" failure success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$HF" && -z "$PROMOTED" ]]; then
  ok "after a break-glass merge, a green commit without the hotfix is not a candidate"
else
  ko "the gate picked a commit that does not descend from the hotfix (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi
runs main "$MH" success success
gate main
if [[ "$RC" -eq 0 && "$(remote_ref deploy/main)" == "$MH" ]]; then
  ok "the green merge of the hotfix promotes"
else
  ko "green hotfix merge not promoted (rc=$RC, deploy=$(remote_ref deploy/main))"
  echo "$OUT" >&2
fi

# --check (Roxabi/roxabi-boilerplate-cf#317): working-tree declaration, no gh, no API, no GITHUB_REPOSITORY.
CHECK_BIN="${TMP}/check-bin"
mkdir -p "$CHECK_BIN"
cat >"${CHECK_BIN}/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh stub: --check must not call gh: $*" >&2
exit 1
EOF
chmod +x "${CHECK_BIN}/gh"

check_tree() {
  local dir="$1"
  shift || true
  RC=0
  OUT="$(
    cd "$dir" && env -u GITHUB_REPOSITORY -u GH_TOKEN -u GITHUB_OUTPUT \
      PATH="${CHECK_BIN}:${PATH}" "$@" bun "$SCRIPT" --check 2>&1
  )" || RC=$?
}

expect_check_ok() {
  local name="$1" needle="$2"
  if [[ "$RC" -eq 0 && "$OUT" == *"$needle"* && "$OUT" != *"gh stub"* ]]; then
    ok "$name"
  else
    ko "$name (rc=$RC)"
    echo "$OUT" >&2
  fi
}

expect_check_fail() {
  local name="$1" needle="$2"
  if [[ "$RC" -ne 0 && "$OUT" == *"$needle"* && "$OUT" == *"check FAILED"* && "$OUT" != *"gh stub"* ]]; then
    ok "$name"
  else
    ko "$name (rc=$RC)"
    echo "$OUT" >&2
  fi
}

expect_refused() {
  local name="$1" needle="$2"
  if [[ "$RC" -ne 0 && "$OUT" == *"REFUSED"* && "$OUT" == *"$needle"* && "$OUT" != *"check OK"* && "$OUT" != *"gh stub"* ]]; then
    ok "$name"
  else
    ko "$name (rc=$RC)"
    echo "$OUT" >&2
  fi
}

# Semantic check stayed clean (no CHECK FAILED summary). actionlint rejected the file.
expect_syntax_fail() {
  local name="$1" needle="$2"
  if [[ "$RC" -ne 0 && "$OUT" == *"$needle"* && "$OUT" != *"check FAILED"* && "$OUT" != *"gh stub"* ]]; then
    ok "$name"
  else
    ko "$name (rc=$RC)"
    echo "$OUT" >&2
  fi
}

# Actionlint resolves a local callee only inside a git project. Seed the real kit
# workflows so a product finding stays the only semantic finding.
seed_kit() {
  local dir="$1"
  mkdir -p "${dir}/.github/workflows"
  cp "${ROOT}/.github/workflows/ci.yml" "${dir}/.github/workflows/ci.yml"
  cp "${ROOT}/.github/workflows/coverage-app.yml" "${dir}/.github/workflows/coverage-app.yml"
  cp "${ROOT}/.github/workflows/secret-scan.yml" "${dir}/.github/workflows/secret-scan.yml"
  if [[ ! -e "${dir}/.git" ]]; then
    git init -q "$dir"
  fi
}

plant_gate() {
  local dir="$1" json="${2:-}"
  mkdir -p "${dir}/config/product" "${dir}/.github/workflows"
  printf '{"version":1}\n' >"${dir}/config/product/inheritance.json"
  if [[ -z "$json" ]]; then
    json='{"workflows":[".github/workflows/product-ci.yml"]}'
  fi
  printf '%s\n' "$json" >"${dir}/config/product/deploy-gate.json"
  seed_kit "$dir"
}

# Every fixture also gets the local callee its `uses: ./.github/workflows/other.yml` jobs call.
write_wf() {
  local dir="$1"
  mkdir -p "${dir}/.github/workflows"
  printf '%s\n' 'on: workflow_call' 'jobs:' '  run:' '    runs-on: ubuntu-latest' \
    '    steps:' '      - run: echo callee' >"${dir}/.github/workflows/other.yml"
  cat >"${dir}/.github/workflows/product-ci.yml"
}

VALID_JOBS="$(printf '%s\n' \
  'jobs:' \
  '  product-validate:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - run: echo ok' \
  '      - if: always()' \
  '        run: echo step-if-ignored')"

wf_with() {
  local dir="$1"
  shift
  {
    printf '%s\n' "$@"
    printf '%s\n' "$VALID_JOBS"
  } | write_wf "$dir"
}

echo "== promote-deploy --check =="

KIT_DIR="${TMP}/check-kit"
mkdir -p "$KIT_DIR"
check_tree "$KIT_DIR"
if [[ "$RC" -ne 0 && "$OUT" == *".github/workflows/ci.yml: file missing"* && "$OUT" == *".github/workflows/secret-scan.yml: file missing"* && "$OUT" != *"gh stub"* ]]; then
  ok "kit mode without ci.yml and secret-scan.yml is refused"
else
  ko "kit mode missing kit workflows (rc=$RC)"
  echo "$OUT" >&2
fi

check_tree "$KIT_DIR" SOURCE_BRANCH=prod
if [[ "$RC" -ne 0 && "$OUT" == *"SOURCE_BRANCH must be main or staging, got 'prod'"* && "$OUT" != *"gh stub"* ]]; then
  ok "--check refuses a SOURCE_BRANCH promotion would refuse"
else
  ko "--check SOURCE_BRANCH (rc=$RC)"
  echo "$OUT" >&2
fi

KIT_OK="${TMP}/check-kit-ok"
mkdir -p "$KIT_OK"
seed_kit "$KIT_OK"
check_tree "$KIT_OK"
expect_check_ok "kit workflows pass without a product config" "check OK (0 product workflow(s), source branch main)"
if [[ "$RC" -eq 0 && "$OUT" != *"not 'Product CI'"* ]]; then
  ok "a kit workflow named CI is not subject to the Product CI name rule"
else
  ko "kit name rule (rc=$RC)"
  echo "$OUT" >&2
fi

KIT_PATHS="${TMP}/check-kit-paths"
mkdir -p "$KIT_PATHS"
seed_kit "$KIT_PATHS"
cat >"${KIT_PATHS}/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
    branches: [main, staging]
    paths-ignore: ['docs/**']
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$KIT_PATHS"
expect_check_fail "ci.yml push paths-ignore is refused" ".github/workflows/ci.yml: push has paths-ignore"

KIT_BRANCH="${TMP}/check-kit-branches"
mkdir -p "$KIT_BRANCH"
seed_kit "$KIT_BRANCH"
cat >"${KIT_BRANCH}/.github/workflows/secret-scan.yml" <<'EOF'
name: Secret scan
on:
  push:
    branches: ['release/**']
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$KIT_BRANCH"
expect_check_fail "secret-scan.yml branches that exclude main are refused" ".github/workflows/secret-scan.yml: push.branches does not admit 'main'"

EMPTY="${TMP}/check-empty"
plant_gate "$EMPTY" '{"workflows":[]}'
check_tree "$EMPTY"
expect_check_ok "product mode with an empty workflow list" "check OK (0 product workflow(s), source branch main)"

RETIRE="${TMP}/check-retire-undeclared"
plant_gate "$RETIRE" '{"workflows":[]}'
cat >"${RETIRE}/.github/workflows/product-ci.yml" <<'EOF'
name: Product CI
on:
  push:
    paths-ignore: ['**']
jobs:
  product-validate:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: echo old
EOF
check_tree "$RETIRE"
expect_check_ok "an undeclared product workflow stays admissible" "check OK (0 product workflow(s), source branch main)"

MISS_CFG="${TMP}/check-miss-cfg"
mkdir -p "${MISS_CFG}/config/product"
printf '{"version":1}\n' >"${MISS_CFG}/config/product/inheritance.json"
seed_kit "$MISS_CFG"
check_tree "$MISS_CFG"
expect_check_fail "--check product mode without deploy-gate.json" "product mode needs config/product/deploy-gate.json"

BAD_JSON="${TMP}/check-bad-json"
plant_gate "$BAD_JSON" '{'
check_tree "$BAD_JSON"
expect_check_fail "--check invalid deploy-gate.json" "is not valid JSON"
UNREADABLE="${TMP}/check-unreadable"
plant_gate "$UNREADABLE"
rm "${UNREADABLE}/config/product/deploy-gate.json"
mkdir "${UNREADABLE}/config/product/deploy-gate.json"
check_tree "$UNREADABLE"
expect_check_fail "--check unreadable deploy-gate.json (a directory)" "deploy-gate.json is not readable"

FORGED="${TMP}/check-forged"
plant_gate "$FORGED" '{"workflows":["x\r\n::error::forged"]}'
check_tree "$FORGED"
expect_check_fail "--check line break in an entry" 'x\r\n:\:error:\:forged'
if [[ "$OUT" != *$'\r'* ]] && ! grep -Eq '^(::|##\[)' <<<"$OUT"; then
  ok "--check escapes a line break in a finding"
else
  ko "--check let a finding start a new log line"
  echo "$OUT" >&2
fi

BAD_SHAPE="${TMP}/check-bad-shape"
plant_gate "$BAD_SHAPE" '{}'
check_tree "$BAD_SHAPE"
expect_check_fail "--check deploy-gate.json without workflows array" 'needs "workflows"'

BAD_PATHS="${TMP}/check-bad-paths"
plant_gate "$BAD_PATHS" '{"workflows":["nope",".github/workflows/ci.yml"]}'
check_tree "$BAD_PATHS"
expect_check_fail "--check collects every illegal workflow path" "nope"
if [[ "$OUT" == *".github/workflows/ci.yml"* && "$OUT" == *"product-*.yml"* ]]; then
  ok "--check names each illegal workflow path"
else
  ko "--check did not name both illegal paths"
  echo "$OUT" >&2
fi

OK_DIR="${TMP}/check-ok"
plant_gate "$OK_DIR"
wf_with "$OK_DIR" \
  'name: Product CI' \
  'on:' \
  '  push:' \
  '    branches: [main, staging]' \
  '  pull_request:'
check_tree "$OK_DIR"
expect_check_ok "valid product workflow (step-level if ignored)" "check OK (1 product workflow(s), source branch main)"

check_tree "$OK_DIR" SOURCE_BRANCH=staging
expect_check_ok "SOURCE_BRANCH=staging admits staging" "check OK (1 product workflow(s), source branch staging)"

ON_PUSH="${TMP}/check-on-push"
plant_gate "$ON_PUSH"
wf_with "$ON_PUSH" 'name: Product CI' 'on: push'
check_tree "$ON_PUSH"
expect_check_ok "on: push string admits every branch" "check OK (1 product workflow(s), source branch main)"

ON_LIST="${TMP}/check-on-list"
plant_gate "$ON_LIST"
wf_with "$ON_LIST" 'name: Product CI' 'on: [push]'
check_tree "$ON_LIST"
expect_check_ok "on: [push] list admits every branch" "check OK (1 product workflow(s), source branch main)"

ON_NULL="${TMP}/check-on-null"
plant_gate "$ON_NULL"
wf_with "$ON_NULL" 'name: Product CI' 'on:' '  push:'
check_tree "$ON_NULL"
expect_check_ok "push with no filters admits every branch" "check OK (1 product workflow(s), source branch main)"

ON_TRUE="${TMP}/check-on-true"
plant_gate "$ON_TRUE"
wf_with "$ON_TRUE" 'name: Product CI' 'true:' '  push:' '    branches: [main]'
check_tree "$ON_TRUE"
expect_syntax_fail "a literal true: key is not a workflow actionlint accepts" '"on" section is missing'
if [[ "$OUT" != *"no push trigger"* ]]; then
  ok "the semantic checker still sees a push under the YAML 1.1 true key"
else
  ko "semantic checker refused the YAML 1.1 true key"
  echo "$OUT" >&2
fi

USES_OK="${TMP}/check-uses-ok"
plant_gate "$USES_OK"
write_wf "$USES_OK" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: ./.github/workflows/other.yml
EOF
check_tree "$USES_OK"
expect_check_ok "reusable workflow job without if is allowed" "check OK (1 product workflow(s), source branch main)"

branch_case() {
  local dir="$1"
  shift
  plant_gate "$dir"
  {
    echo 'name: Product CI'
    echo 'on:'
    echo '  push:'
    echo '    branches:'
    local pattern
    for pattern in "$@"; do
      printf "      - '%s'\n" "$pattern"
    done
    printf '%s\n' "$VALID_JOBS"
  } | write_wf "$dir"
}

branch_case "${TMP}/check-q" 'ma?in'
check_tree "${TMP}/check-q"
expect_check_ok "ma?in admits main (? quantifies the preceding char)" "check OK (1 product workflow(s), source branch main)"

branch_case "${TMP}/check-plus" 'mai+n'
check_tree "${TMP}/check-plus"
expect_check_ok "mai+n admits main (+ quantifies the preceding char)" "check OK (1 product workflow(s), source branch main)"

branch_case "${TMP}/check-starstar" '**'
check_tree "${TMP}/check-starstar"
expect_check_ok "** admits main" "check OK (1 product workflow(s), source branch main)"

branch_case "${TMP}/check-class" 'mai[a-z]'
check_tree "${TMP}/check-class"
expect_check_ok "[a-z] admits main" "check OK (1 product workflow(s), source branch main)"

branch_case "${TMP}/check-reinclude" '!main' 'main'
check_tree "${TMP}/check-reinclude"
expect_check_ok "a later positive pattern re-includes main" "check OK (1 product workflow(s), source branch main)"

MISSING="${TMP}/check-missing"
plant_gate "$MISSING"
check_tree "$MISSING"
expect_check_fail "missing workflow file" "file missing"

PARSE="${TMP}/check-parse"
plant_gate "$PARSE"
printf 'name: Product CI\non: [push\n' >"${PARSE}/.github/workflows/product-ci.yml"
check_tree "$PARSE"
expect_check_fail "unparseable workflow YAML" "not parseable YAML"

NAME="${TMP}/check-name"
plant_gate "$NAME"
wf_with "$NAME" 'name: Product E2E' 'on: push'
check_tree "$NAME"
expect_check_fail "workflow name is not Product CI" "name is 'Product E2E', not 'Product CI'"

NOPUSH="${TMP}/check-nopush"
plant_gate "$NOPUSH"
wf_with "$NOPUSH" 'name: Product CI' 'on: workflow_dispatch'
check_tree "$NOPUSH"
expect_check_fail "no push trigger" "no push trigger"

PATHS="${TMP}/check-paths"
plant_gate "$PATHS"
wf_with "$PATHS" 'name: Product CI' 'on:' '  push:' '    branches: [main]' "    paths: ['apps/**']"
check_tree "$PATHS"
expect_check_fail "push paths filter" "push has paths"

PIGNORE="${TMP}/check-pignore"
plant_gate "$PIGNORE"
wf_with "$PIGNORE" 'name: Product CI' 'on:' '  push:' '    branches: [main]' "    paths-ignore: ['docs/**']"
check_tree "$PIGNORE"
expect_check_fail "push paths-ignore filter" "push has paths-ignore"

BIGNORE="${TMP}/check-bignore"
plant_gate "$BIGNORE"
wf_with "$BIGNORE" 'name: Product CI' 'on:' '  push:' '    branches: [main]' "    branches-ignore: ['wip']"
check_tree "$BIGNORE"
expect_check_fail "push branches-ignore filter" "push has branches-ignore"

NOADMIT="${TMP}/check-noadmit"
branch_case "$NOADMIT" 'release/**'
check_tree "$NOADMIT"
expect_check_fail "push.branches does not admit the source branch" "push.branches does not admit 'main'"

ONLY_NEG="${TMP}/check-only-neg"
branch_case "$ONLY_NEG" '!release/**'
check_tree "$ONLY_NEG"
expect_check_fail "only-negative branch list admits nothing" "push.branches does not admit 'main'"

EXCLUDE="${TMP}/check-exclude"
branch_case "$EXCLUDE" '**' '!main'
check_tree "$EXCLUDE"
expect_check_fail "a later !main excludes the source branch" "push.branches does not admit 'main'"

STAGING="${TMP}/check-staging"
branch_case "$STAGING" 'main'
check_tree "$STAGING" SOURCE_BRANCH=staging
expect_check_fail "SOURCE_BRANCH=staging is not admitted by branches: [main]" "push.branches does not admit 'staging'"

TAGS="${TMP}/check-tags"
plant_gate "$TAGS"
wf_with "$TAGS" 'name: Product CI' 'on:' '  push:' "    tags: ['v*']"
check_tree "$TAGS"
expect_check_fail "tags-only push never runs on a branch" "push has tags but no branches"

TIGNORE="${TMP}/check-tignore"
plant_gate "$TIGNORE"
wf_with "$TIGNORE" 'name: Product CI' 'on:' '  push:' "    tags-ignore: ['v*']"
check_tree "$TIGNORE"
expect_check_fail "tags-ignore without branches never runs on a branch" "push has tags-ignore but no branches"

ZERO="${TMP}/check-zero"
plant_gate "$ZERO"
write_wf "$ZERO" <<'EOF'
name: Product CI
on: push
jobs: {}
EOF
check_tree "$ZERO"
expect_check_fail "zero jobs" "zero jobs"

JOBNULL="${TMP}/check-job-null"
plant_gate "$JOBNULL"
write_wf "$JOBNULL" <<'EOF'
name: Product CI
on: push
jobs:
  a:
EOF
check_tree "$JOBNULL"
expect_check_fail "a job that is not a mapping" "job 'a' is not a mapping"

PUSHLIST="${TMP}/check-push-list"
plant_gate "$PUSHLIST"
wf_with "$PUSHLIST" 'name: Product CI' 'on:' '  push: [main]'
check_tree "$PUSHLIST"
expect_check_fail "a push value that is not a mapping" 'push is ["main"], not a mapping of filters'

BANGNULL="${TMP}/check-bang-null"
plant_gate "$BANGNULL"
wf_with "$BANGNULL" 'name: Product CI' 'on:' '  push:' '    branches:' "      - '**'" '      - !main'
check_tree "$BANGNULL"
expect_check_fail "an unquoted !main entry (YAML null) is refused, not dropped" \
  'push.branches is not a string or a list of strings'

NEEDS="${TMP}/check-needs"
plant_gate "$NEEDS"
write_wf "$NEEDS" <<'EOF'
name: Product CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    needs: [lint]
    steps:
      - run: echo ok
EOF
check_tree "$NEEDS"
expect_check_fail "needs naming no job" "job 'build' needs 'lint', which is not a job in this workflow"

CALLEE="${TMP}/check-callee-missing"
plant_gate "$CALLEE"
write_wf "$CALLEE" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: ./.github/workflows/missing.yml
EOF
check_tree "$CALLEE"
expect_check_fail "a local callee that does not exist" \
  "job 'call' calls ./.github/workflows/missing.yml, which is not a workflow file under .github/workflows/"

# A local callee runs its jobs in the caller's push: the same job rules judge them (Roxabi/roxabi-boilerplate-cf#317).
callee_case() {
  local dir="$1"
  plant_gate "$dir"
  printf '%s\n' 'name: Product CI' 'on: push' 'jobs:' '  call:' '    uses: ./.github/workflows/other.yml' |
    write_wf "$dir"
  cat >"${dir}/.github/workflows/other.yml"
}
CALLEE_IF="${TMP}/check-callee-if"
callee_case "$CALLEE_IF" <<'EOF'
on: workflow_call
jobs:
  test:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: echo skipped-on-push
EOF
check_tree "$CALLEE_IF"
expect_check_fail "a callee job-level if is judged like the caller's" \
  "job 'call' calls ./.github/workflows/other.yml: job 'test' has a job-level if the check cannot prove true on push"
CALLEE_PUSH_IF="${TMP}/check-callee-push-if"
callee_case "$CALLEE_PUSH_IF" <<'EOF'
on: workflow_call
jobs:
  test:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$CALLEE_PUSH_IF"
expect_check_ok "a callee job if proven true on push passes" "check OK (1 product workflow(s), source branch main)"
CALLEE_NEEDS="${TMP}/check-callee-needs"
callee_case "$CALLEE_NEEDS" <<'EOF'
on: workflow_call
jobs:
  test:
    needs: [lint]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$CALLEE_NEEDS"
expect_check_fail "a callee needs is checked against the callee's jobs" \
  "job 'call' calls ./.github/workflows/other.yml: job 'test' needs 'lint', which is not a job in this workflow"
CALLEE_NESTED="${TMP}/check-callee-nested"
callee_case "$CALLEE_NESTED" <<'EOF'
on: workflow_call
jobs:
  inner:
    uses: ./.github/workflows/deeper.yml
EOF
printf '%s\n' 'on: workflow_call' 'jobs:' '  deep:' "    if: github.ref == 'refs/heads/main'" \
  '    runs-on: ubuntu-latest' '    steps:' '      - run: echo deep' >"${CALLEE_NESTED}/.github/workflows/deeper.yml"
check_tree "$CALLEE_NESTED"
expect_check_fail "a nested local callee is judged too" \
  "job 'call' calls ./.github/workflows/other.yml: job 'inner' calls ./.github/workflows/deeper.yml: job 'deep' has a job-level if the check cannot prove true on push"
CALLEE_CYCLE="${TMP}/check-callee-cycle"
callee_case "$CALLEE_CYCLE" <<'EOF'
on: workflow_call
jobs:
  back:
    uses: ./.github/workflows/product-ci.yml
EOF
check_tree "$CALLEE_CYCLE"
expect_check_fail "a callee calling back into its chain is a finding, not a loop" \
  "job 'call' calls ./.github/workflows/other.yml: job 'back' calls ./.github/workflows/product-ci.yml, which is already in its call chain"
CALLEE_REMOTE="${TMP}/check-callee-remote"
plant_gate "$CALLEE_REMOTE"
write_wf "$CALLEE_REMOTE" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: acme/shared/.github/workflows/ci.yml@v1
EOF
check_tree "$CALLEE_REMOTE"
expect_check_fail "a remote reusable workflow is a shape the check cannot model" \
  "job 'call' calls acme/shared/.github/workflows/ci.yml@v1, a remote workflow the check cannot open"

JOBIF="${TMP}/check-jobif"
plant_gate "$JOBIF"
write_wf "$JOBIF" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    if: github.ref == 'refs/heads/main'
    uses: ./.github/workflows/other.yml
EOF
check_tree "$JOBIF"
expect_check_fail "job-level if on a reusable workflow job" "job 'call' has a job-level if the check cannot prove true on push"

BOTH="${TMP}/check-both"
plant_gate "$BOTH"
write_wf "$BOTH" <<'EOF'
name: Product CI
on:
  push:
    paths: ['apps/**']
jobs:
  call:
    if: false
    uses: ./.github/workflows/other.yml
EOF
check_tree "$BOTH"
expect_check_fail "collects every workflow finding" "push has paths"
if [[ "$OUT" == *"job 'call' has a job-level if the check cannot prove true on push"* ]]; then
  ok "--check prints the job-level if next to paths"
else
  ko "--check dropped the job-level if finding"
  echo "$OUT" >&2
fi

IF_REFUSED="job 'call' has a job-level if the check cannot prove true on push"

plant_if() {
  local dir="$1" expr="$2"
  plant_gate "$dir"
  {
    echo 'name: Product CI'
    echo 'on: push'
    echo 'jobs:'
    echo '  call:'
    printf '    if: "%s"\n' "$expr"
    echo '    uses: ./.github/workflows/other.yml'
  } | write_wf "$dir"
}

plant_if "${TMP}/check-if-always-push" "always() && (github.event_name != 'pull_request' || !github.event.pull_request.draft)"
check_tree "${TMP}/check-if-always-push"
if [[ "$RC" -eq 0 ]]; then
  ok "always with push-safe draft guard cannot skip a push"
else
  ko "always with push-safe draft guard cannot skip a push (rc=$RC)"
  echo "$OUT" >&2
fi

plant_if "${TMP}/check-if-always-unknown" "always() && success()"
check_tree "${TMP}/check-if-always-unknown"
expect_check_fail "always cannot prove another status function true" "$IF_REFUSED"

TEMPLATE_IF="github.event_name != 'pull_request' || github.event.pull_request.draft == false"
plant_if "${TMP}/check-if-template" "$TEMPLATE_IF"
check_tree "${TMP}/check-if-template"
expect_check_ok "template job if cannot skip a push" "check OK (1 product workflow(s), source branch main)"

plant_if "${TMP}/check-if-wrap" "\${{ ${TEMPLATE_IF} }}"
check_tree "${TMP}/check-if-wrap"
expect_check_ok "template job if inside \${{ }} cannot skip a push" "check OK (1 product workflow(s), source branch main)"

plant_if "${TMP}/check-if-paren" "(github.event_name != 'pull_request') || x"
check_tree "${TMP}/check-if-paren"
expect_syntax_fail "an invalid || operand is rejected by actionlint" 'undefined variable "x"'
if [[ "$OUT" != *"$IF_REFUSED"* ]]; then
  ok "the semantic push guard still accepts the parenthesized operand"
else
  ko "semantic guard refused a parenthesized push operand"
  echo "$OUT" >&2
fi

plant_if "${TMP}/check-if-paren-ok" "(github.event_name != 'pull_request') || github.ref == 'refs/heads/main'"
check_tree "${TMP}/check-if-paren-ok"
expect_check_ok "a valid || operand beside a push-safe operand passes" "check OK (1 product workflow(s), source branch main)"

plant_if "${TMP}/check-if-both-paren-ok" "(github.event_name != 'pull_request') || (github.ref == 'refs/heads/main')"
check_tree "${TMP}/check-if-both-paren-ok"
if [[ "$RC" -eq 0 ]]; then
  ok "separately grouped OR operands retain the push-safe condition"
else
  ko "separately grouped OR operands retain the push-safe condition (rc=$RC)"
  echo "$OUT" >&2
fi

plant_if "${TMP}/check-if-swap" "'push' == github.event_name || x"
check_tree "${TMP}/check-if-swap"
expect_syntax_fail "a swapped push operand does not excuse an invalid || operand" 'undefined variable "x"'

plant_if "${TMP}/check-if-swap-ok" "'push' == github.event_name || github.event_name == 'push'"
check_tree "${TMP}/check-if-swap-ok"
expect_check_ok "a swapped push operand with a valid twin passes" "check OK (1 product workflow(s), source branch main)"

plant_if "${TMP}/check-if-and" "github.event_name != 'pull_request' && x"
check_tree "${TMP}/check-if-and"
expect_check_fail "an unproved && operand is refused" "$IF_REFUSED"

plant_if "${TMP}/check-if-eq-pr" "github.event_name == 'pull_request' || x"
check_tree "${TMP}/check-if-eq-pr"
expect_check_fail "!= pull_request is not the same as ==" "$IF_REFUSED"

plant_if "${TMP}/check-if-bang" "!cancelled()"
check_tree "${TMP}/check-if-bang"
expect_check_fail "an unmodeled status function is refused" "$IF_REFUSED"

plant_if "${TMP}/check-if-in-string" "github.event_name != 'pull_request || x'"
check_tree "${TMP}/check-if-in-string"
expect_check_fail "|| inside a string is not a split" "$IF_REFUSED"

plant_if "${TMP}/check-if-unbalanced" "(github.event_name != 'pull_request' || x"
check_tree "${TMP}/check-if-unbalanced"
expect_check_fail "unbalanced parentheses are not proved" "$IF_REFUSED"

TPL="${TMP}/check-template"
plant_gate "$TPL"
cp "${ROOT}/docs/kit/templates/product-ci.example.yml" "${TPL}/.github/workflows/product-ci.yml"
check_tree "$TPL"
expect_check_ok "copied product-ci.example.yml passes --check" "check OK (1 product workflow(s), source branch main)"

NO_CALL="${TMP}/check-callee-no-workflow-call"
mkdir -p "${NO_CALL}/config/product" "${NO_CALL}/.github/workflows"
printf '{"version":1}\n' >"${NO_CALL}/config/product/inheritance.json"
printf '%s\n' '{"workflows":[".github/workflows/product-ci.yml"]}' >"${NO_CALL}/config/product/deploy-gate.json"
cp "${ROOT}/.github/workflows/ci.yml" "${NO_CALL}/.github/workflows/ci.yml"
cp "${ROOT}/.github/workflows/coverage-app.yml" "${NO_CALL}/.github/workflows/coverage-app.yml"
cp "${ROOT}/.github/workflows/secret-scan.yml" "${NO_CALL}/.github/workflows/secret-scan.yml"
cat >"${NO_CALL}/.github/workflows/product-ci.yml" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: ./.github/workflows/other.yml
EOF
cat >"${NO_CALL}/.github/workflows/other.yml" <<'EOF'
on: push
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo callee
EOF
check_tree "$NO_CALL"
expect_check_fail "a callee without workflow_call is refused without a git project" "whose on has no workflow_call"
if [[ ! -e "${NO_CALL}/.git" ]]; then
  ok "that refusal did not depend on a git project"
else
  ko "callee fixture unexpectedly became a git project"
fi

CALL_OK="${TMP}/check-callee-workflow-call"
plant_gate "$CALL_OK"
write_wf "$CALL_OK" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: ./.github/workflows/other.yml
EOF
check_tree "$CALL_OK"
expect_check_ok "a callee with workflow_call passes" "check OK (1 product workflow(s), source branch main)"

BYPASS="${TMP}/check-actionlint-ignore"
plant_if "$BYPASS" "(github.event_name != 'pull_request') || x"
cat >"${BYPASS}/.github/actionlint.yaml" <<'EOF'
paths:
  "**/*.yml":
    ignore:
      - 'undefined variable'
EOF
check_tree "$BYPASS"
expect_syntax_fail "a product actionlint.yaml cannot ignore an invalid expression" 'undefined variable "x"'

INERT="${TMP}/check-actionlint-inert"
plant_gate "$INERT"
write_wf "$INERT" <<'EOF'
name: Product CI
on: push
"##[warning] forged": true
"##[stop-commands] forged": true
jobs:
  product-validate:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$INERT"
if [[ "$RC" -ne 0 && "$OUT" == *"unexpected key"* && "$OUT" != *'##[warning]'* && "$OUT" != *'##[stop-commands]'* && "$OUT" != *"check FAILED"* && "$OUT" != *"gh stub"* ]]; then
  ok "actionlint output renders workflow-command payloads inert"
else
  ko "actionlint command-inert (rc=$RC)"
  echo "$OUT" >&2
fi

COE_JOB="${TMP}/check-coe-job"
plant_gate "$COE_JOB"
write_wf "$COE_JOB" <<'EOF'
name: Product CI
on: push
jobs:
  product-validate:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$COE_JOB"
expect_check_fail "job continue-on-error true is refused" "job 'product-validate' continue-on-error is not false"

COE_STEP="${TMP}/check-coe-step"
plant_gate "$COE_STEP"
write_wf "$COE_STEP" <<'EOF'
name: Product CI
on: push
jobs:
  product-validate:
    runs-on: ubuntu-latest
    steps:
      - continue-on-error: true
        run: echo ok
EOF
check_tree "$COE_STEP"
expect_check_fail "step continue-on-error true is refused" "job 'product-validate' step 1 continue-on-error is not false"

COE_EXPR="${TMP}/check-coe-expr"
plant_gate "$COE_EXPR"
write_wf "$COE_EXPR" <<'EOF'
name: Product CI
on: push
jobs:
  product-validate:
    continue-on-error: ${{ matrix.x }}
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
EOF
check_tree "$COE_EXPR"
expect_check_fail "job continue-on-error expression is refused" "job 'product-validate' continue-on-error is not false"

COE_CALLEE="${TMP}/check-coe-callee"
plant_gate "$COE_CALLEE"
write_wf "$COE_CALLEE" <<'EOF'
name: Product CI
on: push
jobs:
  call:
    uses: ./.github/workflows/other.yml
EOF
cat >"${COE_CALLEE}/.github/workflows/other.yml" <<'EOF'
on: workflow_call
jobs:
  run:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - continue-on-error: ${{ github.ref }}
        run: echo callee
EOF
check_tree "$COE_CALLEE"
if [[ "$RC" -ne 0 && "$OUT" == *"job 'call' calls ./.github/workflows/other.yml: job 'run' continue-on-error is not false"* && "$OUT" == *"step 1 continue-on-error is not false"* && "$OUT" != *"gh stub"* ]]; then
  ok "callee job and step continue-on-error are refused"
else
  ko "callee continue-on-error (rc=$RC)"
  echo "$OUT" >&2
fi

COE_FALSE="${TMP}/check-coe-false"
plant_gate "$COE_FALSE"
write_wf "$COE_FALSE" <<'EOF'
name: Product CI
on: push
jobs:
  product-validate:
    continue-on-error: false
    runs-on: ubuntu-latest
    steps:
      - continue-on-error: false
        run: echo ok
      - if: always()
        run: echo step-if-ignored
EOF
check_tree "$COE_FALSE"
expect_check_ok "continue-on-error false and a step if pass" "check OK (1 product workflow(s), source branch main)"

COE_ABSENT="${TMP}/check-coe-absent"
plant_gate "$COE_ABSENT"
wf_with "$COE_ABSENT" 'name: Product CI' 'on: push'
check_tree "$COE_ABSENT"
expect_check_ok "absent continue-on-error passes" "check OK (1 product workflow(s), source branch main)"
# Retirement (Roxabi/roxabi-boilerplate-cf#331): the local deploy ref's declaration is judged in the
# candidate working tree. No fetch, no gh. ENOENT on .git or a missing ref is bootstrap; a present
# marker that git cannot read is a refusal.
git_identity() {
  local dir="$1"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email kit@example.com
  git -C "$dir" config user.name kit
  git -C "$dir" config commit.gpgsign false
}

commit_tree() {
  local dir="$1" msg="$2"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "$msg"
}

pin_deploy() {
  local dir="$1" source="${2:-main}"
  git_identity "$dir"
  commit_tree "$dir" baseline
  git -C "$dir" update-ref "refs/remotes/origin/deploy/${source}" HEAD
}

plant_valid() {
  local dir="$1"
  plant_gate "$dir"
  wf_with "$dir" 'name: Product CI' 'on: push'
}

undeclare() {
  printf '%s\n' '{"workflows":[]}' >"$1/config/product/deploy-gate.json"
}

write_product() {
  local dir="$1" file="$2"
  mkdir -p "${dir}/.github/workflows"
  {
    echo 'name: Product CI'
    echo 'on: push'
    printf '%s\n' "$VALID_JOBS"
  } >"${dir}/.github/workflows/${file}"
}

KEEP="${TMP}/check-retain-keep"
plant_valid "$KEEP"
pin_deploy "$KEEP"
check_tree "$KEEP"
expect_check_ok "a deploy ref that still declares the working-tree workflow passes" "check OK (1 product workflow(s), source branch main)"

ONCE="${TMP}/check-retain-once"
plant_valid "$ONCE"
pin_deploy "$ONCE"
rm -f "${ONCE}/.github/workflows/product-ci.yml"
check_tree "$ONCE"
expect_check_fail "a path declared and still required is not reported twice" "file missing"
once_hits="$(grep -c 'file missing' <<<"$OUT" || true)"
if [[ "$once_hits" == 1 ]]; then
  ok "file missing is printed once"
else
  ko "file missing printed ${once_hits} times"
  echo "$OUT" >&2
fi

NOREF="${TMP}/check-retain-noref"
plant_valid "$NOREF"
git_identity "$NOREF"
commit_tree "$NOREF" baseline
undeclare "$NOREF"
rm -f "${NOREF}/.github/workflows/product-ci.yml"
check_tree "$NOREF"
expect_check_ok "a git repo with no deploy ref stays bootstrap" "check OK (0 product workflow(s), source branch main)"

KEPT="${TMP}/check-retain-undeclared"
plant_valid "$KEPT"
pin_deploy "$KEPT"
undeclare "$KEPT"
check_tree "$KEPT"
expect_check_ok "undeclaring a still-runnable deployed workflow passes" "check OK (0 product workflow(s), source branch main)"

GONE="${TMP}/check-retain-deleted"
plant_valid "$GONE"
pin_deploy "$GONE"
undeclare "$GONE"
rm -f "${GONE}/.github/workflows/product-ci.yml"
check_tree "$GONE"
expect_check_fail "deleting a deployed workflow before promotion fails" "file missing"

BROKEN="${TMP}/check-retain-trigger"
plant_valid "$BROKEN"
pin_deploy "$BROKEN"
undeclare "$BROKEN"
wf_with "$BROKEN" 'name: Product CI' 'on: workflow_dispatch'
check_tree "$BROKEN"
expect_check_fail "a retained file with no push trigger fails" "no push trigger"

PATHS_RET="${TMP}/check-retain-paths"
plant_valid "$PATHS_RET"
pin_deploy "$PATHS_RET"
undeclare "$PATHS_RET"
wf_with "$PATHS_RET" 'name: Product CI' 'on:' '  push:' '    branches: [main]' "    paths: ['apps/**']"
check_tree "$PATHS_RET"
expect_check_fail "a retained file with a paths filter fails" "push has paths"

RENAME="${TMP}/check-retain-rename"
plant_valid "$RENAME"
pin_deploy "$RENAME"
write_product "$RENAME" product-ci-next.yml
printf '%s\n' '{"workflows":[".github/workflows/product-ci-next.yml"]}' >"${RENAME}/config/product/deploy-gate.json"
check_tree "$RENAME"
expect_check_ok "rename keeps the old file runnable and declares the new one" "check OK (1 product workflow(s), source branch main)"

RENAME_GONE="${TMP}/check-retain-rename-gone"
plant_valid "$RENAME_GONE"
pin_deploy "$RENAME_GONE"
write_product "$RENAME_GONE" product-ci-next.yml
printf '%s\n' '{"workflows":[".github/workflows/product-ci-next.yml"]}' >"${RENAME_GONE}/config/product/deploy-gate.json"
rm -f "${RENAME_GONE}/.github/workflows/product-ci.yml"
check_tree "$RENAME_GONE"
expect_check_fail "rename that drops the deployed file still refuses the old path" ".github/workflows/product-ci.yml"

RETIRED="${TMP}/check-retain-retired"
plant_valid "$RETIRED"
pin_deploy "$RETIRED"
undeclare "$RETIRED"
rm -f "${RETIRED}/.github/workflows/product-ci.yml"
commit_tree "$RETIRED" retire
git -C "$RETIRED" update-ref refs/remotes/origin/deploy/main HEAD
check_tree "$RETIRED"
expect_check_ok "after the deploy ref retires the workflow the file can be deleted" "check OK (0 product workflow(s), source branch main)"

BAD_DEPLOY="${TMP}/check-retain-bad-json"
plant_gate "$BAD_DEPLOY" '{'
pin_deploy "$BAD_DEPLOY"
printf '%s\n' '{"workflows":[]}' >"${BAD_DEPLOY}/config/product/deploy-gate.json"
check_tree "$BAD_DEPLOY"
expect_check_fail "a malformed deployed declaration fails closed" "is not valid JSON"

MISS_DECL="${TMP}/check-retain-missing-decl"
mkdir -p "${MISS_DECL}/config/product"
printf '%s\n' '{"version":1}' >"${MISS_DECL}/config/product/inheritance.json"
pin_deploy "$MISS_DECL"
printf '%s\n' '{"workflows":[]}' >"${MISS_DECL}/config/product/deploy-gate.json"
check_tree "$MISS_DECL"
expect_check_fail "a missing deployed declaration in product mode fails closed" "product mode needs config/product/deploy-gate.json"

STALE_OBJ="${TMP}/check-retain-bad-object"
plant_valid "$STALE_OBJ"
pin_deploy "$STALE_OBJ"
stale_sha="$(git -C "$STALE_OBJ" rev-parse HEAD)"
rm -f "${STALE_OBJ}/.git/objects/${stale_sha:0:2}/${stale_sha:2}"
check_tree "$STALE_OBJ"
expect_refused "a deploy ref whose object is missing is refused" "not a tree object"

STAGE_ONLY="${TMP}/check-retain-staging-ref"
plant_valid "$STAGE_ONLY"
pin_deploy "$STAGE_ONLY" main
undeclare "$STAGE_ONLY"
rm -f "${STAGE_ONLY}/.github/workflows/product-ci.yml"
check_tree "$STAGE_ONLY" SOURCE_BRANCH=staging
expect_check_ok "staging with no deploy/staging ref stays bootstrap" "check OK (0 product workflow(s), source branch staging)"

DROP_MODE="${TMP}/check-retain-drop-mode"
plant_valid "$DROP_MODE"
pin_deploy "$DROP_MODE"
rm -f "${DROP_MODE}/config/product/inheritance.json" "${DROP_MODE}/config/product/deploy-gate.json"
check_tree "$DROP_MODE"
expect_check_ok "dropping product mode keeps a deployed workflow that is still runnable" "check OK (0 product workflow(s), source branch main)"

DROP_GONE="${TMP}/check-retain-drop-gone"
plant_valid "$DROP_GONE"
pin_deploy "$DROP_GONE"
rm -f "${DROP_GONE}/config/product/inheritance.json" "${DROP_GONE}/config/product/deploy-gate.json" \
  "${DROP_GONE}/.github/workflows/product-ci.yml"
check_tree "$DROP_GONE"
expect_check_fail "dropping product mode does not allow deleting a deployed workflow" "file missing"

KIT_GIT="${TMP}/check-retain-kit-git"
mkdir -p "$KIT_GIT"
seed_kit "$KIT_GIT"
printf '%s\n' x >"${KIT_GIT}/f.txt"
pin_deploy "$KIT_GIT"
check_tree "$KIT_GIT"
expect_check_ok "a kit repo with a deploy ref and no product marker passes" "check OK (0 product workflow(s), source branch main)"

CORRUPT="${TMP}/check-retain-corrupt-git"
mkdir -p "${CORRUPT}/.git"
plant_valid "$CORRUPT"
check_tree "$CORRUPT"
expect_refused "a present .git that is not a repository is refused" "not a git repository"

# A valid product tree whose deploy-ref probe is SIGTERM'd must refuse. If the adapter treats a
# null status as a missing ref, this same tree is bootstrap and prints check OK — so the case fails.
# The shim is on PATH for this invocation only. No signal name or error text is pinned.
REAL_GIT="$(command -v git)"
SIG_BIN="${TMP}/sig-git-bin"
mkdir -p "$SIG_BIN"
cat >"${SIG_BIN}/git" <<'EOF'
#!/usr/bin/env bash
last="${@: -1}"
if [[ " $* " == *" rev-parse "* && " $* " == *" --verify "* && " $* " == *" --quiet "* && "$last" == "refs/remotes/origin/deploy/main" ]]; then
  kill -TERM $$
  exit 143
fi
exec "${REAL_GIT_BIN:?}" "$@"
EOF
chmod +x "${SIG_BIN}/git"
SIG_TREE="${TMP}/check-retain-signal"
plant_valid "$SIG_TREE"
pin_deploy "$SIG_TREE"
check_tree "$SIG_TREE" PATH="${SIG_BIN}:${CHECK_BIN}:${PATH}" REAL_GIT_BIN="$REAL_GIT"
if [[ "$RC" -ne 0 && "$OUT" != *"check OK"* && "$OUT" != *"gh stub"* ]]; then
  ok "a signalled deploy-ref probe refuses a still-valid product tree"
else
  ko "signalled deploy-ref probe (rc=$RC)"
  echo "$OUT" >&2
fi

echo "promote-deploy self-test: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
