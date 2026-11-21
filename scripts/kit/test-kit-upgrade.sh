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
if grep -q 'CHANGELOG.md additions:' "$dir/out"; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" ]]
[[ $(git -C "$dir/product" rev-parse upstream/main) == "$cached" ]]
assert_git_state_unchanged "$dir/before-check"
pass '--check uses cached upstream without fetching or writing'

fixture check-report
git -C "$dir/seed" checkout -qb feature-one
printf '# Changelog\n\n## Unreleased\n\n- First pending change\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
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
snapshot_git_state "$dir/before-report"
run_upgrade --check
grep -qx 'Pending commits: 4' "$dir/out"
grep -qx -- '- First pending change' "$dir/out"
[[ $(grep '^Merge .* feature$' "$dir/out") == $'Merge first feature\nMerge second feature' ]]
assert_git_state_unchanged "$dir/before-report"
pass '--check reports pending merge subjects and Kit CHANGELOG additions without writes'

fixture check-caps
{
  for ((i=1; i<=51; i++)); do printf -- '- Cap line %02d\n' "$i"; done
} > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm changelog-caps
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
merges=$(awk '/^First-parent merge subjects/{p=1;next} /^CHANGELOG|^upgrade pending|^shallow/{p=0} p' "$dir/out")
[[ $(printf '%s\n' "$merges" | grep -c '^Merge cap ') == 50 ]]
[[ $(printf '%s\n' "$merges" | tail -n1) == '… 1 more' ]]
adds=$(awk '/^CHANGELOG.md additions:/{p=1;next} /^upgrade pending|^shallow/{p=0} p' "$dir/out")
[[ $(printf '%s\n' "$adds" | grep -c '^- Cap line ') == 50 ]]
[[ $(printf '%s\n' "$adds" | tail -n1) == '… 1 more' ]]
pass '--check caps merge subjects and CHANGELOG lines at 50'

fixture check-second-parent
git -C "$dir/seed" checkout -qb feature
echo feature > "$dir/seed/feature"
git -C "$dir/seed" add feature
git -C "$dir/seed" commit -qm feature
git -C "$dir/seed" checkout -qb feature-side
echo side > "$dir/seed/side"
git -C "$dir/seed" add side
git -C "$dir/seed" commit -qm side
printf '%s\n' '- Side-only changelog' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'side changelog'
git -C "$dir/seed" checkout -q feature
# ours-merge keeps Side-only out of the first-parent result while retaining the side commit.
git -C "$dir/seed" merge -q -s ours --no-ff -m 'Merge side into feature' feature-side
git -C "$dir/seed" checkout -q main
git -C "$dir/seed" merge -q --no-ff -m 'Merge feature' feature
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
grep -qx 'Merge feature' "$dir/out"
if grep -q 'Merge side into feature' "$dir/out"; then exit 1; fi
if grep -q 'Side-only changelog' "$dir/out"; then exit 1; fi
pass '--check lists only first-parent merges and CHANGELOG patches'

fixture check-multi-base
base=$(git -C "$dir/seed" rev-parse HEAD)
git -C "$dir/seed" checkout -qb tip-a
printf '# Changelog\n\n## Unreleased\n\n- already inherited A\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
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
if grep -q -- '- already inherited A' "$dir/out"; then exit 1; fi
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

fixture check-product-edit
printf '# Changelog\n\n## Unreleased\n\n- shared line\n- kit only old\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'kit changelog base'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
git -C "$dir/product" merge -q --no-edit upstream/main
printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse upstream/main)" > "$dir/product/config/product/inheritance.json"
printf '# Changelog\n\n## Unreleased\n\n- product rewrite\n- shared line\n- product only\n' > "$dir/product/CHANGELOG.md"
git -C "$dir/product" add CHANGELOG.md config/product/inheritance.json
git -C "$dir/product" commit -qm 'product edits changelog'
printf '# Changelog\n\n## Unreleased\n\n- shared line\n- kit only old\n- shared line\n- kit new line\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'kit adds shared and new'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
adds=$(awk '/^CHANGELOG.md additions:/{p=1;next} /^upgrade pending|^shallow/{p=0} p' "$dir/out")
[[ $(printf '%s\n' "$adds") == $'- shared line\n- kit new line' ]]
if grep -q 'product rewrite\|product only\|kit only old' "$dir/out"; then exit 1; fi
pass '--check reports Kit CHANGELOG additions ignoring Product edits'

fixture check-dup-bullet
printf '# Changelog\n\n## Unreleased\n\n- once\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'changelog once'
printf '# Changelog\n\n## Unreleased\n\n- once\n- once\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'changelog twice'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
run_upgrade --check
adds=$(awk '/^CHANGELOG.md additions:/{p=1;next} /^upgrade pending|^shallow/{p=0} p' "$dir/out")
# first commit adds headers + once; second adds one more once — expect two '- once' from the range patches
[[ $(printf '%s\n' "$adds" | grep -c '^- once$') == 2 ]]
pass '--check prints repeated identical Kit bullets twice'

fixture check-textconv
printf '# Changelog\n\n## Unreleased\n\n- textconv line\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'changelog for textconv'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
mkdir -p "$dir/product/.git"
printf 'CHANGELOG.md diff=readme\npackage.json diff=manifest\n' > "$dir/product/.git/info/attributes"
git -C "$dir/product" config diff.readme.textconv cat
git -C "$dir/product" config diff.readme.cachetextconv true
git -C "$dir/product" config diff.manifest.textconv cat
git -C "$dir/product" config diff.manifest.cachetextconv true
snapshot_git_state "$dir/before-textconv"
run_upgrade --check
if git -C "$dir/product" for-each-ref 'refs/notes/textconv/*' | grep -q .; then exit 1; fi
assert_git_state_unchanged "$dir/before-textconv"
grep -qx -- '- textconv line' "$dir/out"
pass '--check skips textconv and writes no textconv notes'

fixture check-token-tip
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/ci.yml"
printf '# Changelog\n\n## Unreleased\n\n- with token pin\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add .github/workflows/ci.yml CHANGELOG.md
git -C "$dir/seed" commit -qm 'token pin tip'
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
if run_upgrade --check; then exit 1; fi
grep -q 'establish the effective CI_APP_ID' "$dir/out"
if grep -q '^Pending commits:' "$dir/out"; then exit 1; fi
pass '--check uses captured tip for token-pin notice'

fixture check-sticky-tip
printf '# Changelog\n\n## Unreleased\n\n- tip A line\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'tip A'
git -C "$dir/seed" push -q "$dir/upstream.git" main
tip_a=$(git -C "$dir/seed" rev-parse HEAD)
printf '# Changelog\n\n## Unreleased\n\n- tip A line\n- tip B only\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm 'tip B'
git -C "$dir/seed" push -q "$dir/upstream.git" main
tip_b=$(git -C "$dir/seed" rev-parse HEAD)
git -C "$dir/product" fetch -q upstream
# Point the cached tip at A while keeping B reachable for a mid-check re-resolve.
git -C "$dir/product" update-ref refs/remotes/upstream/main "$tip_a"
mkdir -p "$dir/bin"
real_git=$(command -v git)
cat > "$dir/bin/git" <<EOF
#!/usr/bin/env bash
if [[ \$1 == rev-parse && \$2 == upstream/main ]]; then
  if [[ -f \$KIT_UPGRADE_TIP_FLIP ]]; then
    exec "$real_git" rev-parse "$tip_b"
  fi
  printf '%s\\n' "$tip_a" > "\$KIT_UPGRADE_TIP_FLIP"
  exec "$real_git" rev-parse "$tip_a"
fi
exec "$real_git" "\$@"
EOF
chmod +x "$dir/bin/git"
export KIT_UPGRADE_TIP_FLIP="$dir/tip-flipped"
rm -f "$KIT_UPGRADE_TIP_FLIP"
PATH="$dir/bin:$PATH" run_upgrade --check
grep -qx 'Pending commits: 1' "$dir/out"
grep -qx -- '- tip A line' "$dir/out"
if grep -q 'tip B only' "$dir/out"; then exit 1; fi
pass '--check keeps the tip captured before preflight'

fixture check-blobless
base=$(git -C "$dir/seed" rev-parse HEAD)
printf '# Changelog\n\n## Unreleased\n\n- Offline blob line\n' > "$dir/seed/CHANGELOG.md"
git -C "$dir/seed" add CHANGELOG.md
git -C "$dir/seed" commit -qm offline-changelog
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/upstream.git" config uploadpack.allowFilter true
rm -rf "$dir/product"
git clone -q --filter=blob:none --no-checkout "file://$dir/upstream.git" "$dir/product"
git -C "$dir/product" remote rename origin upstream
git -C "$dir/product" remote add origin product
git -C "$dir/product" checkout -q "$base"
mkdir -p "$dir/product/config/product"
printf '{"version":1,"upstreamCommit":"%s"}\n' "$base" > "$dir/product/config/product/inheritance.json"
git -C "$dir/product" add config/product/inheritance.json
git -C "$dir/product" commit -qm product
packs_before=$(find "$dir/product/.git/objects/pack" -type f | sort)
snapshot_git_state "$dir/before-blobless"
git -C "$dir/product" ls-tree --name-only upstream/main -- CHANGELOG.md | grep -qx CHANGELOG.md
if GIT_NO_LAZY_FETCH=1 git -C "$dir/product" cat-file -e upstream/main:CHANGELOG.md 2>/dev/null; then exit 1; fi
run_upgrade --check
grep -q 'CHANGELOG.md history not available offline' "$dir/out"
if grep -q 'do not restart an open merge' "$dir/out"; then exit 1; fi
packs_after=$(find "$dir/product/.git/objects/pack" -type f | sort)
[[ $packs_before == "$packs_after" ]]
assert_git_state_unchanged "$dir/before-blobless"
pass '--check stays offline for a blobless CHANGELOG'

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
