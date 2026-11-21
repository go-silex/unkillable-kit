#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
# shellcheck source=lib/hermetic-git.sh
source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
unset GITHUB_REPOSITORY
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/bun" <<'BUN'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$KIT_UPGRADE_TEST_LOG"
if [[ ${FAIL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then exit 1; fi
if [[ ${REAL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then
  exec bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts
fi
BUN
chmod +x "$tmp/bun"
export KIT_UPGRADE_BUN="$tmp/bun"
touch "$tmp/harness-sentinel"
export KIT_UPGRADE_HARNESS_SENTINEL="$tmp/harness-sentinel"
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid

fixture() {
  local name=$1
  dir="$tmp/$name"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir/seed/scripts/kit" "$dir/seed/config/kit" "$dir/seed/.github/workflows"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$dir/seed/scripts/kit/"
  printf '{"version":1,"kit_origin_allowlist":["kit"]}\n' > "$dir/seed/config/kit/zero-edit-zones.json"
  printf '{"packageManager":"bun@1.0"}\n' > "$dir/seed/package.json"
  echo lock > "$dir/seed/bun.lock"
  echo '# Changelog' > "$dir/seed/CHANGELOG.md"
  echo upstream-license > "$dir/seed/LICENSE"
  git -C "$dir/seed" init -q -b main
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm initial
  git clone -q --bare "$dir/seed" "$dir/upstream.git"
  git clone -q "$dir/upstream.git" "$dir/product"
  git -C "$dir/product" remote rename origin upstream
  git -C "$dir/product" remote add origin product
  mkdir -p "$dir/product/config/product"
  printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
  git -C "$dir/product" add .
  git -C "$dir/product" commit -qm product
}
advance() {
  echo updated > "$dir/seed/change"
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm update
  git -C "$dir/seed" push -q "$dir/upstream.git" main
}
run_upgrade() { (cd "$dir/product" && bash scripts/kit/kit-upgrade.sh "$@") >"$dir/out" 2>&1; }
pass() { echo "PASS: $1"; }


snapshot_git_state() {
  local dest=$1
  mkdir -p "$dest"
  git -C "$dir/product" status --porcelain > "$dest/status"
  git -C "$dir/product" for-each-ref > "$dest/refs"
  cp -f "$dir/product/.git/index" "$dest/index"
  git -C "$dir/product" count-objects -v > "$dest/objects"
  if [[ -e $dir/product/.git/FETCH_HEAD ]]; then
    cp -f "$dir/product/.git/FETCH_HEAD" "$dest/FETCH_HEAD"
    printf 'present
' > "$dest/FETCH_HEAD.state"
  else
    printf 'absent
' > "$dest/FETCH_HEAD.state"
  fi
}
assert_git_state_unchanged() {
  local before=$1
  snapshot_git_state "$dir/after-state"
  cmp -s "$before/status" "$dir/after-state/status"
  cmp -s "$before/refs" "$dir/after-state/refs"
  cmp -s "$before/index" "$dir/after-state/index"
  cmp -s "$before/objects" "$dir/after-state/objects"
  cmp -s "$before/FETCH_HEAD.state" "$dir/after-state/FETCH_HEAD.state"
  if [[ $(cat "$before/FETCH_HEAD.state") == present ]]; then
    cmp -s "$before/FETCH_HEAD" "$dir/after-state/FETCH_HEAD"
  fi
}
fixture kit
git -C "$dir/product" remote set-url origin kit
git -C "$dir/product" rm -q config/product/inheritance.json
git -C "$dir/product" commit -qm kit
if run_upgrade; then exit 1; fi
grep -q 'requires a product clone' "$dir/out"
pass 'kit mode refused'
fixture dirty
echo dirty >> "$dir/product/bun.lock"
if run_upgrade; then exit 1; fi
grep -q 'clean the working tree' "$dir/out"
pass 'dirty tree refused'
fixture current
run_upgrade
grep -q 'already up to date' "$dir/out"
pass 'already up to date'
fixture clean
advance
run_upgrade
[[ $(git -C "$dir/product" rev-list --parents -n 1 HEAD | wc -w) == 3 ]]
[[ $(git -C "$dir/product" show HEAD:config/product/inheritance.json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).upstreamCommit))') == $(git -C "$dir/seed" rev-parse HEAD) ]]
[[ -z $(git -C "$dir/product" status --porcelain) ]]
[[ $(cat "$KIT_UPGRADE_TEST_LOG") == $'install\nrun lock-ranges:check\nrun zero-edit' ]]
pass 'clean upgrade rewrites marker and commits'
fixture license
before_license=$(git -C "$dir/product" show HEAD:LICENSE)
echo changed-upstream-license > "$dir/seed/LICENSE"
advance
run_upgrade
[[ $(git -C "$dir/product" show HEAD:LICENSE) == "$before_license" ]]
[[ -z $(git -C "$dir/product" status --porcelain) ]]
pass 'LICENSE preserved when present and different'
fixture absent
git -C "$dir/seed" rm -q LICENSE
git -C "$dir/seed" commit -qm remove-license
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
git -C "$dir/product" merge -q --no-edit upstream/main
echo new-upstream-license > "$dir/seed/LICENSE"
advance
run_upgrade
if git -C "$dir/product" cat-file -e HEAD:LICENSE 2>/dev/null; then exit 1; fi
[[ ! -e "$dir/product/LICENSE" && -z $(git -C "$dir/product" status --porcelain) ]]
pass 'LICENSE kept absent'
fixture manager
printf '{"packageManager":"bun@2.0"}\n' > "$dir/seed/package.json"
advance
run_upgrade
grep -q 'packageManager moves' "$dir/out"
pass 'packageManager notice printed'
fixture token
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/ci.yml"
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && ! -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'establish the effective CI_APP_ID' "$dir/out"
pass 'create-github-app-token bump stops before merge'
fixture large-token
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/a.yml"
mkdir -p "$dir/product/.github/workflows"
for ((i=0; i<5000; i++)); do printf 'repository workflow padding %05d\n' "$i"; done > "$dir/product/.github/workflows/z.yml"
git -C "$dir/product" add .github/workflows/z.yml
git -C "$dir/product" commit -qm repository-workflow
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if run_upgrade; then exit 1; fi
grep -q 'establish the effective CI_APP_ID' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && ! -f "$dir/product/.git/MERGE_HEAD" ]]
pass 'large workflow diff still stops token bump'
fixture lock
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'merge remains open' "$dir/out"
pass 'lock-ranges failure leaves merge open without commit'

normalization_fixture() {
  dir="$tmp/$1"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir/seed"
  git -C "$ROOT" archive HEAD | tar -x -C "$dir/seed"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/check-lock-ranges.ts" "$dir/seed/scripts/kit/"
  node -e 'const fs=require("fs"), p=process.argv[1], s=fs.readFileSync(p,"utf8"); const t=s.replace(/  "trustedDependencies": \[\],\n/,""); if(t===s) process.exit(1); fs.writeFileSync(p,t)' "$dir/seed/bun.lock"
  git -C "$dir/seed" init -q -b main
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm initial
  git clone -q --bare "$dir/seed" "$dir/upstream.git"
  git clone -q "$dir/upstream.git" "$dir/product"
  git -C "$dir/product" remote rename origin upstream
  git -C "$dir/product" remote add origin product
  mkdir -p "$dir/product/config/product"
  printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
  git -C "$dir/product" add config/product/inheritance.json
  git -C "$dir/product" commit -qm product
}
normalization_fixture normalized-merge
cp "$ROOT/bun.lock" "$dir/seed/bun.lock"
advance
REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
git -C "$dir/product" show HEAD:bun.lock | cmp - "$ROOT/bun.lock"
pass 'upgrade validates normalized staged lock despite stale pre-merge HEAD'

normalization_fixture invalid-merge
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'bun.lock changes on install' "$dir/out"
pass 'upgrade rejects invalid staged normalization and leaves merge open'

normalization_fixture index-isolation
cp "$ROOT/bun.lock" "$dir/seed/bun.lock"
advance
git -C "$dir/product" fetch -q upstream
git -C "$dir/product" merge -q --no-ff --no-commit upstream/main
git -C "$dir/product" show HEAD:bun.lock > "$dir/product/bun.lock"
(cd "$dir/product" && bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts) >"$dir/out" 2>&1
git -C "$dir/product" add bun.lock
cp "$ROOT/bun.lock" "$dir/product/bun.lock"
if (cd "$dir/product" && bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts) >"$dir/out" 2>&1; then exit 1; fi
grep -q 'bun.lock changes on install' "$dir/out"
pass 'merge gate uses staged lock, not conflicting unstaged bytes'
fixture check
advance
git -C "$dir/product" fetch -q upstream
cached=$(git -C "$dir/product" rev-parse upstream/main)
echo later > "$dir/seed/later"
git -C "$dir/seed" add later && git -C "$dir/seed" commit -qm later
git -C "$dir/seed" push -q "$dir/upstream.git" main
before=$(git -C "$dir/product" rev-parse HEAD)
snapshot_git_state "$dir/before-check"
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
grep -q '^Pending commits: 1$' "$dir/out"
grep -qx "Kit CHANGELOG at the cached tip: git show ${cached}:CHANGELOG.md" "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" ]]
[[ $(git -C "$dir/product" rev-parse upstream/main) == "$cached" ]]
assert_git_state_unchanged "$dir/before-check"
pass '--check uses cached upstream without fetching or writing'

fixture check-report
git -C "$dir/seed" checkout -qb feature-one
echo one > "$dir/seed/one"
git -C "$dir/seed" add one
git -C "$dir/seed" commit -qm feature-one
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge first feature' feature-one
git -C "$dir/seed" checkout -qb feature-two
echo second > "$dir/seed/second"
git -C "$dir/seed" add second
git -C "$dir/seed" commit -qm feature-two
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge second feature' feature-two
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
tip=$(git -C "$dir/product" rev-parse upstream/main)
snapshot_git_state "$dir/before-report"
run_upgrade --check
grep -qx 'Pending commits: 4' "$dir/out"
[[ $(grep '^Merge .* feature$' "$dir/out") == $'Merge first feature\nMerge second feature' ]]
grep -qx "Kit CHANGELOG at the cached tip: git show ${tip}:CHANGELOG.md" "$dir/out"
assert_git_state_unchanged "$dir/before-report"
pass '--check reports pending merge subjects without writes'

fixture check-ref-shadow
advance
git -C "$dir/product" fetch -q upstream
tip=$(git -C "$dir/product" rev-parse refs/remotes/upstream/main)
# A local branch with the same short name must not stand in for the cached Kit tip.
git -C "$dir/product" branch upstream/main HEAD
run_upgrade --check
grep -qx 'Pending commits: 1' "$dir/out"
grep -qx "Kit CHANGELOG at the cached tip: git show ${tip}:CHANGELOG.md" "$dir/out"
pass '--check reads the remote-tracking ref, not a local branch of the same name'

fixture check-changelog-removed
git -C "$dir/seed" rm -q CHANGELOG.md
git -C "$dir/seed" commit -qm 'remove changelog'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
if grep -q '^Kit CHANGELOG at the cached tip' "$dir/out"; then exit 1; fi
pass '--check omits the CHANGELOG pointer when the tip has no CHANGELOG'

fixture check-changelog-not-file
git -C "$dir/seed" rm -q CHANGELOG.md
mkdir "$dir/seed/CHANGELOG.md"
echo entry > "$dir/seed/CHANGELOG.md/2026.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'changelog directory'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
if grep -q '^Kit CHANGELOG at the cached tip' "$dir/out"; then exit 1; fi
git -C "$dir/seed" rm -rq CHANGELOG.md
ln -s docs/news.md "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'changelog symlink'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
if grep -q '^Kit CHANGELOG at the cached tip' "$dir/out"; then exit 1; fi
pass '--check omits the CHANGELOG pointer when the tip entry is not a regular file'

fixture ref-decoy
advance
git -C "$dir/product" fetch -q upstream
# Fetch maps elsewhere and the canonical tracking ref is gone; a local branch named like it must not be used.
git -C "$dir/product" config remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/vendor/main'
git -C "$dir/product" update-ref -d refs/remotes/upstream/main
decoy=$(git -C "$dir/product" commit-tree 'HEAD^{tree}' -p HEAD -m 'unpublished local commit')
git -C "$dir/product" update-ref refs/heads/refs/remotes/upstream/main "$decoy"
before=$(git -C "$dir/product" rev-parse HEAD)
rc=0
run_upgrade --check || rc=$?
[[ $rc == 1 ]]
grep -q 'refs/remotes/upstream/main is missing' "$dir/out"
rc=0
run_upgrade || rc=$?
[[ $rc == 1 ]]
grep -q 'refs/remotes/upstream/main is missing' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" ]]
[[ ! -f $dir/product/.git/MERGE_HEAD ]]
pass 'a local branch named like the tracking ref is never merged or pinned'

fixture check-missing-tree
advance
git -C "$dir/upstream.git" config uploadpack.allowFilter true
base=$(git -C "$dir/seed" rev-parse HEAD^)
# Clone onto the base branch: checking out from the tip would read (and fetch) the tip tree.
git -C "$dir/seed" push -q "$dir/upstream.git" "$base:refs/heads/base"
rm -rf "$dir/product"
git clone -q --filter=tree:0 --branch base "file://$dir/upstream.git" "$dir/product"
git -C "$dir/product" remote rename origin upstream
git -C "$dir/product" remote add origin product
mkdir -p "$dir/product/config/product"
printf '{"version":1,"upstreamCommit":"%s"}\n' "$base" > "$dir/product/config/product/inheritance.json"
git -C "$dir/product" add config/product/inheritance.json
git -C "$dir/product" commit -qm product
# The tip commit is local but its root tree is not; --check must not fetch it.
if GIT_NO_LAZY_FETCH=1 git -C "$dir/product" cat-file -e "$(git -C "$dir/seed" rev-parse 'HEAD^{tree}')" 2>/dev/null; then exit 1; fi
packs_before=$(find "$dir/product/.git/objects/pack" -type f | sort)
rc=0
run_upgrade --check || rc=$?
[[ $rc == 1 ]]
grep -q 'objects the preflight needs are not available locally' "$dir/out"
if grep -q 'do not restart an open merge' "$dir/out"; then exit 1; fi
[[ $packs_before == "$(find "$dir/product/.git/objects/pack" -type f | sort)" ]]
pass '--check stops clearly when the cached tip tree is not local'

fixture check-caps
for ((i=1; i<=51; i++)); do
  git -C "$dir/seed" checkout -qb "cap-$i"
  echo "cap-$i" > "$dir/seed/cap-$i"
  git -C "$dir/seed" add "cap-$i"
  git -C "$dir/seed" commit -qm "cap-$i"
  git -C "$dir/seed" checkout -q main
  git -C "$dir/seed" merge -q --no-ff -m "Merge cap $i" "cap-$i"
done
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
merges=$(awk '/^First-parent merge subjects/{p=1;next} /^Kit CHANGELOG|^upgrade pending|^shallow|^pending range/{p=0} p' "$dir/out")
[[ $(printf '%s\n' "$merges" | grep -c '^Merge cap ') == 50 ]]
[[ $(printf '%s\n' "$merges" | tail -n1) == '… 1 more' ]]
pass '--check caps merge subjects at 50'

fixture check-second-parent
git -C "$dir/seed" checkout -qb feature
echo feature > "$dir/seed/feature"
git -C "$dir/seed" add feature
git -C "$dir/seed" commit -qm feature
git -C "$dir/seed" checkout -qb feature-side
echo side > "$dir/seed/side"
git -C "$dir/seed" add side
git -C "$dir/seed" commit -qm side
git -C "$dir/seed" checkout -q feature
git -C "$dir/seed" merge -q --no-ff -m 'Merge side into feature' feature-side
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge feature' feature
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -qx 'Merge feature' "$dir/out"
if grep -q 'Merge side into feature' "$dir/out"; then exit 1; fi
pass '--check lists only first-parent merges'

fixture check-multi-base
base=$(git -C "$dir/seed" rev-parse HEAD)
git -C "$dir/seed" checkout -qb tip-a
echo a > "$dir/seed/a-file"
git -C "$dir/seed" add a-file
git -C "$dir/seed" commit -qm tip-a
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge tip A' tip-a
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
git -C "$dir/product" merge -q --no-edit upstream/main
printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse upstream/main)" > "$dir/product/config/product/inheritance.json"
git -C "$dir/product" add config/product/inheritance.json
git -C "$dir/product" commit -qm 'pin after A'
git -C "$dir/seed" checkout -qb tip-b "$base"
echo b > "$dir/seed/b-file"
git -C "$dir/seed" add b-file
git -C "$dir/seed" commit -qm tip-b
tip_b=$(git -C "$dir/seed" rev-parse tip-b)
git -C "$dir/seed" push -q "$dir/upstream.git" "tip-b:tip-b"
git -C "$dir/product" fetch -q upstream tip-b
git -C "$dir/product" merge -q --no-edit FETCH_HEAD
printf '{"version":1,"upstreamCommit":"%s"}\n' "$tip_b" > "$dir/product/config/product/inheritance.json"
git -C "$dir/product" add config/product/inheritance.json
git -C "$dir/product" commit -qm 'merged B into product'
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge tip B' tip-b
echo join > "$dir/seed/join"
git -C "$dir/seed" add join
git -C "$dir/seed" commit -qm 'kit join follow-up'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
if grep -q 'Merge tip A' "$dir/out"; then exit 1; fi
grep -q '^Pending commits:' "$dir/out"
pass '--check excludes already-inherited merge-base side history'

fixture check-unrelated
git -C "$dir/seed" checkout --orphan unrelated
git -C "$dir/seed" rm -rfq .
echo unrelated > "$dir/seed/only"
git -C "$dir/seed" add only
git -C "$dir/seed" commit -qm unrelated-root
git -C "$dir/seed" branch -M main
git -C "$dir/seed" push -qf "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
grep -q '^Pending commits:' "$dir/out"
if grep -q 'do not restart an open merge' "$dir/out"; then exit 1; fi
pass '--check reports unrelated histories without ERR trap'

fixture check-shallow
advance
git -C "$dir/seed" push -q "$dir/upstream.git" main
rm -rf "$dir/product"
git clone -q --depth 1 "file://$dir/upstream.git" "$dir/product"
git -C "$dir/product" remote rename origin upstream
git -C "$dir/product" remote add origin product
mkdir -p "$dir/product/config/product"
printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
git -C "$dir/product" add config/product/inheritance.json
git -C "$dir/product" commit -qm product
echo shallow-later > "$dir/seed/shallow-later"
git -C "$dir/seed" add shallow-later
git -C "$dir/seed" commit -qm shallow-later
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q --depth 1 upstream main
[[ $(git -C "$dir/product" rev-parse --is-shallow-repository) == true ]]
run_upgrade --check
grep -q 'shallow clone: pending range not reported' "$dir/out"
if grep -q '^Pending commits:' "$dir/out"; then exit 1; fi
pass '--check skips the report on a shallow clone'

fixture check-unreadable
advance
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
mkdir -p "$dir/bin"
real_git=$(command -v git)
cat > "$dir/bin/git" <<EOF
#!/usr/bin/env bash
if [[ \$1 == rev-list && \$* == *--count* ]]; then
  echo 'fatal: revision walk setup failed' >&2
  exit 128
fi
if [[ \$1 == log && \$* == *--first-parent* && \$* == *--merges* ]]; then
  echo 'fatal: revision walk setup failed' >&2
  exit 128
fi
exec "$real_git" "\$@"
EOF
chmod +x "$dir/bin/git"
PATH="$dir/bin:$PATH" run_upgrade --check
grep -q 'pending range not readable from local history' "$dir/out"
grep -q 'upgrade pending' "$dir/out"
if grep -q '^Pending commits:' "$dir/out"; then exit 1; fi
grep -q '^Kit CHANGELOG at the cached tip: git show ' "$dir/out"
if grep -q 'do not restart an open merge' "$dir/out"; then exit 1; fi
pass '--check reports an unreadable pending range without ERR'

fixture check-status-fail
advance
git -C "$dir/product" fetch -q upstream
# A status failure (e.g. a blob a sparse blobless clone cannot read offline) must not pass as clean.
mkdir -p "$dir/bin"
real_git=$(command -v git)
cat > "$dir/bin/git" <<EOF
#!/usr/bin/env bash
if [[ \$1 == status ]]; then
  echo 'fatal: unable to read tree' >&2
  exit 128
fi
exec "$real_git" "\$@"
EOF
chmod +x "$dir/bin/git"
rc=0
PATH="$dir/bin:$PATH" run_upgrade --check || rc=$?
[[ $rc == 1 ]]
grep -q 'cannot read the working tree state' "$dir/out"
if grep -q 'upgrade pending' "$dir/out"; then exit 1; fi
pass '--check fails closed when git status cannot read the tree'

fixture check-textconv
# The pending range changes package.json, so the preflight diff reads it through the textconv driver.
printf '{"packageManager":"bun@1.0","name":"kit"}\n' > "$dir/seed/package.json"
git -C "$dir/seed" add package.json
git -C "$dir/seed" commit -qm 'pending change for textconv'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
mkdir -p "$dir/product/.git/info"
printf 'package.json diff=manifest\n' > "$dir/product/.git/info/attributes"
git -C "$dir/product" config diff.manifest.textconv cat
git -C "$dir/product" config diff.manifest.cachetextconv true
snapshot_git_state "$dir/before-textconv"
run_upgrade --check
if git -C "$dir/product" for-each-ref 'refs/notes/textconv/*' | grep -q .; then exit 1; fi
assert_git_state_unchanged "$dir/before-textconv"
pass '--check skips textconv and writes no textconv notes'

fixture check-token-tip
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/ci.yml"
git -C "$dir/seed" add .github/workflows/ci.yml
git -C "$dir/seed" commit -qm 'token pin tip'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
if run_upgrade --check; then exit 1; fi
grep -q 'establish the effective CI_APP_ID' "$dir/out"
if grep -q '^Pending commits:' "$dir/out"; then exit 1; fi
pass '--check uses captured tip for token-pin notice'

fixture check-sticky-tip
echo tip-a > "$dir/seed/tip-a"
git -C "$dir/seed" add tip-a
git -C "$dir/seed" commit -qm 'tip A'
git -C "$dir/seed" push -q "$dir/upstream.git" main
tip_a=$(git -C "$dir/seed" rev-parse HEAD)
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/ci.yml"
echo tip-b > "$dir/seed/tip-b"
git -C "$dir/seed" add .github/workflows/ci.yml tip-b
git -C "$dir/seed" commit -qm 'tip B token'
git -C "$dir/seed" push -q "$dir/upstream.git" main
tip_b=$(git -C "$dir/seed" rev-parse HEAD)
git -C "$dir/product" fetch -q upstream
# Start with the cached tip at A; after tip capture, advance the live tracking ref to B.
git -C "$dir/product" update-ref refs/remotes/upstream/main "$tip_a"
mkdir -p "$dir/bin"
real_git=$(command -v git)
cat > "$dir/bin/git" <<EOF
#!/usr/bin/env bash
if [[ -f \$KIT_UPGRADE_TIP_FLIP && ! -f \$KIT_UPGRADE_TIP_FLIPPED ]]; then
  touch "\$KIT_UPGRADE_TIP_FLIPPED"
  "$real_git" -C "$dir/product" update-ref refs/remotes/upstream/main "$tip_b"
fi
if [[ \$* == *upstream/main* && ! -f \$KIT_UPGRADE_TIP_FLIP ]]; then
  touch "\$KIT_UPGRADE_TIP_FLIP"
fi
exec "$real_git" "\$@"
EOF
chmod +x "$dir/bin/git"
export KIT_UPGRADE_TIP_FLIP="$dir/tip-flip" KIT_UPGRADE_TIP_FLIPPED="$dir/tip-flipped"
rm -f "$KIT_UPGRADE_TIP_FLIP" "$KIT_UPGRADE_TIP_FLIPPED"
PATH="$dir/bin:$PATH" run_upgrade --check
grep -qx 'Pending commits: 1' "$dir/out"
grep -qx "Kit CHANGELOG at the cached tip: git show ${tip_a}:CHANGELOG.md" "$dir/out"
if grep -q 'establish the effective CI_APP_ID' "$dir/out"; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse upstream/main) == "$tip_b" ]]
pass '--check keeps the tip captured before preflight'

fixture check-current
run_upgrade --check
[[ $(cat "$dir/out") == 'already up to date with upstream/main' ]]
pass '--check leaves current output unchanged'

fixture missing-upstream
git -C "$dir/product" remote remove upstream
if run_upgrade --check; then exit 1; fi
pass 'check refuses missing upstream'
fixture sentinel
before=$(git -C "$dir/product" rev-parse HEAD)
if (unset KIT_UPGRADE_HARNESS_SENTINEL; run_upgrade); then exit 1; fi
grep -q 'requires a test harness sentinel' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -z $(git -C "$dir/product" status --porcelain) ]]
pass 'override without sentinel refused without writes'
fixture merge
git -C "$dir/product" rev-parse HEAD > "$dir/product/.git/MERGE_HEAD"
if run_upgrade; then exit 1; fi
grep -q 'finish any in-progress merge' "$dir/out"
[[ -f "$dir/product/.git/MERGE_HEAD" ]]
pass 'in-progress merge refused'
