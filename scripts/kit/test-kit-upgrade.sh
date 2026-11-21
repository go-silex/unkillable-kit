#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
# shellcheck source=lib/hermetic-git.sh
source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
unset GITHUB_REPOSITORY
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
SUITE_HOME="$tmp/suite-home"
SUITE_CACHE="$tmp/suite-cache"
mkdir -p "$SUITE_HOME" "$SUITE_CACHE"
export HOME="$SUITE_HOME" XDG_CONFIG_HOME="$SUITE_HOME" BUN_INSTALL_CACHE_DIR="$SUITE_CACHE"
cat > "$tmp/bun" <<'BUN'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$KIT_UPGRADE_TEST_LOG"
if [[ ${FAIL_FROZEN:-} == 1 && ${1:-} == install && ${2:-} == --frozen-lockfile ]]; then exit 1; fi
if [[ ${FAIL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then exit 1; fi
if [[ ${REAL_LOCK:-} == 1 && ${1:-} == install && ${2:-} == --frozen-lockfile ]]; then
  exec bun "$@"
fi
if [[ ${REAL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then
  bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts
  rc=$?
  if [[ $rc -eq 0 && ${DIRTY_AFTER_CHECK:-} == 1 ]]; then
    printf '\n' >> bun.lock
  fi
  exit "$rc"
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
[[ $(cat "$KIT_UPGRADE_TEST_LOG") == $'install --frozen-lockfile --minimum-release-age 0\nrun lock-ranges:check\nrun zero-edit' ]]
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


# Product fixture rooted on the loopback hoist lock (hermetic cache).
hoist_product_fixture() {
  local name=$1
  dir="$tmp/$name"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir"
  python3 "$ROOT/scripts/kit/lib/build-hoist-fixture.py" "$dir/seed" "$SUITE_CACHE" "$ROOT/scripts/kit/check-lock-ranges.ts"
  printf '%s\n' 'node_modules/' '.pkg/' '.hermetic-home/' >"$dir/seed/.gitignore"
  rm -rf "$dir/seed/node_modules" "$dir/seed"/apps/*/node_modules "$dir/seed/.pkg" "$dir/seed/.hermetic-home"
  mkdir -p "$dir/seed/scripts/kit/lib" "$dir/seed/config/kit" "$dir/seed/config/product"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$dir/seed/scripts/kit/"
  cp "$ROOT/scripts/kit/check-lock-ranges.ts" "$dir/seed/scripts/kit/"
  cp "$ROOT/scripts/kit/lib/jsonc-strict.ts" "$dir/seed/scripts/kit/lib/"
  : >"$dir/seed/config/kit/bunfig.gates.toml"
  printf '%s\n' '{"version":1,"kit_origin_allowlist":["kit"]}' >"$dir/seed/config/kit/zero-edit-zones.json"
  node -e '
const fs=require("fs");
const p=process.argv[1];
const pkg=JSON.parse(fs.readFileSync(p,"utf8"));
pkg.scripts={
  ...(pkg.scripts||{}),
  "lock-ranges:check":"bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts",
  "zero-edit":"node -e \"process.exit(0)\"",
};
fs.writeFileSync(p, JSON.stringify(pkg,null,2)+"\n");
' "$dir/seed/package.json"
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

advance_seed() {
  echo "change-$RANDOM" > "$dir/seed/change"
  git -C "$dir/seed" add change
  git -C "$dir/seed" commit -qm update
  git -C "$dir/seed" push -q "$dir/upstream.git" main
}

hoist_product_fixture stable-merge
advance_seed
REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
pass 'upgrade commits install-stable staged lock'

hoist_product_fixture frozen-fail
advance_seed
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_FROZEN=1 REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'frozen install of the merged lock failed' "$dir/out"
pass 'frozen install failure leaves merge open with its own stop'

hoist_product_fixture check-fail
advance_seed
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_LOCK=1 REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'merge remains open' "$dir/out"
pass 'lock-ranges check failure leaves merge open'

hoist_product_fixture dirty-after-check
advance_seed
DIRTY_AFTER_CHECK=1 REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
[[ -n $(git -C "$dir/product" status --porcelain -- bun.lock) ]]
pass 'working bun.lock dirty after staging is not committed'

hoist_product_fixture decoy-env
advance_seed
mkdir -p "$dir/decoy"
printf '%s\n' '{"lockfileVersion":1,"workspaces":{"":{"name":"decoy","dependencies":{"left-pad":"^1.0.0"}}},"packages":{"left-pad":["left-pad@2.0.0","",{},"sha512-x"]}}' >"$dir/decoy/bun.lock"
LOCK_RANGES_ROOT="$dir/decoy" REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
if grep -q 'left-pad' "$dir/out"; then
  echo 'FAIL: decoy LOCK_RANGES_ROOT was consulted' >&2
  exit 1
fi
pass 'inherited LOCK_RANGES_ROOT decoy is ignored'

hoist_product_fixture out-of-range
# Force an out-of-range resolution: pin kit-pin workspace range to 9.0.0 while lock keeps 1.0.x
node -e '
const fs=require("fs");
const lockPath=process.argv[1], pkgPath=process.argv[2];
const lock=JSON.parse(fs.readFileSync(lockPath,"utf8"));
lock.workspaces["apps/a"].dependencies["kit-pin"]="9.0.0";
fs.writeFileSync(lockPath, JSON.stringify(lock,null,2)+"\n");
const pkg=JSON.parse(fs.readFileSync(pkgPath,"utf8"));
fs.writeFileSync(pkgPath, JSON.stringify(pkg,null,2)+"\n");
' "$dir/seed/bun.lock" "$dir/seed/apps/a/package.json"
# Also update the workspace package.json that the lock mirrors for honesty of the tree
printf '%s\n' '{"name":"a","dependencies":{"kit-pin":"9.0.0"}}' >"$dir/seed/apps/a/package.json"
git -C "$dir/seed" add -A && git -C "$dir/seed" commit -qm out-of-range
git -C "$dir/seed" push -q "$dir/upstream.git" main
before=$(git -C "$dir/product" rev-parse HEAD)
if REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'does not satisfy the range\|kit-pin' "$dir/out"
pass 'out-of-range staged resolution leaves merge open'

hoist_product_fixture hoist-upgrade
advance_seed
REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
[[ $(git -C "$dir/product" rev-list --parents -n 1 HEAD | wc -w) == 3 ]]
(cd "$dir/product" && bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts) >/dev/null
pass 'hoisting-only layout commits through kit-upgrade'

fixture check
advance
git -C "$dir/product" fetch -q upstream
cached=$(git -C "$dir/product" rev-parse upstream/main)
echo later > "$dir/seed/later"
git -C "$dir/seed" add later && git -C "$dir/seed" commit -qm later
git -C "$dir/seed" push -q "$dir/upstream.git" main
before=$(git -C "$dir/product" rev-parse HEAD)
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -z $(git -C "$dir/product" status --porcelain) ]]
[[ $(git -C "$dir/product" rev-parse upstream/main) == "$cached" ]]
pass '--check writes nothing'
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
