#!/usr/bin/env bash
# Finite, write-free refusal tests. No generated Product runs the root gate here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/hermetic-git.sh
source "$ROOT/scripts/kit/lib/hermetic-git.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
source_sha="$(git -C "$ROOT" rev-parse HEAD)"
if [[ -f "$ROOT/config/product/inheritance.json" ]]; then
  source_sha="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).upstreamCommit' "$ROOT/config/product/inheritance.json")"
fi

clone() {
  git clone -q --no-hardlinks "$ROOT" "$tmp/$1"
  git -C "$tmp/$1" remote set-url origin https://github.com/go-silex/unkillable-kit.git
  git -C "$tmp/$1" checkout -q --detach "$source_sha"
  git -C "$tmp/$1" update-ref refs/remotes/origin/main "$source_sha"
}
snapshot() {
  local tree="$1" out="$2"
  git -C "$tree" rev-parse HEAD > "$out"
  git -C "$tree" status --porcelain=v1 --untracked-files=all >> "$out"
  git -C "$tree" config --local --list | LC_ALL=C sort >> "$out"
  git -C "$tree" for-each-ref --format='%(refname) %(objectname)' | LC_ALL=C sort >> "$out"
  # Include ignored/untracked files and the index: status alone misses modified bytes.
  (cd "$tree" && find . -type f ! -path './.git/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >> "$out"
  sha256sum "$(git -C "$tree" rev-parse --absolute-git-dir)/index" | cut -d' ' -f1 >> "$out"
}
refuse() {
  local label="$1" tree="$2" cwd="$3"; shift 3
  snapshot "$tree" "$tmp/before"
  if (cd "$cwd" && bash "$ROOT/scripts/kit/create-product.sh" "$@") >"$tmp/output" 2>&1; then
    echo "FAIL: accepted $label" >&2; exit 1
  fi
  snapshot "$tree" "$tmp/after"
  case "$label" in
    missing-origin|invalid-origin) expected='--origin must be owner/repo' ;;
    missing-opt-in) expected='--accept-parent-origin is required' ;;
    missing-commit) expected='--commit is required' ;;
    invalid-name) expected='name must be' ;;
    protected-destination) expected='generated App overlaps a protected Kit path' ;;
    parent-origin) expected='Product origin must not be allowlisted' ;;
    nested-cwd) expected='run at the root' ;;
    dirty) expected='working tree must be clean' ;;
    extra-remote) expected='expected exactly one remote' ;;
    occupied-destination|selected-optional) expected='destination already exists' ;;
    existing-marker) expected='destination already exists' ;;
    missing-starter) expected='API starter missing' ;;
    merge-head) expected='finish the merge first' ;;
    linked-worktree) expected='linked/shared worktrees' ;;
    multiple-worktrees) expected='multiple worktrees' ;;
  esac
  grep -Fq -- "$expected" "$tmp/output" || { echo "FAIL: $label refused for the wrong reason" >&2; cat "$tmp/output" >&2; exit 1; }
  if ! cmp -s "$tmp/before" "$tmp/after"; then
    echo "FAIL: $label modified the checkout" >&2; diff -u "$tmp/before" "$tmp/after" >&2 || true; exit 1
  fi
}
args=(sample --origin example/sample --accept-parent-origin --commit --skip-gh-default)
clone base
base="$tmp/base"
refuse missing-origin "$base" "$base" sample --accept-parent-origin --commit --skip-gh-default
refuse missing-opt-in "$base" "$base" sample --origin example/sample --commit --skip-gh-default
refuse missing-commit "$base" "$base" sample --origin example/sample --accept-parent-origin --skip-gh-default
refuse invalid-name "$base" "$base" 'Invalid!' --origin example/sample --accept-parent-origin --commit --skip-gh-default
refuse invalid-origin "$base" "$base" sample --origin invalid --accept-parent-origin --commit --skip-gh-default
refuse parent-origin "$base" "$base" sample --origin go-silex/unkillable-kit --accept-parent-origin --commit --skip-gh-default
refuse nested-cwd "$base" "$base/apps" "${args[@]}"
printf 'dirty\n' > "$base/dirty-fixture"
refuse dirty "$base" "$base" "${args[@]}"
rm "$base/dirty-fixture"
git -C "$base" remote add upstream https://github.com/example/other.git
refuse extra-remote "$base" "$base" "${args[@]}"
git -C "$base" remote remove upstream
mkdir -p "$base/apps/sample-api"
printf 'occupied\n' > "$base/apps/sample-api/fixture"
git -C "$base" add apps/sample-api/fixture
git -C "$base" commit -qm 'fixture: occupied destination'
git -C "$base" update-ref refs/remotes/origin/main "$(git -C "$base" rev-parse HEAD)"
clone marker
mkdir -p "$tmp/marker/config/product"
printf '{}\n' > "$tmp/marker/config/product/inheritance.json"
git -C "$tmp/marker" add config/product/inheritance.json
git -C "$tmp/marker" commit -qm 'fixture: existing marker'
git -C "$tmp/marker" update-ref refs/remotes/origin/main "$(git -C "$tmp/marker" rev-parse HEAD)"
refuse existing-marker "$tmp/marker" "$tmp/marker" "${args[@]}"
clone missing-starter
git -C "$tmp/missing-starter" rm -qr apps/starter-api
git -C "$tmp/missing-starter" commit -qm 'fixture: missing starter'
git -C "$tmp/missing-starter" update-ref refs/remotes/origin/main "$(git -C "$tmp/missing-starter" rev-parse HEAD)"
refuse missing-starter "$tmp/missing-starter" "$tmp/missing-starter" "${args[@]}"
clone merge
git -C "$tmp/merge" rev-parse HEAD > "$tmp/merge/.git/MERGE_HEAD"
refuse merge-head "$tmp/merge" "$tmp/merge" "${args[@]}"
refuse occupied-destination "$base" "$base" "${args[@]}"
clone linked
git -C "$tmp/linked" worktree add -q -b fixture-linked "$tmp/linked-child"
refuse linked-worktree "$tmp/linked-child" "$tmp/linked-child" "${args[@]}"
refuse multiple-worktrees "$tmp/linked" "$tmp/linked" "${args[@]}"
# Enumerate App destinations from the authoritative zones, not a copied list.
mapfile -t protected_apps < <(node - "$base/config/kit/zero-edit-zones.json" <<'NODE'
const zones = require(process.argv[2])
for (const path of zones.protected_prefixes) {
  const match = /^apps\/([a-z][a-z0-9-]*)-(api|web|mcp)\/$/.exec(path)
  if (match && !match[1].endsWith('-') && match[1].length <= 39) console.log(`${match[1]} ${match[2]}`)
}
NODE
)
[[ ${#protected_apps[@]} -gt 0 ]] || { echo 'FAIL: no protected App destinations discovered' >&2; exit 1; }
clone protected
for entry in "${protected_apps[@]}"; do
  read -r slug kind <<< "$entry"
  flags=()
  [[ "$kind" == api ]] || flags+=("--$kind")
  refuse protected-destination "$tmp/protected" "$tmp/protected" "$slug" --origin example/sample --accept-parent-origin --commit --skip-gh-default "${flags[@]}"
done

# A failing gh process is a boundary probe: reaching it proves preflight
# accepted the name, while stopping before install, files or commits.
mkdir -p "$tmp/probe-bin"
cat > "$tmp/probe-bin/gh" <<'GH'
#!/usr/bin/env bash
echo 'fixture-gh-boundary' >&2
exit 1
GH
chmod +x "$tmp/probe-bin/gh"
accept_preflight() {
  local label="$1" tree="$2" slug="$3"; shift 3
  local before
  before="$(git -C "$tree" rev-parse HEAD)"
  if (cd "$tree" && PATH="$tmp/probe-bin:$PATH" bash "$ROOT/scripts/kit/create-product.sh" "$slug" --origin example/sample --accept-parent-origin --commit "$@") >"$tmp/output" 2>&1; then
    echo "FAIL: $label ignored gh failure" >&2; exit 1
  fi
  grep -Fq 'fixture-gh-boundary' "$tmp/output" || { echo "FAIL: $label did not reach gh boundary" >&2; cat "$tmp/output" >&2; exit 1; }
  [[ "$(git -C "$tree" rev-parse HEAD)" == "$before" && ! -e "$tree/config/product/inheritance.json" ]] || { echo "FAIL: $label wrote Product files" >&2; exit 1; }
  [[ "$(git -C "$tree" remote get-url --push upstream)" == no_push ]] || { echo "FAIL: $label did not reach remote rewrite" >&2; exit 1; }
}
clone false-prefix
read -r protected_slug protected_kind <<< "${protected_apps[0]}"
false_slug="${protected_slug}-${protected_kind}x"
[[ ${#false_slug} -le 39 ]] || { echo 'FAIL: cannot construct false-prefix slug' >&2; exit 1; }
accept_preflight false-prefix "$tmp/false-prefix" "$false_slug"
clone mcp-example
accept_preflight mcp-example "$tmp/mcp-example" mcp-example
for kind in web mcp; do
  clone "optional-$kind"
  tree="$tmp/optional-$kind"
  mkdir -p "$tree/apps/sample-$kind"
  refuse selected-optional "$tree" "$tree" "${args[@]}" "--$kind"
  accept_preflight "unselected-$kind" "$tree" sample
done
# A newly protected optional App is rejected only when selected.
clone protected-optional
tree="$tmp/protected-optional"
node - "$tree/config/kit/zero-edit-zones.json" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const zones = JSON.parse(fs.readFileSync(file, 'utf8'))
zones.protected_prefixes.push('apps/sample-web/')
fs.writeFileSync(file, `${JSON.stringify(zones, null, 2)}\n`)
NODE
git -C "$tree" add config/kit/zero-edit-zones.json
git -C "$tree" commit -qm 'fixture: protect optional App'
git -C "$tree" update-ref refs/remotes/origin/main "$(git -C "$tree" rev-parse HEAD)"
refuse protected-destination "$tree" "$tree" "${args[@]}" --web
accept_preflight unselected-protected "$tree" sample
echo 'create-product preflight refusals passed'
