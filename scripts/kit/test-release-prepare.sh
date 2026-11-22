#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
# shellcheck source=lib/hermetic-git.sh
source "$ROOT/scripts/kit/lib/hermetic-git.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
export PATH="$tmp/bin:$PATH"
export GITHUB_REPOSITORY=fixture/kit GH_TOKEN=read-token RELEASE_BOT_USER_ID=42
export GIT_AUTHOR_NAME=Maintainer GIT_AUTHOR_EMAIL=maintainer@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_ALLOW_PROTOCOL=file
unset GITHUB_OUTPUT RELEASE_WRITE_TOKEN
script="$ROOT/scripts/kit/release-prepare.ts"

# Fake only the GitHub boundary. Git reads, generated trees, and leased updates
# are exercised against a real, local bare remote. No network protocol is enabled.
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == api ]] || exit 90
shift
method=GET
path=''
query=''
while (( $# )); do
  case $1 in
    --method) method=$2; shift 2 ;;
    --input) [[ $2 == - ]]; shift 2 ;;
    --jq) query=$2; shift 2 ;;
    --paginate|--slurp) shift ;;
    *) [[ -z $path ]]; path=${1#repos/fixture/kit/}; shift ;;
  esac
done
if [[ $method == GET ]]; then
  [[ $GH_TOKEN == read-token ]] || exit 92
else
  [[ $GH_TOKEN == write-token ]] || exit 93
  printf '%s %s\n' "$method" "$path" >> "$STATE/writes"
fi
ref() { git --git-dir="$STATE/origin.git" rev-parse --verify "$1"; }
show_pull() {
  jq --arg sha "$(ref refs/heads/release/kit)" '.head = {sha:$sha,ref:"release/kit",repo:{full_name:"fixture/kit"}}' "$STATE/pull"
}
case "$method $path" in
  'GET git/ref/heads/main')
    if [[ $query == '.object.sha' ]]; then ref refs/heads/main
    else jq -n --arg sha "$(ref refs/heads/main)" '{object:{sha:$sha}}'; fi ;;
  'GET actions/runs?'*)
    [[ $path == *"head_sha=$(ref refs/heads/main)&"* ]] || exit 95
    if [[ -e $STATE/runs ]]; then cat "$STATE/runs"; else
      jq -n --arg sha "$(ref refs/heads/main)" '[{workflow_runs:[
        {id:1,path:".github/workflows/ci.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"},
        {id:2,path:".github/workflows/secret-scan.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"}
      ]}]'
    fi ;;
  'GET git/matching-refs/heads/release/kit')
    if head=$(ref refs/heads/release/kit 2>/dev/null); then
      jq -n --arg sha "$head" '[{ref:"refs/heads/release/kit",object:{sha:$sha}}]'
    else echo '[]'; fi ;;
  'GET pulls?'*)
    if [[ -f $STATE/pull ]]; then show_pull | jq '[[.]]'; else echo '[[]]'; fi ;;
  'GET pulls/7') show_pull ;;
  'GET user/42') echo '{"type":"Bot","id":42,"login":"kit-ci[bot]"}' ;;
  'GET issues/7/comments?'*) jq '[.]' "$STATE/comments" ;;
  'POST pulls'|'PATCH pulls/7')
    jq '. + {number:7,state:"open"}' > "$STATE/pull"
    show_pull ;;
  'POST issues/7/comments')
    jq --slurpfile before "$STATE/comments" '$before[0] + [. + {id:101,user:{id:42}}]' > "$STATE/comments.next"
    mv "$STATE/comments.next" "$STATE/comments"
    echo '{}' ;;
  'PATCH issues/comments/101')
    jq --slurpfile before "$STATE/comments" '. as $update | $before[0] | map(if .id == 101 then . + $update else . end)' > "$STATE/comments.next"
    mv "$STATE/comments.next" "$STATE/comments"
    echo '{}' ;;
  *) echo "unexpected fake gh operation: $method $path" >&2; exit 94 ;;
esac
GH
chmod +x "$tmp/bin/gh"

fixture() {
  export STATE="$tmp/$1"
  mkdir -p "$STATE/work/.dev"
  repo="$STATE/work"
  git -C "$repo" init -q -b main
  printf 'release:\n  component: kit\n' > "$repo/.dev/stack.yml"
  # Keep a no-final-newline, CRLF release section to catch normalization.
  printf '## kit/v0.1.0 — 2026-01-01\r\n\r\n- Previously released\r\n\r\nOld tail\t' > "$STATE/old"
  printf '# Changelog\r\n\r\n## Unreleased\r\n\r\n' > "$repo/CHANGELOG.md"
  cat "$STATE/old" >> "$repo/CHANGELOG.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm initial
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" tag -am baseline kit/v0.1.0
  git -C "$repo" tag kit/v0.0.50
  git -C "$repo" tag kit/v999.0.0-rc.1
  git -C "$repo" tag sibling/v900.0.0
  git clone -q --bare "$repo" "$STATE/origin.git"
  git -C "$repo" remote add origin "$STATE/origin.git"
  echo '[]' > "$STATE/comments"
  touch "$STATE/writes"
}
source_commit() {
  git -C "$repo" add .
  git -C "$repo" commit -qm "$1" --allow-empty
  git -C "$repo" push -q origin main
  source=$(git -C "$repo" rev-parse HEAD)
}
entries() {
  {
    printf '\r\n### Consumer changes\r\n\r\n'
    printf '%s\r\n' "$@"
    printf '\r\n'
  } > "$STATE/notes"
  printf '# Changelog\r\n\r\n## Unreleased\r\n' > "$repo/CHANGELOG.md"
  cat "$STATE/notes" "$STATE/old" >> "$repo/CHANGELOG.md"
  source_commit 'record the pending notes'
}
invoke() { (cd "$repo" && bun --no-env-file "$script" "$@") > "$STATE/out" 2>&1; }
apply() { RELEASE_WRITE_TOKEN=write-token invoke --apply "$@"; }
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; cat "$STATE/out" >&2; return 1; }
expect_log() { grep -Fq -- "$1" "$STATE/out" || fail "missing output: $1"; }
reject_log() {
  if grep -Fq -- "$1" "$STATE/out"; then fail "unexpected output: $1"; fi
}
expect_tag() { expect_log "chore(release): kit/$1"; }
head() { git --git-dir="$STATE/origin.git" rev-parse --verify refs/heads/release/kit; }
remote_tags() { git --git-dir="$STATE/origin.git" show-ref --tags; }
local_tags() { git -C "$repo" show-ref --tags; }
assert_dry_run_patch() {
  invoke --dry-run && expect_tag v0.1.1
}
assert_preserved() {
  local tag=$1 prepared actual_header
  prepared=$(head) || return 1
  git --git-dir="$STATE/origin.git" show "$prepared:CHANGELOG.md" > "$STATE/actual"
  actual_header=$(awk '/^## kit\/v/{ sub(/\r$/, ""); print; exit }' "$STATE/actual")
  printf '# Changelog\r\n\r\n## Unreleased\r\n\r\n## kit/%s — %s\r\n' "$tag" "$(date -u +%F)" > "$STATE/expected"
  cat "$STATE/notes" "$STATE/old" >> "$STATE/expected"
  cmp -s "$STATE/expected" "$STATE/actual" || {
    printf 'FAIL: expected byte-identical tagged sections and notes (release heading: %s)\n' "$actual_header" >&2
    return 1
  }
}
assert_maintainer_preserved() {
  local sha=$1
  [[ $(head) == "$sha" ]] || fail 'expected maintainer head to stay unchanged'
}
assert_no_proposal() {
  [[ ! -s $STATE/writes && ! -e $STATE/pull ]] || fail 'expected no GitHub writes'
  if head 2>/dev/null; then fail 'expected no proposal branch'; fi
}
assert_closing_notes_rejected() {
  if apply; then fail 'expected issue-closing notes to be rejected'; return 1; fi
  expect_log 'rephrase CHANGELOG.md line'
  assert_no_proposal
}


fixture patch
entries '- Standard change'
remote_tags > "$STATE/remote.before"
# A greater version outside the source ancestry cannot become the baseline.
git -C "$repo" switch -qc unrelated "$base"
git -C "$repo" commit -qm side --allow-empty
git -C "$repo" tag kit/v9.0.0
local_tags > "$STATE/local.before"
git -C "$repo" switch -q main
assert_dry_run_patch
expect_log 'eligibility: not checked (dry-run)'
expect_log "Base tag: \`kit/v0.1.0\` (\`$base\`)"
expect_log "Source SHA: \`$source\`"
expect_log 'Commits in range: 1'
expect_log 'Standard change'
reject_log 'Previously released'
[[ ! -s $STATE/writes ]]
write_output="$STATE/workflow-output"
GITHUB_OUTPUT="$write_output" invoke --plan
[[ $(cat "$write_output") == 'write=true' && ! -s $STATE/writes ]]
apply
assert_preserved v0.1.1
cmp -s "$STATE/local.before" <(local_tags)
cmp -s "$STATE/remote.before" <(remote_tags)
pass 'ancestral baseline, pending-only scope, patch bump, byte safety and no tag writes'

fixture minor
entries '- **Product action:** Set a header.' '- ${{ secrets.FAKE }}; $(touch dangerous)' '- ::error::printed as data'
invoke --dry-run
expect_tag v0.2.0
expect_log '- Set a header.'
reject_log '::error::'
apply
assert_preserved v0.2.0
jq -e '.body | contains("- Set a header.") and contains("${{ secrets.FAKE }}; $(touch dangerous)") and contains("::error::printed as data")' "$STATE/pull" >/dev/null
[[ ! -e $repo/dangerous ]]
[[ $(git --git-dir="$STATE/origin.git" rev-list --parents -1 "$(head)") == "$(head) $source" ]]
[[ $(git --git-dir="$STATE/origin.git" diff-tree --no-commit-id --name-only -r "$(head)") == 'CHANGELOG.md' ]]
[[ $(jq -r '.title' "$STATE/pull") == "$(git --git-dir="$STATE/origin.git" show -s --format=%s "$(head)")" ]]
first=$(head)
apply
[[ $(head) == "$first" && $(cat "$STATE/writes") == 'POST pulls' ]]
rm -f "$write_output"
GITHUB_OUTPUT="$write_output" invoke --plan
[[ ! -e $write_output ]]
entries '- **Product action:** Set a different header.'
apply
[[ $(head) != "$first" ]]
[[ $(git --git-dir="$STATE/origin.git" rev-parse "$(head)^1") == "$source" ]]
[[ $(cat "$STATE/writes") == $'POST pulls\nPATCH pulls/7' ]]
refreshed=$(head)
jq '.title = "stale metadata"' "$STATE/pull" > "$STATE/modified"
mv "$STATE/modified" "$STATE/pull"
apply
[[ $(head) == "$refreshed" && $(jq -r .title "$STATE/pull") == 'chore(release): kit/v0.2.0' ]]
[[ $(cat "$STATE/writes") == $'POST pulls\nPATCH pulls/7\nPATCH pulls/7' ]]
pass 'minor bump, untrusted notes as data, one-commit branch, idempotent refresh and metadata-only repair'

for closing in 'Closes fixture/kit#7' 'FiXeD: https://github.com/fixture/kit/issues/7' \
    'resolve: https://github.com/fixture/kit/pull/7' $'Resolves\r\n#7'; do
  fixture "closing-${closing%%[ :]*}"
  entries "- $closing"
  assert_closing_notes_rejected
done
pass 'issue-closing keywords in generated notes stop before writing'

fixture neutral-reference
entries '- Refs fixture/kit#7' '<!--'
apply
jq -e '.body | index("Proposed tag:") < index("### Manual publication") and
  index("Publish the GitHub Release") < index("### Product actions") and
  index("### Product actions") < index("- Refs fixture/kit#7") and
  index("- Refs fixture/kit#7") < index("<!--")' "$STATE/pull" >/dev/null
pass 'neutral references stay verbatim; metadata and checklist precede generated Markdown'

fixture fenced-heading
entries '  ~~~~markdown' '### Example heading' '## Example section' '  ~~~' '```' \
  '  ~~~~~' '- **Product action:** Update the client.'
apply
assert_preserved v0.2.0
jq -e '.body | contains("## Example section") and contains("- Update the client.")' "$STATE/pull" >/dev/null
pass 'fenced headings do not end Unreleased or drop later migration notes'

fixture fenced-marker
entries '   ````md' '   ```' '- **Product action:** Example only.' '   `````' \
  '- Description with **Product action:** in the middle.'
assert_dry_run_patch
expect_log 'None.'
pass 'markers inside fences or in the middle of a list item do not bump'

fixture pending-publication
printf '\r\n## kit/v0.1.1 — 2026-01-02\r\n\r\n- Merged, not tagged\r\n' > "$STATE/pending"
cat "$STATE/old" >> "$STATE/pending"
mv "$STATE/pending" "$STATE/old"
entries '- Next patch'
apply
expect_log '::warning::'
expect_log 'kit/v0.1.1'
expect_log 'publish its tag first'
assert_no_proposal
pass 'an already merged release section waits for manual tagging'

fixture colliding-tag
entries '- Next patch'
git -C "$repo" switch -qc unrelated "$base"
git -C "$repo" commit -qm 'off main' --allow-empty
git -C "$repo" tag kit/v0.1.1
git -C "$repo" switch -q main
local_tags > "$STATE/local.before"
remote_tags > "$STATE/remote.before"
if apply; then fail 'expected a tag collision to fail'; fi
expect_log 'tag kit/v0.1.1 already exists'
assert_no_proposal
cmp -s "$STATE/local.before" <(local_tags)
cmp -s "$STATE/remote.before" <(remote_tags)
pass 'an existing tag off the source history blocks the proposal without moving tags'


fixture empty
source_commit 'no unreleased notes'
apply
expect_log 'no unreleased changes'
[[ ! -s $STATE/writes ]]
if head 2>/dev/null; then fail 'an empty Unreleased created a proposal branch'; fi
pass 'empty Unreleased makes no proposal'

fixture human
entries '- Pending change'
apply
git -C "$repo" fetch -q origin release/kit
git -C "$repo" switch -qc maintainer FETCH_HEAD
printf 'human edit\n' >> "$repo/CHANGELOG.md"
git -C "$repo" commit -qam 'keep the maintainer notes'
human=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push -q origin HEAD:release/kit
git -C "$repo" switch -q main
apply
[[ $(cat "$STATE/writes") == 'POST pulls' ]]
cp "$STATE/pull" "$STATE/initial-pull"
source_commit 'advance main past the edited proposal'
apply
assert_maintainer_preserved "$human"
cmp -s "$STATE/pull" "$STATE/initial-pull"
jq -e --arg sha "$source" 'length == 1 and .[0].body == ("<!-- kit-release-proposal -->\nThis release proposal is behind main at `" + $sha + "`. Refresh it manually to preserve maintainer commits.")' "$STATE/comments" >/dev/null
apply
[[ $(cat "$STATE/writes") == $'POST pulls\nPOST issues/7/comments' ]]
source_commit 'advance main again'
apply
assert_maintainer_preserved "$human"
jq -e --arg sha "$source" 'length == 1 and (.[0].body | contains($sha))' "$STATE/comments" >/dev/null
[[ $(cat "$STATE/writes") == $'POST pulls\nPOST issues/7/comments\nPATCH issues/comments/101' ]]
pass 'maintainer commits preserve head and PR; marked comment is idempotent and updated in place'

fixture product
entries '- Would otherwise release'
mkdir -p "$repo/config/product"
echo '{}' > "$repo/config/product/inheritance.json"
source_commit 'mark Product tree'
GH_TOKEN='' apply
expect_log 'Product tree; skipped'
[[ ! -s $STATE/writes ]]
pass 'Product tree returns before any GitHub call'

fixture eligibility
entries '- Would otherwise release'
old=$source
git -C "$repo" switch -qc side
git -C "$repo" commit -qm side --allow-empty
side=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" switch -q main
git -C "$repo" merge -q --no-ff -m 'merge side' side
git -C "$repo" push -q origin main
source=$(git -C "$repo" rev-parse HEAD)

# Exercise the checked-in workflow shell, not a second copy of its decisions.
# A completion for $old carries no requested SHA; only dispatch inputs bind a SHA.
workflow="$ROOT/.github/workflows/release-prepare.yml"
eligibility_step=$(bun --no-env-file -e '
  const workflow = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
  const step = workflow.jobs.prepare.steps.find(step => step.id === "eligible");
  if (workflow.jobs.prepare.steps[0].with.ref !== "main" ||
      step.env.REQUESTED_SHA !== "${{ github.event_name == '\''workflow_dispatch'\'' && inputs.sha || '\'''\'' }}")
    throw new Error("automatic completions must wake the current main checkout without passing the event SHA");
  console.log(step.run);
' "$workflow")
run_eligibility_step() {
  (cd "$repo" && REQUESTED_SHA="$1" GITHUB_OUTPUT="$STATE/eligible-output" \
    bash -c "$eligibility_step") > "$STATE/out" 2>&1
}
GITHUB_EVENT_PATH="$STATE/event.json"
jq -n --arg sha "$old" '{workflow_run:{head_sha:$sha,event:"push",head_branch:"main",conclusion:"success"}}' > "$GITHUB_EVENT_PATH"
export GITHUB_EVENT_PATH
GITHUB_EVENT_NAME=workflow_run run_eligibility_step ''
[[ $(cat "$STATE/eligible-output") == "sha=$source" ]]
rm "$STATE/eligible-output"
GITHUB_EVENT_NAME=workflow_dispatch run_eligibility_step "$old"
expect_log 'Requested source is not the current first-parent tip'
[[ ! -e $STATE/eligible-output ]]
unset GITHUB_EVENT_PATH
pass 'stale completion wakes the current tip; stale explicit dispatch is skipped'

for ineligible in "$old" "$side"; do
  apply --sha "$ineligible"
  expect_log 'not the current first-parent tip'
done
for result in '"failure"' null '"success"'; do
  jq -n --arg sha "$source" --argjson result "$result" '[{workflow_runs:[
    {id:1,path:".github/workflows/ci.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"},
    {id:2,path:".github/workflows/secret-scan.yml",head_sha:$sha,head_branch:"main",event:"pull_request",conclusion:"success"},
    {id:3,path:".github/workflows/secret-scan.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:$result}
  ]}]' > "$STATE/runs"
  if [[ $result == '"success"' ]]; then jq '.[0].workflow_runs |= del(.[2])' "$STATE/runs" > "$STATE/missing"; mv "$STATE/missing" "$STATE/runs"; fi
  apply
  expect_log 'not both green for this main push'
done
[[ ! -s $STATE/writes ]]
pass 'stale first-parent, merged side parent, failed, pending and missing push evidence are ineligible'

mutant() {
  local name=$1 needle=$2 replacement=$3
  PROPOSAL_SOURCE="$ROOT/scripts/kit/release-prepare.ts" NEEDLE="$needle" REPLACEMENT="$replacement" bun --no-env-file -e '
    const input = await Bun.file(process.env.PROPOSAL_SOURCE).text();
    const from = process.env.NEEDLE;
    if (input.split(from).length !== 2) throw new Error(`expected one mutation target: ${from}`);
    await Bun.write(process.argv[1], input.replace(from, process.env.REPLACEMENT));
  ' "$tmp/$name.ts"
  script="$tmp/$name.ts"
}
killed() {
  local name=$1 expected=$2
  shift 2
  if "$@" > "$STATE/mutant-out" 2>&1; then fail "mutant $name survived"; fi
  grep -Fq "FAIL: $expected" "$STATE/mutant-out" || { cat "$STATE/mutant-out" >&2; return 1; }
  pass "mutant killed: $name"
  cat "$STATE/mutant-out"
}

fixture mutant-always-minor
entries '- Patch only'
mutant always-minor 'actions.length > 0 ?' 'true ?'
killed always-minor 'missing output: chore(release): kit/v0.1.1' assert_dry_run_patch

fixture mutant-rewrite-tagged
entries '- Patch only'
mutant rewrite-tagged '${section.body}${section.rest}' '${section.body}${section.rest.trimEnd()}'
apply
killed rewrite-tagged 'expected byte-identical tagged sections and notes' assert_preserved v0.1.1

fixture mutant-ignore-maintainer
entries '- Patch only'
mutant ignore-maintainer 'head && hasMaintainerCommit(head, sha, bot)' 'head && false'
apply
git -C "$repo" fetch -q origin release/kit
git -C "$repo" switch -qc maintainer FETCH_HEAD
git -C "$repo" commit -qm 'maintainer correction' --allow-empty
human=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push -q origin HEAD:release/kit
git -C "$repo" switch -q main
source_commit 'advance main past the edited proposal'
apply
killed ignore-maintainer 'expected maintainer head to stay unchanged' assert_maintainer_preserved "$human"

fixture mutant-allow-closing-notes
entries '- Closes fixture/kit#7'
mutant allow-closing-notes 'if (closingReference)' 'if (false && closingReference)'
killed allow-closing-notes 'expected issue-closing notes to be rejected' assert_closing_notes_rejected

fixture mutant-ignore-fences
entries '```md' '- **Product action:** Example only.' '```' '- Actual patch'
mutant ignore-fences 'if (fence) continue' 'if (false && fence) continue'
killed ignore-fences 'missing output: chore(release): kit/v0.1.1' assert_dry_run_patch
