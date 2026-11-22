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
  local sha=${1:-} status=${2:-open} base_ref=${3:-main} base_repo=${4:-fixture/kit}
  if [[ -z $sha ]]; then sha=$(ref refs/heads/release/kit); fi
  jq --arg sha "$sha" --arg status "$status" --arg base_ref "$base_ref" --arg base_repo "$base_repo" \
    '.state = $status
    | .head = {sha:$sha,ref:"release/kit",repo:{full_name:"fixture/kit"}}
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
  'GET git/matching-refs/heads/release/kit')
    if head=$(ref refs/heads/release/kit 2>/dev/null); then
      jq -n --arg sha "$head" '[{ref:"refs/heads/release/kit",object:{sha:$sha}}]'
    else echo '[]'; fi ;;
  'GET pulls?'*)
    if [[ -f $STATE/pull ]]; then
      stale=''
      if [[ -f $STATE/list-sha ]]; then stale=$(cat "$STATE/list-sha"); fi
      show_pull "$stale" | jq '[[.]]'
    else echo '[[]]'; fi ;;
  'GET pulls/7') show_pull_detail ;;
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
    printf '\n### Consumer changes\n\n'
    printf '%s\n' "$@"
    printf '\n'
  } > "$STATE/notes"
  printf '# Changelog\n\n## Unreleased\n' > "$repo/CHANGELOG.md"
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
  actual_header=$(awk '/^## kit\/v/{ print; exit }' "$STATE/actual")
  printf '# Changelog\n\n## Unreleased\n\n## kit/%s — %s\n' "$tag" "$(date -u +%F)" > "$STATE/expected"
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

fixture mutant-skip-grammar
entries '> A forbidden quote' '- Omitted pending note'
mutant skip-grammar 'const kind = lineKind(content, previous, number)' \
  'const kind = content.startsWith("#") ? "heading" : "plain"'
killed skip-grammar 'expected invalid CHANGELOG grammar to stop preparation' assert_grammar_rejected 7 'HTML, blockquotes and tables'

fixture mutant-first-line-only
entries '- **Product action:** Set the header.' '  Restart the client.' '  Verify the response.'
printf '%s\n%s\n%s' '- **Product action:** Set the header.' '  Restart the client.' \
  '  Verify the response.' > "$STATE/action"
mutant first-line-only 'text.slice(action.start, action.end)' \
  'text.slice(action.start, action.end).split(newline)[0]'
apply
killed first-line-only 'expected byte-identical Product action bullets apart from pinned destinations' assert_full_action

fixture mutant-strip-marker
entries '- **Product action:** [migration](#guide)' '  "title"'
printf '%s\n%s' '- **Product action:** [migration](#guide)' '  "title"' > "$STATE/action"
mutant strip-marker 'text.slice(action.start, action.end)' \
  '"- " + text.slice(action.start + actionPrefix.length, action.end)'
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
