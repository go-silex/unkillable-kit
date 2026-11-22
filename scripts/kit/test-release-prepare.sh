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
export KIT_RELEASE_TEST_POLL_MS=0
export GIT_AUTHOR_NAME=Maintainer GIT_AUTHOR_EMAIL=maintainer@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
# Exercise committer (not author or local calendar) dates independently of the clock.
export GIT_AUTHOR_DATE='2026-01-02T10:00:00Z'
export GIT_COMMITTER_DATE='2026-01-02T23:45:00-05:00'
release_date=2026-01-03
export GIT_ALLOW_PROTOCOL=file
unset GITHUB_OUTPUT RELEASE_WRITE_TOKEN
unset FIXTURE_CLOCK
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
    *) [[ -z $path ]]; path=${1#"repos/$GITHUB_REPOSITORY/"}; shift ;;
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
  local sha=${1:-} status=${2:-open} base_ref=${3:-main} base_repo=${4:-$GITHUB_REPOSITORY}
  if [[ -z $sha ]]; then sha=$(ref "refs/heads/$FIXTURE_BRANCH"); fi
  jq --arg sha "$sha" --arg status "$status" --arg base_ref "$base_ref" --arg base_repo "$base_repo" \
    --arg branch "$FIXTURE_BRANCH" --arg repo "$GITHUB_REPOSITORY" \
    '.state = $status
    | .head = {sha:$sha,ref:$branch,repo:{full_name:$repo}}
    | .base = {ref:$base_ref,repo:{full_name:$base_repo}}' "$STATE/pull"
}
show_pull_detail() {
  local read=1 sha status base_ref base_repo
  if [[ -f $STATE/pull-reads ]]; then read=$(( $(cat "$STATE/pull-reads") + 1 )); fi
  printf '%s\n' "$read" > "$STATE/pull-reads"
  if [[ -f $STATE/pull-sequence ]]; then
    # Repeat the last queued response. Use '-' as the current remote branch SHA.
    read -r sha status base_ref base_repo < <(awk -v n="$read" 'NR == n { print; found = 1; exit } END { if (!found) print }' "$STATE/pull-sequence")
    if [[ $sha == - ]]; then sha=''; fi
    show_pull "$sha" "$status" "$base_ref" "$base_repo"
  else
    show_pull
  fi
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
  "GET git/matching-refs/heads/$FIXTURE_BRANCH")
    if head=$(ref "refs/heads/$FIXTURE_BRANCH" 2>/dev/null); then
      jq -n --arg sha "$head" --arg ref "refs/heads/$FIXTURE_BRANCH" '[{ref:$ref,object:{sha:$sha}}]'
    else echo '[]'; fi ;;
  'GET pulls?'*)
    if [[ -f $STATE/pull ]]; then
      stale='' base_ref=main
      if [[ -f $STATE/list-sha ]]; then stale=$(cat "$STATE/list-sha"); fi
      if [[ -f $STATE/list-base ]]; then base_ref=$(cat "$STATE/list-base"); fi
      if [[ $path == *'base=main&'* && $base_ref != main ]]; then echo '[[]]'
      else show_pull "$stale" open "$base_ref" | jq '[[.]]'; fi
    else echo '[[]]'; fi ;;
  'GET pulls/7') show_pull_detail ;;
  'GET user/42') echo '{"type":"Bot","id":42,"login":"kit-ci[bot]"}' ;;
  'GET issues/7/comments?'*) jq '[.]' "$STATE/comments" ;;
  'POST pulls'|'PATCH pulls/7')
    jq -e --arg method "$method" --arg branch "$FIXTURE_BRANCH" '
      if $method == "POST" and (.head != $branch or .base != "main")
      then error("POST must target main from the proposal branch")
      else . + {number:7,state:"open"} end
    ' > "$STATE/pull"
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

fixture_kit() {
  export GITHUB_REPOSITORY=fixture/kit FIXTURE_BRANCH=release/kit
  export STATE="$tmp/$1"
  mkdir -p "$STATE/work/.dev"
  repo="$STATE/work"
  git -C "$repo" init -q -b main
  printf 'release:\n  component: kit\n' > "$repo/.dev/stack.yml"
  # Keep trailing spaces and no final newline to catch normalization.
  printf '## kit/v0.1.0 — 2026-01-01\n\n- Previously released\n\nOld tail  ' > "$STATE/old"
  printf '# Changelog\n\n## Unreleased\n\n' > "$repo/CHANGELOG.md"
  cat "$STATE/old" >> "$repo/CHANGELOG.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm initial
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" tag -am baseline kit/v0.1.0
  git -C "$repo" tag kit/v0.0.50
  git -C "$repo" tag kit/v999.0.0-rc.1
  git -C "$repo" tag sibling/v900.0.0
}
fixture_origin() {
  git clone -q --bare "$repo" "$STATE/origin.git"
  git -C "$repo" remote add origin "$STATE/origin.git"
  echo '[]' > "$STATE/comments"
  touch "$STATE/writes"
}
fixture() {
  fixture_kit "$1"
  fixture_origin
}
source_commit() {
  git -C "$repo" add .
  git -C "$repo" commit -qm "$1" --allow-empty
  git -C "$repo" push -q origin main
  source=$(git -C "$repo" rev-parse HEAD)
}
entries() {
  {
    printf '\n### Consumer changes\n\n'
    printf '%s\n' "$@"
    printf '\n'
  } > "$STATE/notes"
  printf '# Changelog\n\n## Unreleased\n' > "$repo/CHANGELOG.md"
  cat "$STATE/notes" "$STATE/old" >> "$repo/CHANGELOG.md"
  source_commit 'record the pending notes'
}
invoke() {
  local -a options=()
  if [[ -n ${FIXTURE_CLOCK:-} ]]; then options+=(--preload "$tmp/clock.js"); fi
  (cd "$repo" && bun --no-env-file "${options[@]}" "$script" "$@") > "$STATE/out" 2>&1
}
apply() { RELEASE_WRITE_TOKEN=write-token invoke --apply "$@"; }
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; cat "$STATE/out" >&2; return 1; }
expect_log() { grep -Fq -- "$1" "$STATE/out" || fail "missing output: $1"; }
reject_log() {
  if grep -Fq -- "$1" "$STATE/out"; then fail "unexpected output: $1"; fi
}
expect_tag() { expect_log "chore(release): kit/$1"; }
head() { git --git-dir="$STATE/origin.git" rev-parse --verify "refs/heads/$FIXTURE_BRANCH"; }
remote_tags() { git --git-dir="$STATE/origin.git" show-ref --tags; }
local_tags() { git -C "$repo" show-ref --tags; }
assert_dry_run_patch() {
  invoke --dry-run && expect_tag v0.1.1
}
assert_preserved() {
  local tag=$1 prepared actual_header
  prepared=$(head) || return 1
  git --git-dir="$STATE/origin.git" show "$prepared:CHANGELOG.md" > "$STATE/actual"
  actual_header=$(awk '/^## kit\/v/{ print; exit }' "$STATE/actual")
  printf '# Changelog\n\n## Unreleased\n\n## kit/%s — %s\n' "$tag" "$release_date" > "$STATE/expected"
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
assert_grammar_rejected() {
  if apply; then fail 'expected invalid CHANGELOG grammar to stop preparation'; return 1; fi
  expect_log "CHANGELOG.md line $1:"
  expect_log "$2"
  assert_no_proposal
}
assert_full_action() {
  jq -j '.body | split("### Product actions\n\n")[1] | split("\n\n## kit/")[0]' \
    "$STATE/pull" > "$STATE/summary"
  cmp -s "$STATE/action" "$STATE/summary" ||
    fail 'expected byte-identical Product action bullets apart from pinned destinations'
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
expect_log '- **Product action:** Set a header.'
reject_log '::error::'
apply
assert_preserved v0.2.0
jq -e '.body | contains("- **Product action:** Set a header.") and contains("${{ secrets.FAKE }}; $(touch dangerous)") and contains("::error::printed as data")' "$STATE/pull" >/dev/null
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

refresh_fixture() {
  fixture "$1"
  entries '- A patch proposal.'
  apply
  previous_head=$(head)
  cp "$STATE/pull" "$STATE/original-pull"
  entries '- **Product action:** Follow the new instructions.'
}
assert_refresh() {
  apply || { fail 'expected the lagging proposal refresh to succeed'; return 1; }
  [[ $(head) != "$previous_head" ]] || fail 'expected a new proposal branch head'
  assert_refresh_metadata
}
assert_refresh_metadata() {
  [[ $(cat "$STATE/writes") == $'POST pulls\nPATCH pulls/7' ]] ||
    fail 'expected exactly one proposal PATCH'
  jq -e --arg sha "$source" '.title == "chore(release): kit/v0.2.0" and
    (.body | contains($sha) and contains("Follow the new instructions."))' "$STATE/pull" >/dev/null ||
    fail 'expected the proposal title and body to describe the new source'
}
assert_refresh_refused() {
  if apply; then fail 'expected an unsafe or unsynced proposal refresh to stop'; return 1; fi
  expect_log "$1"
  [[ $(cat "$STATE/writes") == 'POST pulls' ]] || fail 'expected no proposal PATCH'
  cmp -s "$STATE/original-pull" "$STATE/pull" || fail 'expected unchanged proposal metadata'
  [[ $(cat "$STATE/pull-reads") == "$2" ]] || fail 'unexpected number of proposal reads'
}

refresh_fixture lagging-after-push
printf -- '- open\n%s open\n%s open\n- open\n' "$previous_head" "$previous_head" > "$STATE/pull-sequence"
assert_refresh
[[ $(cat "$STATE/pull-reads") == 4 ]]
pass 'refresh waits for a lagging PR head before patching the title and body once'

refresh_fixture third-head-after-push
printf -- '- open\n%s open\n%s open\n- open\n' "$previous_head" "$base" > "$STATE/pull-sequence"
assert_refresh_refused 'proposal changed; rerun release preparation' 3
pass 'a third PR head stops the refresh without a PATCH'

refresh_fixture closed-during-wait
printf -- '- open\n%s open\n- closed\n- open\n' "$previous_head" > "$STATE/pull-sequence"
assert_refresh_refused 'proposal changed; rerun release preparation' 3
pass 'a PR closing during the wait stops the refresh without a PATCH'

refresh_fixture never-syncs-after-push
printf -- '- open\n%s open\n' "$previous_head" > "$STATE/pull-sequence"
assert_refresh_refused 'workflow_dispatch without sha' 17
pass 'a PR head that never syncs stops after the bound and names the dispatch recovery'

refresh_fixture lagging-at-start
printf -- '- open\n%s open\n' "$previous_head" > "$STATE/pull-sequence"
assert_refresh_refused 'workflow_dispatch without sha' 17
refreshed=$(head)
printf '%s\n' "$previous_head" > "$STATE/list-sha"
printf '%s open\n- open\n' "$previous_head" > "$STATE/pull-sequence"
rm "$STATE/pull-reads"
apply
[[ $(head) == "$refreshed" && $(cat "$STATE/pull-reads") == 3 ]]
assert_refresh_metadata
pass 'reconciliation waits for a stale list result to sync and repairs metadata without a push'

refresh_fixture never-syncs-at-start
printf '%s\n' "$base" > "$STATE/list-sha"
printf '%s open\n' "$base" > "$STATE/pull-sequence"
assert_refresh_refused 'workflow_dispatch without sha' 16
[[ $(head) == "$previous_head" ]]
pass 'reconciliation stops before pushing if the start heads never converge'

assert_retarget_refused() {
  assert_refresh_refused 'proposal no longer targets main in this repository' 1 || return 1
  [[ $(head) == "$previous_head" ]] || fail 'expected no branch update for a retargeted proposal'
}

refresh_fixture retargeted-at-start
printf -- '- open staging\n' > "$STATE/pull-sequence"
assert_retarget_refused
pass 'a stale list entry for a retargeted PR cannot authorize a branch update or PATCH'

refresh_fixture retargeted-visible
printf 'staging\n' > "$STATE/list-base"
printf -- '- open staging\n' > "$STATE/pull-sequence"
if apply; then fail 'expected refusal of an open proposal targeting staging'; fi
expect_log 'proposal no longer targets main in this repository'
[[ $(head) == "$previous_head" && $(cat "$STATE/writes") == 'POST pulls' ]]
cmp -s "$STATE/original-pull" "$STATE/pull"
pass 'an open PR visibly targeting staging blocks branch updates and duplicate proposals'

refresh_fixture wrong-base-repo-at-start
printf -- '- open main other/kit\n' > "$STATE/pull-sequence"
assert_retarget_refused
pass 'a detail response targeting main in another repository cannot authorize a branch update or PATCH'

refresh_fixture retargeted-during-wait
printf -- '- open\n%s open\n- open staging\n' "$previous_head" > "$STATE/pull-sequence"
assert_refresh_refused 'proposal no longer targets main in this repository' 3
[[ $(head) != "$previous_head" ]]
pass 'a PR retargeted during the post-push wait cannot authorize a PATCH'

for closing in 'Closes fixture/kit#7' 'FiXeD: [issue](https://github.com/fixture/kit/issues/7)' \
    'resolve: [pull request](https://github.com/fixture/kit/pull/7)' $'Resolves\n  fixture/kit#7'; do
  fixture "closing-${closing%%[ :]*}"
  entries "- $closing"
  assert_closing_notes_rejected
done
pass 'issue-closing keywords in generated notes stop before writing'

fixture neutral-reference
: > "$STATE/old"
entries '- Refs fixture/kit#7'
apply
jq -e '.body | index("Proposed tag:") < index("### Manual publication") and
  index("Publish the GitHub Release") < index("### Product actions") and
  index("### Product actions") < index("- Refs fixture/kit#7")' "$STATE/pull" >/dev/null
pass 'neutral references stay verbatim; metadata and checklist precede generated Markdown'

for invalid in fence tilde-fence nested-fence html-comment html-block quote table table-delimiter nested-heading nested-item \
    lazy reference item-reference multiline-reference continuation-reference setext thematic pipe-free-table tabs code indented-blank \
    star plus ordered heading disconnected empty-action action-spaces near-miss lower-case italic-action \
    duplicate-unreleased duplicate-release inline-release nbsp-release formatted-unreleased wrong-component \
    trailing-release ascii-date semver-order unreleased-first html-decimal html-hex html-named \
    literal-url angle-autolink inline-html html-bracket unicode-line code-line separator-control crlf \
    nbsp-title title angle-destination empty-destination empty-angle query-only root-relative protocol-relative \
    other-scheme shortcut unmatched-code escaped-bracket bare-www bare-mailto; do
  fixture "grammar-$invalid"
  line=7
  case $invalid in
    fence) rule=fences; entries '```md' ;;
    tilde-fence) rule=fences; entries '  ~~~md' ;;
    nested-fence) rule=fences; entries '- ```md' ;;
    html-comment) rule='HTML comments'; entries 'Text <!-- comment -->' ;;
    html-block) rule='HTML, blockquotes and tables'; entries '<details>' ;;
    quote) rule='HTML, blockquotes and tables'; entries '> quote' ;;
    table) rule='HTML, blockquotes and tables'; entries '| table |' ;;
    table-delimiter) rule='table delimiter'; line=8; entries 'Left | Right' '--- | --- |' ;;
    nested-heading) rule='block marker'; line=8; entries '- Item' '  ## Nested' ;;
    nested-item) rule='block marker'; line=8; entries '- Item' '  - Nested' ;;
    lazy) rule='plain paragraph'; line=8; entries '- Item' 'Lazy continuation' ;;
    reference) rule='link reference'; entries '[label]: /url' ;;
    item-reference) rule='expected [text](destination)'; entries '- [x]: y' ;;
    multiline-reference) rule='link reference'; entries '[label' 'continued]: /url' ;;
    continuation-reference) rule='link reference'; line=8; entries '- Item' '  [label]: /url' ;;
    setext) rule='setext'; line=8; entries 'Text' '====' ;;
    thematic) rule='thematic breaks'; entries '- - -' ;;
    pipe-free-table) rule='table delimiter'; line=8; entries 'Column' ':---:' ;;
    tabs) rule='only ASCII space and LF'; entries $'- Tab\there' ;;
    code) rule=indentation; entries '    code' ;;
    indented-blank) rule=indentation; entries '    ' ;;
    star) rule='list items'; entries '* Item' ;;
    plus) rule='list items'; entries '+ Item' ;;
    ordered) rule='list items'; entries '1) Item' ;;
    heading) rule='heading'; entries '#### Heading' ;;
    disconnected) rule='continuation'; line=9; entries '- Item' '' '  Disconnected' ;;
    empty-action) rule='Product action marker'; entries '- **Product action:**' '  Migrate the client.' ;;
    action-spaces) rule='Product action marker'; entries '- **Product action:**  Migrate the client.' ;;
    near-miss) rule='Product action marker'; entries '- **Product action**: Migrate the client.' ;;
    lower-case) rule='Product action marker'; entries '- **product action:** Migrate the client.' ;;
    italic-action) rule='Product action marker'; entries '- *Product action:* Migrate the client.' ;;
    duplicate-unreleased) rule='duplicate ## Unreleased'; line=8; entries '- First change' '## Unreleased' '- **Product action:** Another change.' ;;
    duplicate-release) rule='duplicate release version'; line=10; entries '## kit/v0.1.0 — 2026-01-02' '- Duplicate section' ;;
    inline-release) rule='expected canonical'; line=8; entries '- First change' '## `kit/v0.1.1` — 2026-01-02' ;;
    nbsp-release) rule='only ASCII space and LF'; entries $'## kit/v0.1.1\u00a0—\u00a02026-01-02' ;;
    formatted-unreleased) rule='expected canonical'; line=8; entries '- First change' '## **Unreleased**' '- **Product action:** Another change.' ;;
    wrong-component) rule='expected canonical'; entries '## other-kit/v0.1.1 — 2026-01-02' ;;
    trailing-release) rule='expected canonical'; entries '## kit/v0.1.1 — 2026-01-02 ' ;;
    ascii-date) rule='expected canonical'; entries '## kit/v0.1.1 — ２０２６-01-02' ;;
    semver-order) rule='strictly descending'; line=8; entries '## kit/v0.2.0 — 2026-01-02' '## kit/v0.10.0 — 2026-01-03' ;;
    unreleased-first)
      rule='first ## heading'; line=3; entries '- First change'
      { printf '# Changelog\n\n## kit/v0.2.0 — 2026-01-02\n'; tail -n +3 "$repo/CHANGELOG.md"; } > "$STATE/out-of-order"
      mv "$STATE/out-of-order" "$repo/CHANGELOG.md"
      source_commit 'put a release before Unreleased'
      ;;
    html-decimal) rule='HTML character references'; entries '- **Product&#32;action:** Migrate.' ;;
    html-hex) rule='HTML character references'; entries '- Item' '  More&nbsp information&#x20;here.'; line=8 ;;
    html-named) rule='HTML character references'; entries '### Named &nbsp; text' ;;
    literal-url) rule='bare URLs are not allowed'; entries '- Visit https://example.com/[label](docs/page.md).' ;;
    angle-autolink) rule='< is not allowed'; entries '- Read [<https://example.com>](docs/relative.md).' ;;
    inline-html) rule='< is not allowed'; entries '- Keep <span title="[fake](docs/fake.md)">literal</span>.' ;;
    html-bracket) rule='< is not allowed'; entries '- Read [<span title="]">label</span>](docs/real.md).' ;;
    unicode-line) rule='only ASCII space and LF'; entries $'- Keep `code\u2028- [x](y)`.' ;;
    code-line) rule='same backtick run on the same line'; entries '- Keep `code' '  with [x](y)`.' ;;
    separator-control) rule='only ASCII space and LF'; entries $'- Keep `x\u0085y`.' ;;
    crlf) rule='only ASCII space and LF'; entries $'- Record a CRLF\r' ;;
    nbsp-title) rule='only ASCII space and LF'; entries $'- Read [x](docs/page.md "title"\u00a0).' ;;
    title) rule='no title'; entries '- Read [x](docs/page.md "title").' ;;
    angle-destination) rule='non-empty destination'; entries '- Read [x](<docs/page.md>).' ;;
    empty-destination) rule='non-empty destination'; entries '- Read [x]().' ;;
    empty-angle) rule='non-empty destination'; entries '- Read [x](<> "t").' ;;
    query-only) rule='HTTPS URL, a fragment, or a relative path'; entries '- Read [x](?plain=1).' ;;
    root-relative) rule='HTTPS URL, a fragment, or a relative path'; entries '- Read [x](/docs/page.md).' ;;
    protocol-relative) rule='HTTPS URL, a fragment, or a relative path'; entries '- Read [x](//example.com).' ;;
    other-scheme) rule='HTTPS URL, a fragment, or a relative path'; entries '- Read [x](mailto:kit@example.com).' ;;
    shortcut) rule='expected [text](destination)'; entries '- Read [x].' ;;
    unmatched-code) rule='same backtick run on the same line'; entries '- Keep ``code`.' ;;
    escaped-bracket) rule='backslashes are not allowed'; entries '- Keep \[x](y).' ;;
    bare-www) rule='bare URLs are not allowed'; entries '- Visit www.example.com.' ;;
    bare-mailto) rule='bare URLs are not allowed'; entries '- Send to mailto:kit@example.com.' ;;
  esac
  assert_grammar_rejected "$line" "$rule"
  if invoke --check-changelog; then fail "doc gate accepted $invalid"; fi
  expect_log "CHANGELOG.md line $line:"
  pass "invalid $invalid fails preparation and the doc gate"
done

fixture same-text-heading-substitution
entries '- First pending note' '<!--' '## kit/v0.1.0 — 2026-01-01' '-->' \
  '- Second pending note' '- A nested fence' '  ~~~'
assert_grammar_rejected 8 'HTML comments'
pass 'same-text heading substitution fails before writing'

fixture same-count-marker-substitution
entries '<!--' '- **Product action:** Draft instruction.' '-->' \
  '- **Product action:**' '  Carry out the real migration.'
assert_grammar_rejected 7 'HTML comments'
pass 'same-count marker substitution fails before writing'

fixture invalid-tagged-section
printf '\n\n> Forbidden in a tagged section' >> "$STATE/old"
entries '- Valid unreleased change'
assert_grammar_rejected 15 'HTML, blockquotes and tables'
pass 'the grammar also checks tagged sections'

fixture multiline-action
action=('- **Product action:** Set the header.' '  Restart the client.' '  Verify the response.')
entries "${action[@]}" '- This is a long ordinary description with the **Product action:** phrase later in the same line.'
printf '%s\n%s\n%s' "${action[@]}" > "$STATE/action"
invoke --check-changelog
apply
assert_preserved v0.2.0
assert_full_action
pass 'the complete multiline Product action appears in the PR summary'

fixture marker-before-inline-markup
link='- **Product action:** [migration](#guide)'
code='- **Product action:** Keep ```sh ` [x](y)``` as an example.'
entries "$link" '  "title"' "$code"
printf '%s\n%s\n%s' "$link" '  "title"' "$code" > "$STATE/action"
invoke --check-changelog
apply
assert_full_action
pass 'a link or code span in a Product action keeps the marker verbatim'

fixture release-links
relative='- **Product action:** Follow the [manual Kit sync](docs/kit/product-consumer-contract.md#pulling-kit-upgrades).'
image='  See ![diagram](images/flow%20chart.svg) and the [guide with `]`](docs/guide.md).'
literal='- Keep `[single](../example.md)` and ``literal ` [double](../example.md)`` and `<span> \[x](y) https://example.com`.'
external='- Keep [HTTPS](https://example.com/doc?q=1#heading) and [anchor](#heading).'
section_only='- [Kit docs](docs/kit/README.md?next=%2Fdocs#part%2e1)'
entries "$relative" "$image" "$literal" "$external" "$section_only"
pin="https://github.com/fixture/kit/blob/$source"
relative_pinned="- **Product action:** Follow the [manual Kit sync]($pin/docs/kit/product-consumer-contract.md#pulling-kit-upgrades)."
image_pinned="  See ![diagram]($pin/images/flow%20chart.svg) and the [guide with \`]\`]($pin/docs/guide.md)."
printf '%s\n%s' "$relative_pinned" "$image_pinned" > "$STATE/action"
apply
assert_full_action
printf '\n### Consumer changes\n\n%s\n%s\n%s\n%s\n%s\n\n' \
  "$relative_pinned" "$image_pinned" "$literal" "$external" \
  "- [Kit docs]($pin/docs/kit/README.md?next=%2Fdocs#part%2e1)" > "$STATE/expected-body"
jq -j '.body | split("\n\n## kit/")[1] | sub("^[^\n]*\n"; "")' \
  "$STATE/pull" > "$STATE/rendered-body"
cmp -s "$STATE/expected-body" "$STATE/rendered-body" ||
  fail 'expected byte-identical full notes apart from pinned destinations'
assert_preserved v0.2.0
invoke --dry-run
expect_log "$relative_pinned"
git -C "$repo" remote set-url origin git@github.com:fixture/kit.git
(unset GITHUB_REPOSITORY; invoke --dry-run)
expect_log "$relative_pinned"
git -C "$repo" remote set-url origin "$STATE/origin.git"
(unset GITHUB_REPOSITORY; invoke --dry-run)
expect_log 'cannot identify a GitHub repository'
expect_log "$relative"
pass 'proposal destinations pin to the source SHA without changing Markdown or commit bytes'

for target in docs/kit//../README.md docs/kit//README.md docs/kit/ \
    docs/kit/%2e%2e/README.md ./docs/x.md docs/x/./y.md docs/../../outside.md \
    docs/x%2Fy.md docs/x%5Cy.md docs/file%2Emd docs/x%252fy.md; do
  fixture "invalid-relative-path-${target//\//_}"
  entries "- Read [Kit docs]($target)."
  case "$target" in
    *//*|*/) rule='without doubled or trailing slashes' ;;
    *) rule='without . or .. segments or encoded' ;;
  esac
  assert_grammar_rejected 7 "$rule"
  if invoke --check-changelog; then fail 'doc gate accepted an ambiguous relative path'; fi
  expect_log 'CHANGELOG.md line 7:'
  expect_log "$rule"
done
pass 'relative paths reject empty and dot segments and encoded separators, dots, and percent signs'

fixture pending-publication
printf '\n## kit/v0.1.1 — 2026-01-02\n\n- Merged, not tagged\n' > "$STATE/pending"
cat "$STATE/old" >> "$STATE/pending"
mv "$STATE/pending" "$STATE/old"
entries '- **Product action:** New migration after the merged patch.'
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

fixture older-than-latest-heading
printf '## kit/v0.10.0 — 2026-01-02\n\n- Newer release\n\n' > "$STATE/releases"
cat "$STATE/old" >> "$STATE/releases"
mv "$STATE/releases" "$STATE/old"
entries '- New change with a bare &'
git -C "$repo" switch -qc unrelated "$base"
git -C "$repo" commit -qm 'off main' --allow-empty
git -C "$repo" tag kit/v0.10.0
git -C "$repo" switch -q main
invoke --check-changelog
if apply; then fail 'expected a proposal older than the latest section to fail'; fi
expect_log 'must be newer than the latest CHANGELOG release kit/v0.10.0'
assert_no_proposal
pass 'a tag off main cannot make the proposed CHANGELOG go out of version order'


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
read_eligibility_step() {
  bun --no-env-file -e '
    const workflow = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
    const step = workflow.jobs.prepare.steps.find(step => step.id === "eligible");
    if (workflow.jobs.prepare.steps[0].with.ref !== "main" ||
        step.env.GH_TOKEN !== "${{ github.token }}" ||
        step.env.REQUESTED_SHA !== "${{ github.event_name == '\''workflow_dispatch'\'' && inputs.sha || '\'''\'' }}")
      throw new Error("eligibility must read with github.token and only bind a SHA for explicit dispatches");
    console.log(step.run);
  ' "$1"
}
eligibility_step=$(read_eligibility_step "$ROOT/.github/workflows/release-prepare.yml")
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

product_changelog=docs/product/CHANGELOG.md
inheritance_path=config/product/inheritance.json
product_gates=(--gate .github/workflows/ci.yml --gate .github/workflows/secret-scan.yml --gate .github/workflows/product-ci.yml)

write_pin() {
  jq -n --arg pin "$1" '{version:1,upstreamCommit:$pin}' > "$repo/$inheritance_path"
}
product_entries() {
  {
    command head -n 3 "$repo/$product_changelog"
    printf '\n%s\n' "$1"
    tail -n +4 "$repo/$product_changelog"
  } > "$STATE/next-product"
  mv "$STATE/next-product" "$repo/$product_changelog"
  source_commit 'record Product release notes'
}
insert_legacy_kit_examples() {
  {
    command head -n 3 "$kit/CHANGELOG.md"
    if [[ ${1:-} != raw-html-only ]]; then
      cat <<'EOF'

````markdown
```
## kit/v99.0.0 — 2026-02-01
````

~~~markdown
## kit/v98.0.0 — 2026-02-01
~~~

<!-- example heading
## kit/v97.0.0 — 2026-02-01
-->
EOF
    fi
    cat <<'EOF'
<pre>
## kit/v96.0.0 — 2026-02-01
</pre>

## kit/v2.0.0 — 2026-02-01

- **Product action:** Do not import this legacy Kit action.
EOF
    tail -n +4 "$kit/CHANGELOG.md"
  } > "$STATE/next-kit"
  mv "$STATE/next-kit" "$kit/CHANGELOG.md"
}
product_fixture() {
  fixture_kit "$1"
  kit=$repo
  mkdir -p "$kit/config/kit"
  cp "$ROOT/config/kit/zero-edit-zones.json" "$kit/config/kit/"
  if [[ ${2:-} == legacy ]]; then insert_legacy_kit_examples; fi
  git -C "$kit" add .
  git -C "$kit" commit -qm 'seed Kit ownership rules'
  initial_pin=$(git -C "$kit" rev-parse HEAD)

  repo="$STATE/product"
  git clone -q "$kit" "$repo"
  git -C "$repo" remote rename origin upstream
  export GITHUB_REPOSITORY=fixture/acme FIXTURE_BRANCH=release/acme
  mkdir -p "$repo/docs/product" "$repo/config/product"
  write_pin "$initial_pin"
  printf 'release:\n  component: acme\n' > "$repo/.dev/stack.yml"
  printf '# Changelog\n\n## Unreleased\n' > "$repo/$product_changelog"
  git -C "$repo" add .
  git -C "$repo" commit -qm 'bootstrap Product'
  product_bootstrap=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" switch -qc feature
  printf '# Product guide\n' > "$repo/docs/product/guide.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm 'add Product feature'
  printf '\n- **Product action:** Follow [the guide](guide.md).\n' >> "$repo/$product_changelog"
  git -C "$repo" add .
  git -C "$repo" commit -qm 'document pending Product changes'
  git -C "$repo" switch -q main
  git -C "$repo" merge -q --no-ff -m 'merge Product feature PR' feature
  fixture_origin
  git -C "$repo" push -q origin main
  source=$(git -C "$repo" rev-parse HEAD)
}
assert_first_product_base() {
  if ! invoke --dry-run --product || ! grep -Fq 'Base tag: None (first Product release)' "$STATE/out"; then
    fail 'expected Product proposal without a Kit base'
    return 1
  fi
  assert_no_product_count
}
assert_no_product_count() {
  reject_log 'Product integrations on main:' && reject_log 'Commits in range:'
}
assert_kit_move_fallback() {
  local old_pin=$1 new_pin=$2 reason=$3
  if ! invoke --dry-run --product; then
    fail 'expected a Product proposal with a Kit fallback'
    return 1
  fi
  awk '/^### Kit update$/ { found=1; next } found && /^## / { exit } found' \
    "$STATE/out" > "$STATE/kit-update"
  cat > "$STATE/expected-kit-update" <<EOF

Kit pin moved from \`$old_pin\` to \`$new_pin\`; $reason.

[Kit CHANGELOG](https://github.com/fixture/acme/blob/$new_pin/CHANGELOG.md)

EOF
  diff -u "$STATE/expected-kit-update" "$STATE/kit-update" ||
    fail 'expected only the exact Kit fallback and pinned changelog link'
}
assert_first_product_date() {
  invoke --dry-run --product && expect_log "## acme/v0.1.0 — $release_date"
}
assert_product_tree() {
  local prepared=$1 paths
  if ! paths=$(git --git-dir="$STATE/origin.git" diff-tree --no-commit-id --name-only -r "$prepared") ||
     [[ $paths != "$product_changelog" ]]; then
    fail "expected Product proposal to use only $product_changelog"
    return 1
  fi
  jq -e --arg path "$paths" '
    ([.protected_files[] | . == $path] + [.protected_prefixes[] as $prefix | $path | startswith($prefix)]) | all(. == false)
  ' "$repo/config/kit/zero-edit-zones.json" >/dev/null || fail 'proposal changed a protected path'
  cmp -s <(git --git-dir="$STATE/origin.git" show "$prepared:CHANGELOG.md") \
    <(git -C "$repo" show "$source:CHANGELOG.md") || fail 'expected byte-identical inherited Kit CHANGELOG.md'
}
assert_first_product_apply() {
  local prepared
  if ! apply --product "$@" || ! prepared=$(head 2>/dev/null); then
    fail 'expected a successful Product apply with a proposal branch'
    return 1
  fi
  assert_product_tree "$prepared"
}
publish_product_fixture() {
  git -C "$repo" fetch -q origin release/acme
  git -C "$repo" merge -q --no-ff -m "publish $1" FETCH_HEAD
  product_base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" tag -a "$1" -m "$1"
  git -C "$repo" push -q origin main ":refs/heads/$FIXTURE_BRANCH"
  source=$product_base
  rm "$STATE/pull"
  : > "$STATE/writes"
}
upgrade_product_fixture() {
  git -C "$repo" fetch -q --tags upstream
  upgraded_pin=$(git -C "$repo" rev-parse refs/remotes/upstream/main)
  git -C "$repo" merge -q --no-ff --no-commit "$@" "$upgraded_pin"
  write_pin "$upgraded_pin"
  source_commit 'merge Kit upgrade and record the new pin'
}
cutover_product_fixture() {
  product_fixture "$1"
  git -C "$kit" commit -qm 'old Kit maintenance one' --allow-empty
  git -C "$kit" commit -qm 'old Kit maintenance two' --allow-empty
  upgrade_product_fixture
  old_lineage_pin=$upgraded_pin
}
merge_unrelated_kit() {
  local kit_tree new_root
  kit_tree=$(git -C "$repo" rev-parse "$old_lineage_pin^{tree}")
  new_root=$(git -C "$repo" commit-tree "$kit_tree" -m 'seed independent Kit history')
  new_lineage_pin=$(git -C "$repo" commit-tree "$kit_tree" -p "$new_root" -m 'independent Kit update')
  # Both pins have the same Kit files. Keep the Product overlay when merging the independent history.
  git -C "$repo" merge -q -s ours --allow-unrelated-histories --no-ff --no-commit "$new_lineage_pin"
  write_pin "$new_lineage_pin"
  source_commit 'merge unrelated Kit and record the new pin'
  product_entries '- Keep shipping after the Kit lineage changes.'
}
assert_refused() {
  local message=$1
  shift
  if invoke "$@"; then fail "expected refusal: $message"; return 1; fi
  expect_log "$message"
}

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

# Move only the process clock; explicit Dates from a source committer stay real.
cat > "$tmp/clock.js" <<'JS'
const instant = Date.parse(process.env.FIXTURE_CLOCK);
globalThis.Date = new Proxy(Date, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [instant], newTarget);
  },
});
JS
before_midnight=2031-05-07T23:59:59Z
after_midnight=2031-05-08T00:00:01Z

product_fixture consumer
first_source=$source
kit_eligibility_step=$eligibility_step
product_workflow="$ROOT/docs/kit/templates/product-release-prepare.example.yml"
eligibility_step=$(read_eligibility_step "$product_workflow")
workflow_steps=$(bun --no-env-file -e '
  const workflow = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
  const job = workflow.jobs.prepare;
  const [checkout, eligibility, setup, plan, app, apply] = job.steps;
  const quote = String.fromCharCode(39);
  const eligible = `steps.eligible.outputs.sha != ${quote}${quote}`;
  const wantsWrite = `steps.proposal.outputs.write == ${quote}true${quote}`;
  const jobCondition =
    `(github.event_name == ${quote}workflow_dispatch${quote} && github.ref == ${quote}refs/heads/main${quote}) || ` +
    `(github.event.workflow_run.event == ${quote}push${quote} && github.event.workflow_run.head_branch == ${quote}main${quote} && ` +
    `github.event.workflow_run.conclusion == ${quote}success${quote})`;
  const {RELEASE_WRITE_TOKEN: writeToken, ...applyReadEnv} = apply.env;
  const onlyApplyGetsWriteToken = writeToken === "${{ steps.app.outputs.token }}" &&
    !JSON.stringify(workflow, (key, value) => value === apply.env ? applyReadEnv : value).includes("RELEASE_WRITE_TOKEN");
  const readPermissions = (actual, expected) =>
    Object.keys(actual).length === expected.length && expected.every(key => actual[key] === "read");
  if (job.if.replace(/\s+/g, " ").trim() !== jobCondition ||
      !readPermissions(workflow.permissions, ["contents"]) ||
      !readPermissions(job.permissions, ["contents", "actions", "pull-requests"]) ||
      !/^actions\/checkout@[0-9a-f]{40}$/.test(checkout.uses) ||
      checkout.with["fetch-depth"] !== 0 || checkout.with["fetch-tags"] !== true ||
      checkout.with["persist-credentials"] !== false ||
      eligibility.id !== "eligible" || eligibility.env.RELEASE_WRITE_TOKEN !== undefined ||
      !/^oven-sh\/setup-bun@[0-9a-f]{40}$/.test(setup.uses) || setup.if !== eligible ||
      plan.id !== "proposal" || plan.if !== eligible ||
      app.id !== "app" || app.if !== wantsWrite || apply.if !== wantsWrite ||
      !/^actions\/create-github-app-token@[0-9a-f]{40}$/.test(app.uses) ||
      app.with["client-id"] !== "${{ vars.CI_APP_ID }}" ||
      app.with["private-key"] !== "${{ secrets.CI_APP_PRIVATE_KEY }}" ||
      app.with["permission-contents"] !== "write" || app.with["permission-workflows"] !== "write" ||
      app.with["permission-pull-requests"] !== "write" ||
      !onlyApplyGetsWriteToken ||
      job.steps.length !== 6)
    throw new Error("Product workflow must verify eligibility and plan read-only before minting the write token");
  for (const [step, mode] of [[plan, "plan"], [apply, "apply"]]) {
    if (step.env.GH_TOKEN !== "${{ github.token }}" || step.env.SHA !== "${{ steps.eligible.outputs.sha }}" ||
        step.env.ELIGIBLE_GATES !== "${{ steps.eligible.outputs.gates }}" ||
        step.env.RELEASE_BOT_USER_ID !== "${{ vars.HEAD_AUTH_BOT_USER_ID }}")
      throw new Error(`Product ${mode} must use the eligible source and gates`);
  }
  console.log(JSON.stringify({gates: job.env.RELEASE_GATES, plan: plan.run, apply: apply.run}));
' "$product_workflow")
workflow_gates=$(jq -er '.gates' <<<"$workflow_steps")
[[ $workflow_gates == "${product_gates[1]} ${product_gates[3]} ${product_gates[5]}" ]]
mixed_gates="${product_gates[1]}"$'\n\n\t'"${product_gates[3]}"$'\v\f\r '"${product_gates[5]}"$'\n'
assert_bad_workflow_gates() {
  if RELEASE_GATES="$1" run_eligibility_step ''; then
    fail 'expected invalid workflow gate configuration to fail'
  fi
  expect_log "$2"
  [[ ! -e $STATE/eligible-output ]]
}
assert_bad_workflow_gates $'\n\t \v\f\r' '::error::RELEASE_GATES must list at least one workflow path'
assert_bad_workflow_gates '.github/workflows/ci.yml workflows/secret-scan.yml' \
  '::error::RELEASE_GATES requires .github/workflows/<name>.yml paths'
assert_bad_workflow_gates '.github/workflows/ci.yml .github/workflows/ci.yml' \
  '::error::duplicate RELEASE_GATES path: .github/workflows/ci.yml'
GH_TOKEN='' eligibility_step="$kit_eligibility_step" run_eligibility_step ''
expect_log 'Product tree; no Kit release preparation'
[[ ! -e $STATE/eligible-output ]]
mv "$repo/$inheritance_path" "$STATE/marker"
GH_TOKEN='' RELEASE_GATES="$workflow_gates" run_eligibility_step ''
expect_log 'not a Product tree'
[[ ! -e $STATE/eligible-output ]]
mv "$STATE/marker" "$repo/$inheritance_path"

# Default gate pair still permits a plan, but opting into Product CI requires
# current green push evidence for the third path in both the shell and CLI.
GITHUB_OUTPUT="$STATE/default-plan" invoke --plan --product
[[ $(cat "$STATE/default-plan") == 'write=true' ]]
RELEASE_GATES="$workflow_gates" run_eligibility_step ''
[[ ! -e $STATE/eligible-output ]]
apply --product "${product_gates[@]}"
assert_no_proposal
jq -n --arg sha "$source" --arg old "$product_bootstrap" '[{workflow_runs:[
  {id:1,path:".github/workflows/ci.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"},
  {id:2,path:".github/workflows/secret-scan.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"},
  {id:3,path:".github/workflows/product-ci.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"success"}
]},{workflow_runs:[
  {id:4,path:".github/workflows/product-ci.yml",head_sha:$sha,head_branch:"main",event:"push",conclusion:"failure"},
  {id:5,path:".github/workflows/product-ci.yml",head_sha:$sha,head_branch:"main",event:"pull_request",conclusion:"success"},
  {id:6,path:".github/workflows/product-ci.yml",head_sha:$old,head_branch:"main",event:"push",conclusion:"success"}
]}]' > "$STATE/runs"
RELEASE_GATES="$mixed_gates" run_eligibility_step ''
expect_log 'Not all release gates are green'
[[ ! -e $STATE/eligible-output ]]
apply --product "${product_gates[@]}"
expect_log 'required workflow gates are not all green'
assert_no_proposal
jq '.[1].workflow_runs[0].conclusion = "success"' "$STATE/runs" > "$STATE/green"
mv "$STATE/green" "$STATE/runs"
GITHUB_EVENT_PATH="$STATE/event.json"
jq -n --arg sha "$product_bootstrap" '{workflow_run:{head_sha:$sha,event:"push",head_branch:"main",conclusion:"success"}}' > "$GITHUB_EVENT_PATH"
export GITHUB_EVENT_PATH
GITHUB_EVENT_NAME=workflow_run RELEASE_GATES="$mixed_gates" run_eligibility_step ''
eligible_output=$(printf 'sha=%s\ngates=%s\n' "$source" "$workflow_gates")
[[ $(cat "$STATE/eligible-output") == "$eligible_output" ]]
rm "$STATE/eligible-output"
GITHUB_EVENT_NAME=workflow_dispatch RELEASE_GATES="$workflow_gates" run_eligibility_step "$product_bootstrap"
expect_log 'Requested source is not the current first-parent tip'
[[ ! -e $STATE/eligible-output ]]
GITHUB_EVENT_NAME=workflow_dispatch RELEASE_GATES="$workflow_gates" run_eligibility_step "$source"
[[ $(cat "$STATE/eligible-output") == "$eligible_output" ]]

# Execute both checked-in steps with the eligibility outputs and capture the
# command at the Bun boundary, preserving argument boundaries and extra calls.
eligible_sha=$(sed -n 's/^sha=//p' "$STATE/eligible-output")
eligible_gates=$(sed -n 's/^gates=//p' "$STATE/eligible-output")
mkdir "$STATE/workflow-bin"
cat > "$STATE/workflow-bin/bun" <<'BUN'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$0" "$@" >> "$BUN_ARGV"
BUN
chmod +x "$STATE/workflow-bin/bun"
for mode in plan apply; do
  step=$(jq -er --arg mode "$mode" '.[$mode]' <<<"$workflow_steps")
  (cd "$repo" && PATH="$STATE/workflow-bin:$PATH" BUN_ARGV="$STATE/$mode-argv" \
    SHA="$eligible_sha" ELIGIBLE_GATES="$eligible_gates" bash -e -c "$step") > "$STATE/out" 2>&1 ||
    fail "Product workflow $mode step failed"
  printf '%s\0' "$STATE/workflow-bin/bun" --no-env-file scripts/kit/release-prepare.ts \
    --product "--$mode" --sha "$source" "${product_gates[@]}" > "$STATE/expected-argv"
  cmp -s "$STATE/expected-argv" "$STATE/$mode-argv" ||
    fail "Product workflow $mode did not forward the exact release preparation arguments"
done
unset GITHUB_EVENT_PATH
assert_refused '--gate requires a .github/workflows/<name>.yml path' --plan --product --gate workflows/ci.yml
assert_refused 'duplicate --gate .github/workflows/ci.yml' --plan --product "${product_gates[@]}" --gate .github/workflows/ci.yml
assert_no_proposal
pass 'Product workflow is opt-in and gates the exact current main push with the newest runs for all three paths'

invoke --check-changelog --product
expect_log 'CHANGELOG grammar OK'
mv "$repo/$product_changelog" "$STATE/valid-product-changelog"
invoke --check-changelog --product
expect_log 'Product CHANGELOG.md is absent; skipped'
printf '# Changelog\n\n## Unreleased\n\n## kit/v0.1.0 — 2026-01-01\n' > "$repo/$product_changelog"
invoke --check-changelog
assert_refused 'expected canonical' --check-changelog --product
mv "$STATE/valid-product-changelog" "$repo/$product_changelog"
GH_TOKEN='' apply
expect_log 'Product tree; skipped'
assert_refused '--product requires config/product/inheritance.json' --dry-run --product --sha "$initial_pin"
pass 'check and prepare preserve the Kit skip and require Product opt-in and grammar'

assert_first_product_base
FIXTURE_CLOCK="$before_midnight" assert_first_product_date
cp "$STATE/out" "$STATE/proposal-before"
FIXTURE_CLOCK="$after_midnight" assert_first_product_date
cmp -s "$STATE/proposal-before" "$STATE/out"
expect_log "Kit baseline: \`$initial_pin\`"
expect_log "[kit/v0.1.0 — 2026-01-01](https://github.com/fixture/acme/blob/$initial_pin/CHANGELOG.md#kitv010--2026-01-01)"
expect_log "[the guide](https://github.com/fixture/acme/blob/$source/docs/product/guide.md)"
remote_tags > "$STATE/tags-before"
FIXTURE_CLOCK="$before_midnight" assert_first_product_apply "${product_gates[@]}"
prepared=$(head)
[[ $(git --git-dir="$STATE/origin.git" rev-list --parents -1 "$prepared") == "$prepared $source" ]]
[[ $(git --git-dir="$STATE/origin.git" show -s --format=%s "$prepared") == 'chore(release): acme/v0.1.0' ]]
git --git-dir="$STATE/origin.git" show "$prepared:$product_changelog" > "$STATE/prepared"
grep -Fxq "## acme/v0.1.0 — $release_date" "$STATE/prepared"
grep -Fxq -- '- **Product action:** Follow [the guide](guide.md).' "$STATE/prepared"
if grep -Fq '### Kit update' "$STATE/prepared"; then fail 'Kit update leaked into the Product changelog'; fi
cmp -s "$STATE/tags-before" <(remote_tags)
jq -e '.title == "chore(release): acme/v0.1.0" and (.body | contains("### Kit update\n\nKit baseline:"))' "$STATE/pull" >/dev/null
cp "$STATE/pull" "$STATE/pull-before"
GIT_TRACE2_EVENT="$STATE/rerun-trace" FIXTURE_CLOCK="$after_midnight" apply --product "${product_gates[@]}"
jq -se 'any(.[]; .event == "cmd_name") and all(.[] | select(.event == "cmd_name"); .name != "push")' "$STATE/rerun-trace" >/dev/null
[[ $(head) == "$prepared" && $(cat "$STATE/writes") == 'POST pulls' ]]
cmp -s "$STATE/pull-before" "$STATE/pull"
jq -e 'length == 0' "$STATE/comments" >/dev/null
pass 'first Product release edits only Product notes and is byte-identical across midnight with no repeat writes'

rm "$STATE/runs"
publish_product_fixture acme/v0.1.0
first_base=$product_base
git -C "$repo" tag -d acme/v0.1.0 >/dev/null
assert_refused 'Product base tag acme/v0.1.0 does not point to a commit' --apply --product
assert_no_proposal
git -C "$repo" tag -am 'first Product release' acme/v0.1.0 "$first_base"
git -C "$repo" tag acme/v0.0.9 "$product_bootstrap"

# Prepend in ascending version order to leave a strictly descending changelog.
for version in 1.11.1 11.1.1; do
  {
    printf '# Changelog\n\n## Unreleased\n\n'
    if [[ $version == 11.1.1 ]]; then
      printf '%s\n\n' '### [kit/v11.1.1 — 2026-02-01](CHANGELOG.md)'
    fi
    printf '## kit/v%s — 2026-02-01\n\n' "$version"
    printf '%s\n\n' "- Ordinary Kit note for $version."
    if [[ $version == 11.1.1 ]]; then printf '%s\n\n' '- **Product action:** Switch the Kit adapter.'; fi
    tail -n +5 "$kit/CHANGELOG.md"
  } > "$STATE/next-kit"
  mv "$STATE/next-kit" "$kit/CHANGELOG.md"
  git -C "$kit" add CHANGELOG.md
  git -C "$kit" commit -qm "publish Kit $version"
  git -C "$kit" tag "kit/v$version"
done
upgrade_product_fixture
printf 'additional Product functionality\n' >> "$repo/docs/product/guide.md"
source_commit 'ship the Product improvement'
second_action='- **Product action:** Register the Product endpoint.'
product_entries "$second_action"$'\n  Read [the guide](guide.md).'
assert_first_product_apply
prepared=$(head)
{
  printf '# Changelog\n\n## Unreleased\n\n## acme/v0.2.0 — %s\n\n%s\n  Read [the guide](guide.md).\n' \
    "$release_date" "$second_action"
  git -C "$repo" show "$first_base:$product_changelog" | tail -n +4
} > "$STATE/expected-product"
git --git-dir="$STATE/origin.git" show "$prepared:$product_changelog" > "$STATE/actual-product"
cmp -s "$STATE/expected-product" "$STATE/actual-product" ||
  fail 'second Product release did not preserve the exact changelog bytes'
jq -ej '.body | split("### Product actions\n\n")[1] | split("\n\n### Kit update\n")[0]' \
  "$STATE/pull" > "$STATE/actual-actions"
printf '%s\n  Read [the guide](https://github.com/fixture/acme/blob/%s/docs/product/guide.md).' \
  "$second_action" "$source" > "$STATE/expected-actions"
cmp -s "$STATE/expected-actions" "$STATE/actual-actions" ||
  fail 'expected byte-identical Product actions apart from the pinned link'
jq -r '.body' "$STATE/pull" > "$STATE/out"
expect_log 'Proposed tag: `acme/v0.2.0`'
expect_log "Base tag: \`acme/v0.1.0\` (\`$first_base\`)"
assert_no_product_count
expect_log '### Product actions'
expect_log '- **Product action:** Register the Product endpoint.'
awk '/^### Kit update$/ { found=1; next } found && /^## / { exit } found && NF' "$STATE/out" > "$STATE/kit-update"
cat > "$STATE/expected-kit-update" <<EOF
Kit updated from \`$initial_pin\` to \`$upgraded_pin\`.
- [kit/v11.1.1 — 2026-02-01](https://github.com/fixture/acme/blob/$upgraded_pin/CHANGELOG.md#kitv1111--2026-02-01-1)
  - **Product action:** Switch the Kit adapter.
- [kit/v1.11.1 — 2026-02-01](https://github.com/fixture/acme/blob/$upgraded_pin/CHANGELOG.md#kitv1111--2026-02-01-2)
  - No Product action
EOF
diff -u "$STATE/expected-kit-update" "$STATE/kit-update"
(unset GITHUB_REPOSITORY; invoke --dry-run --product)
expect_log '- kit/v11.1.1 — 2026-02-01'
reject_log 'https://github.com/'
pass 'strict same-day release headings take collision suffixes after a linked Kit topic'

publish_product_fixture acme/v0.2.0
second_pin=$upgraded_pin
git -C "$kit" commit -qm 'unreleased Kit maintenance' --allow-empty
upgrade_product_fixture
GITHUB_OUTPUT="$STATE/no-plan" invoke --plan --product
[[ ! -e $STATE/no-plan ]]
apply --product
assert_no_proposal
invoke --dry-run --product
expect_log 'No unreleased changes.'
pass 'Kit-only upgrade with no Product notes cannot generate a proposal'

product_entries '- Patch the Product endpoint.'
patch_source=$source
invoke --dry-run --product || fail 'expected a Product patch after the Kit-only upgrade'
expect_log 'Proposed tag: `acme/v0.2.1`'
expect_log 'no Kit release in range'

write_pin "$initial_pin"
source_commit 'rewind the Kit pin without changing Product notes'
assert_kit_move_fallback "$second_pin" "$initial_pin" 'not a forward update'
assert_no_proposal
pass 'rewinding a Kit pin reports a non-forward move and a link pinned to the rewound snapshot'

printf 'release:\n  component: kit\n' > "$repo/.dev/stack.yml"
source_commit 'try reusing the Kit component'
assert_refused 'Product release.component must differ from the inherited Kit component' --dry-run --product
printf 'release:\n  component: acme\n' > "$repo/.dev/stack.yml"
git -C "$kit" commit -qm 'unmerged Kit tip' --allow-empty
git -C "$repo" fetch -q upstream
unmerged_pin=$(git -C "$repo" rev-parse upstream/main)
for bad_pin in not-a-sha "$unmerged_pin"; do
  write_pin "$bad_pin"
  source_commit 'try an invalid inheritance pin'
  assert_refused 'invalid Product inheritance pin: expected a commit that is an ancestor of the source SHA' --dry-run --product
done
# The first source now proposes an already-published tag; select the unpublished patch source.
# Proposal modes must use that commit instead of the invalid current checkout.
invoke --dry-run --product --sha "$patch_source" || fail 'expected the selected Product source to stay valid'
expect_log "Source SHA: \`$patch_source\`"
expect_log 'Proposed tag: `acme/v0.2.1`'
assert_no_proposal
pass 'Product component and inheritance pin fail closed at the selected SHA'

cutover_product_fixture product-lineage-cutover
assert_first_product_base
expect_log "Kit baseline: \`$old_lineage_pin\`"
assert_first_product_apply
publish_product_fixture acme/v0.1.0
merge_unrelated_kit
assert_kit_move_fallback "$old_lineage_pin" "$new_lineage_pin" 'not a forward update'
assert_no_proposal
pass 'a cutover to unrelated Kit history reports a non-forward move despite identical Kit files'

product_fixture kit-component-change
# Both snapshots are valid for their own component. The same release version
# under the new component would look like an addition without the guard.
(cd "$kit" && bun --no-env-file "$script" --check-changelog)
assert_first_product_apply
publish_product_fixture acme/v0.1.0
printf 'release:\n  component: next-kit\n' > "$kit/.dev/stack.yml"
printf '# Changelog\n\n## Unreleased\n\n## next-kit/v0.1.0 — 2026-01-01\n\n- **Product action:** New component action.\n' \
  > "$kit/CHANGELOG.md"
(cd "$kit" && bun --no-env-file "$script" --check-changelog)
git -C "$kit" commit -qam 'change the Kit component without breaking the changelog grammar'
upgrade_product_fixture -X ours
product_entries '- Keep preparing Product notes after the Kit component changes.'
assert_kit_move_fallback "$initial_pin" "$upgraded_pin" 'Kit component changed'
assert_no_proposal
pass 'a forward move across different valid Kit components reports the change without listing releases'

product_fixture latin1-kit-changelog
assert_first_product_apply
publish_product_fixture acme/v0.1.0
# É in Latin-1 is a lone 0xC9 byte, not valid UTF-8.
printf '\n\n- \311tape Kit.\n' >> "$kit/CHANGELOG.md"
git -C "$kit" commit -qam 'record Kit notes containing a Latin-1 byte'
upgrade_product_fixture
product_entries '- Keep preparing Product notes when Kit notes are not UTF-8.'
assert_kit_move_fallback "$initial_pin" "$upgraded_pin" "Kit changelog at \`$upgraded_pin\` predates the strict grammar"
assert_no_proposal
pass 'invalid UTF-8 in a Kit snapshot falls back to the pinned changelog link'

for legacy_endpoint in old new; do
  if [[ $legacy_endpoint == old ]]; then
    product_fixture legacy-old legacy
    invoke --dry-run --product
    expect_log "Kit baseline: \`$initial_pin\`; Kit changelog at \`$initial_pin\` predates the strict grammar."
    expect_log "[Kit CHANGELOG](https://github.com/fixture/acme/blob/$initial_pin/CHANGELOG.md)"
    reject_log '- [kit/v'
    reject_log '- kit/v'
    reject_log 'Do not import this legacy Kit action.'
    legacy_pin=$initial_pin
  else
    product_fixture legacy-new
  fi
  assert_first_product_apply
  publish_product_fixture acme/v0.1.0
  if [[ $legacy_endpoint == old ]]; then
    git -C "$kit" show "$base:CHANGELOG.md" > "$kit/CHANGELOG.md"
  else
    insert_legacy_kit_examples raw-html-only
  fi
  git -C "$kit" commit -qam "upgrade Kit with the legacy changelog at the $legacy_endpoint pin"
  upgrade_product_fixture
  if [[ $legacy_endpoint == new ]]; then legacy_pin=$upgraded_pin; fi
  product_entries '- Keep preparing Product notes when the Kit changelog is legacy.'
  legacy_reason="Kit changelog at \`$legacy_pin\` predates the strict grammar"
  assert_kit_move_fallback "$initial_pin" "$upgraded_pin" "$legacy_reason"
  if [[ $legacy_endpoint == new ]]; then
    # Bypass only the Kit snapshot restriction, preserving parsed offsets.
    mutant kit-snapshot-html 'section = releaseSection(text, component)' \
      'section = releaseSection(text.replace(/<pre>[\s\S]*?<\/pre>/g, (block) => block.replace(/[^\n]/g, "x")), component)'
    killed kit-snapshot-html 'expected only the exact Kit fallback and pinned changelog link' \
      assert_kit_move_fallback "$initial_pin" "$upgraded_pin" "$legacy_reason"
    expect_log "- [kit/v2.0.0 — 2026-02-01](https://github.com/fixture/acme/blob/$upgraded_pin/CHANGELOG.md#kitv200--2026-02-01)"
    expect_log 'Do not import this legacy Kit action.'
    script="$ROOT/scripts/kit/release-prepare.ts"
  fi
  assert_no_proposal
done
pass 'legacy Kit Markdown at either pin yields only a plain notice and a pinned changelog link'

product_fixture inherited-product-tags
git -C "$repo" tag -am 'inherited tag with the Product component' acme/v9.0.0 "$initial_pin"
# Marker-bearing Product tags with no matching heading define no base,
# whether they are reachable or on a divergent branch.
git -C "$repo" switch -qc unrelated-release "$product_bootstrap"
git -C "$repo" commit -qm 'unrelated Product release' --allow-empty
git -C "$repo" tag -am 'unrelated marker-bearing Product tag' acme/v8.0.0
git -C "$repo" switch -q main
git -C "$repo" tag acme/v7.0.0 "$product_bootstrap"
assert_first_product_base
expect_log 'Proposed tag: `acme/v0.1.0`'
git -C "$repo" tag acme/v0.1.0 "$initial_pin"
GITHUB_OUTPUT="$STATE/collision-plan" \
  assert_refused 'tag acme/v0.1.0 already exists; will not prepare or move it' --plan --product
[[ ! -e $STATE/collision-plan ]]
printf '\n## acme/v9.0.0 — 2026-01-02\n\n- Heading with an inherited namesake tag.\n' \
  >> "$repo/$product_changelog"
source_commit 'record a Product heading with a tag from Kit'
GITHUB_OUTPUT="$STATE/unpublished-plan" \
  assert_refused 'Product base tag acme/v9.0.0 does not point to a Product commit' --plan --product
[[ ! -e $STATE/unpublished-plan ]]
assert_no_proposal
pass 'without a release heading neither unrelated Product tags nor Kit tags define the base; collisions and a Kit namesake at the newest heading fail closed'

product_fixture rewritten-product-release
printf '\n## acme/v0.1.0 — 2026-01-01\n\n- The older Product release is still reachable.\n' \
  >> "$repo/$product_changelog"
source_commit 'record the older Product release'
older_product_release=$source
git -C "$repo" tag -am 'older Product release' acme/v0.1.0
git -C "$repo" switch -qc release-topic
{
  command head -n 6 "$repo/$product_changelog"
  printf '\n## acme/v0.1.1 — 2026-01-02\n\n- The latest release survives in the changelog.\n'
  tail -n +7 "$repo/$product_changelog"
} > "$STATE/rewritten-changelog"
cp "$STATE/rewritten-changelog" "$repo/$product_changelog"
git -C "$repo" commit -qam 'publish the latest Product release on the old lineage'
tagged_product_release=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" switch -q main
cp "$STATE/rewritten-changelog" "$repo/$product_changelog"
source_commit 'replay the changelog on a rewritten main without the tagged commit'
assert_refused 'Product base tag acme/v0.1.1 does not point to a commit' --dry-run --product
# A tag which resolves to a blob is not a published Product base either.
git -C "$repo" tag acme/v0.1.1 "$(git -C "$repo" rev-parse "$source:$product_changelog")"
assert_refused 'Product base tag acme/v0.1.1 does not point to a commit' --dry-run --product
git -C "$repo" tag -d acme/v0.1.1 >/dev/null
git -C "$repo" tag -am 'latest Product release' acme/v0.1.1 "$tagged_product_release"
rewritten_diagnostic='Product base tag acme/v0.1.1 is not an ancestor of the source SHA'
assert_refused "$rewritten_diagnostic" --dry-run --product
GITHUB_OUTPUT="$STATE/rewritten-plan" assert_refused "$rewritten_diagnostic" --plan --product
[[ ! -e $STATE/rewritten-plan ]]
assert_refused "$rewritten_diagnostic" --apply --product
assert_no_proposal
mutant product-ancestral-tag-fallback 'if (!isAncestor(commit, sha))' \
  $'if (!isAncestor(commit, sha)) return baseAt(sha, tag.slice(0, tag.lastIndexOf("/v")))\n  if (false)'
killed product-ancestral-tag-fallback "expected refusal: $rewritten_diagnostic" \
  assert_refused "$rewritten_diagnostic" --dry-run --product
expect_log "Base tag: \`acme/v0.1.0\` (\`$older_product_release\`)"
expect_log 'Proposed tag: `acme/v0.2.0`'
script="$ROOT/scripts/kit/release-prepare.ts"
pass 'a missing, non-commit, or rewritten-away newest Product tag cannot fall back to an older release'

# Once merged, the same tag is an ancestor via the second parent and is valid.
git -C "$repo" merge -q --no-ff --no-commit release-topic
source_commit 'integrate the tagged lineage without putting it on first parent'
# A higher reachable tag without a heading must not replace the exact base.
git -C "$repo" tag acme/v9.0.0 "$older_product_release"
invoke --dry-run --product
expect_log "Base tag: \`acme/v0.1.1\` (\`$tagged_product_release\`)"
expect_log 'Proposed tag: `acme/v0.2.0`'
assert_no_product_count
assert_no_proposal
pass 'the exact newest Product heading selects a merged side-branch tag even with a higher reachable tag'

product_fixture mistagged-product-release
git -C "$repo" tag acme/v0.1.0 "$product_bootstrap"
printf '\n## acme/v0.1.0 — 2026-01-01\n\n- Released Product notes.\n' >> "$repo/$product_changelog"
source_commit 'record a release whose tag points at a pre-release Product ancestor'
base_heading_error="Product base tag acme/v0.1.0 target $product_changelog must have ## acme/v0.1.0 — 2026-01-01 as its newest released heading"
for mode in --dry-run --plan --apply; do
  GITHUB_OUTPUT="$STATE/mistagged-plan" assert_refused "$base_heading_error" "$mode" --product
  reject_log 'Proposed tag:'
  [[ ! -e $STATE/mistagged-plan ]]
  assert_no_proposal
done
mutant unchecked-product-base-heading 'assertProductBaseHeading(commit, component, heading)' ''
killed unchecked-product-base-heading "expected refusal: $base_heading_error" \
  assert_refused "$base_heading_error" --dry-run --product
expect_log 'Proposed tag: `acme/v0.2.0`'
script="$ROOT/scripts/kit/release-prepare.ts"
pass 'a Product base tag on a pre-release ancestor fails dry-run, plan and apply without writes'

product_fixture changed-product-heading
printf '\n## acme/v0.1.0 — 2026-01-02\n\n- Released Product notes.\n' >> "$repo/$product_changelog"
source_commit 'record the tagged heading with its original date'
git -C "$repo" tag acme/v0.1.0
printf '%s\n' '# Changelog' '' '## Unreleased' '' '- Pending Product notes.' '' \
  '## acme/v0.1.0 — 2026-01-01' '' '- Released Product notes.' > "$repo/$product_changelog"
source_commit 'change the date of the released heading'
assert_refused "$base_heading_error" --dry-run --product
assert_no_proposal
pass 'matching the Product release version alone does not allow a changed heading'

for bad_path in docs docs/product "$product_changelog"; do
  product_fixture "unsafe-product-${bad_path//\//-}"
  mv "$repo/$bad_path" "$STATE/real-path"
  ln -s "$STATE/real-path" "$repo/$bad_path"
  if [[ $bad_path == "$product_changelog" ]]; then
    diagnostic="$bad_path is not a regular file"
  else
    diagnostic="$bad_path is not a real directory"
  fi
  assert_refused "$diagnostic" --check-changelog --product
  source_commit "track a symlink at $bad_path"
  GITHUB_OUTPUT="$STATE/unsafe-plan" \
    assert_refused "$product_changelog is not a regular file" --plan --product
  [[ ! -e $STATE/unsafe-plan ]]
  assert_no_proposal
done
# A dangling leaf must not be confused with the absence of an optional changelog.
rm "$repo/$product_changelog"
ln -s "$STATE/missing-path" "$repo/$product_changelog"
assert_refused "$product_changelog is not a regular file" --check-changelog --product
rm "$repo/$product_changelog"
mkdir "$repo/$product_changelog"
cp "$STATE/real-path" "$repo/$product_changelog/notes.md"
source_commit 'track a directory instead of the Product changelog file'
GITHUB_OUTPUT="$STATE/unsafe-plan" \
  assert_refused "$product_changelog is not a regular file" --plan --product
[[ ! -e $STATE/unsafe-plan ]]
assert_no_proposal
pass 'Product path validation refuses symlinks, including parent directories, and bad tracked trees before writes'

product_fixture repaired-pin
assert_first_product_apply
publish_product_fixture acme/v0.1.0
product_entries '- Ship the Product fix.'
invoke --dry-run --product
reject_log '### Kit update'
write_pin "$product_bootstrap"
source_commit 'mistakenly record an existing Product commit as the Kit pin'
assert_refused 'Product inheritance pin must point at an inherited Kit or mirror tip' --dry-run --product
write_pin "$initial_pin"
source_commit 'restore the genuine Kit pin'
invoke --dry-run --product
expect_log 'Proposed tag: `acme/v0.1.1`'
reject_log '### Kit update'
assert_no_proposal
pass 'a current pin pointing at a Product commit is refused; restoring the genuine pin needs no Kit update'

product_fixture mutant-product
mutant product-path '${mode},${blob},${proposal.path}' '${mode},${blob},CHANGELOG.md'
killed product-path "expected Product proposal to use only $product_changelog" assert_first_product_apply
mutant runtime-date 'return new Date(Number(seconds) * 1_000).toISOString().slice(0, 10)' \
  'return new Date().toISOString().slice(0, 10)'
FIXTURE_CLOCK="$after_midnight" killed runtime-date "missing output: ## acme/v0.1.0 — $release_date" assert_first_product_date
mutant product-base 'productBaseAt(sha, component, section.headings[0])' 'baseAt(sha, product?.kitComponent ?? component)'
killed product-base 'expected Product proposal without a Kit base' assert_first_product_base

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

fixture mutant-skip-grammar
entries '> A forbidden quote' '- Omitted pending note'
mutant skip-grammar 'const kind = lineKind(content, previous, number)' \
  'const kind = content.startsWith("#") ? "heading" : "plain"'
killed skip-grammar 'expected invalid CHANGELOG grammar to stop preparation' assert_grammar_rejected 7 'HTML, blockquotes and tables'

fixture mutant-first-line-only
entries '- **Product action:** Set the header.' '  Restart the client.' '  Verify the response.'
printf '%s\n%s\n%s' '- **Product action:** Set the header.' '  Restart the client.' \
  '  Verify the response.' > "$STATE/action"
mutant first-line-only '.map((action) => text.slice(action.start, action.end))' \
  '.map((action) => text.slice(action.start, action.end).split(newline)[0])'
apply
killed first-line-only 'expected byte-identical Product action bullets apart from pinned destinations' assert_full_action

fixture mutant-strip-marker
entries '- **Product action:** [migration](#guide)' '  "title"'
printf '%s\n%s' '- **Product action:** [migration](#guide)' '  "title"' > "$STATE/action"
mutant strip-marker '.map((action) => text.slice(action.start, action.end))' \
  '.map((action) => "- " + text.slice(action.start + actionPrefix.length, action.end))'
apply
killed strip-marker 'expected byte-identical Product action bullets apart from pinned destinations' assert_full_action

fixture mutant-duplicate-unreleased
entries '- First change' '## Unreleased' '- **Product action:** Another change.'
mutant duplicate-unreleased "if (unreleased) grammarError(number, 'duplicate ## Unreleased heading')" \
  "if (unreleased) return unreleased"
killed duplicate-unreleased 'expected invalid CHANGELOG grammar to stop preparation' \
  assert_grammar_rejected 8 'duplicate ## Unreleased'

fixture mutant-noncanonical-release
entries '- First change' '## `kit/v0.1.1` — 2026-01-02'
mutant noncanonical-release 'const prefix = `## ${component}/v`' \
  'content = content.replaceAll(String.fromCharCode(96), ""); const prefix = `## ${component}/v`'
killed noncanonical-release 'expected invalid CHANGELOG grammar to stop preparation' \
  assert_grammar_rejected 8 'expected canonical'

fixture mutant-skip-link-rewrite
entries '- Read [the guide](docs/guide.md#first).'
mutant skip-link-rewrite 'if (!root) return text' 'if (true) return text'
assert_dry_run_link() {
  invoke --dry-run && expect_log "$1"
}
killed skip-link-rewrite 'missing output: - Read [the guide](https://' assert_dry_run_link \
  "- Read [the guide](https://github.com/fixture/kit/blob/$source/docs/guide.md#first)."

fixture mutant-rewrite-code-spans
entries '- Keep ``literal ` [example](docs/example.md)``.'
mutant rewrite-code-spans 'tokens.lastIndex = codeSpanEnd(line, marker, tokens.lastIndex, number)' \
  'if (root) break; tokens.lastIndex = codeSpanEnd(line, marker, tokens.lastIndex, number)'
killed rewrite-code-spans 'missing output: - Keep ``literal ` [example](docs/example.md)``.' \
  assert_dry_run_link '- Keep ``literal ` [example](docs/example.md)``.'

fixture mutant-drop-angle-rule
entries '- Keep <span title="[fake](docs/fake.md)">literal</span>.'
mutant drop-angle-rule "if (marker === '<')" \
  "if (marker === '<') return"
assert_doc_rejected() {
  if invoke --check-changelog; then fail 'doc gate accepted HTML outside inline code'; return 1; fi
  expect_log 'CHANGELOG.md line 7: < is not allowed outside inline code; write `a < b` or `<component>`'
}
killed drop-angle-rule 'doc gate accepted HTML outside inline code' assert_doc_rejected

fixture mutant-drop-empty-segment-rule
entries '- [Kit docs](docs/kit//README.md)'
mutant drop-empty-segment-rule "if (path.split('/').includes(''))" 'if (false)'
killed drop-empty-segment-rule 'expected invalid CHANGELOG grammar to stop preparation' \
  assert_grammar_rejected 7 'without doubled or trailing slashes'

script="$ROOT/scripts/kit/release-prepare.ts"
refresh_fixture mutant-no-post-push-wait
printf -- '- open\n%s open\n- open\n' "$previous_head" > "$STATE/pull-sequence"
mutant no-post-push-wait 'const current = this.waitForPullHead(pull, head)' \
  'const current = this.api<Pull>(`pulls/${pull.number}`); if (current.head.sha !== head) throw new Error("proposal changed")'
killed no-post-push-wait 'expected the lagging proposal refresh to succeed' assert_refresh

script="$ROOT/scripts/kit/release-prepare.ts"
refresh_fixture mutant-accept-third-head
printf -- '- open\n%s open\n%s open\n- open\n' "$previous_head" "$base" > "$STATE/pull-sequence"
mutant accept-third-head '(sha !== previous.head.sha && sha !== target)' 'false'
killed accept-third-head 'expected an unsafe or unsynced proposal refresh to stop' \
  assert_refresh_refused 'proposal changed; rerun release preparation' 3

script="$ROOT/scripts/kit/release-prepare.ts"
refresh_fixture mutant-accept-retargeted
printf -- '- open staging\n' > "$STATE/pull-sequence"
mutant accept-retargeted "current.base?.ref !== 'main' || current.base.repo?.full_name !== this.repo" 'false'
killed accept-retargeted 'expected an unsafe or unsynced proposal refresh to stop' assert_retarget_refused
