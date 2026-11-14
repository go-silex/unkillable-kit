#!/usr/bin/env bash
# Deliberately separate from validate:full: the generator itself runs that gate.
# Optional: --real-origin owner/repo proves gh against an existing accessible repo.
set -euo pipefail
unset GITHUB_REPOSITORY 2>/dev/null || true
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/hermetic-git.sh
source "$ROOT/scripts/kit/lib/hermetic-git.sh"
real_origin=""
if [[ $# -gt 0 ]]; then
  [[ $# -eq 2 && "$1" == --real-origin && "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "Usage: $0 [--real-origin owner/repo]" >&2; exit 2;
  }
  real_origin="$2"
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
fail() { echo "FAIL: $*" >&2; exit 1; }
clone() {
  git clone -q --no-hardlinks "$ROOT" "$tmp/$1"
  git -C "$tmp/$1" remote set-url origin https://github.com/go-silex/unkillable-kit.git
  git -C "$tmp/$1" update-ref refs/remotes/origin/main "$(git -C "$tmp/$1" rev-parse HEAD)"
}
run_case() {
  local label="$1" origin="$2" real="$3"; shift 3
  local tree="$tmp/$label" base marker first
  clone "$label"
  base="$(git -C "$tree" rev-parse HEAD)"
  # Ignored local files must never be copied from either starter, even when
  # the generated path would itself be ignored and absent from git status.
  local kind path
  for kind in api web; do
    mkdir -p "$tree/apps/starter-$kind/.turbo"
    for path in .dev.vars .env .turbo/create-product-poison; do
      printf 'KIT_COPY_POISON=starter-%s\n' "$kind" > "$tree/apps/starter-$kind/$path"
      git -C "$tree" check-ignore -q "apps/starter-$kind/$path" || fail "$label fixture is not ignored: $kind/$path"
    done
  done
  [[ -z "$(git -C "$tree" status --porcelain --untracked-files=all)" ]] || fail "$label poison fixture dirtied the checkout"
  local options=()
  [[ "$real" == yes ]] || options+=(--skip-gh-default)
  (cd "$tree" && bash scripts/kit/create-product.sh sample --origin "$origin" --accept-parent-origin --commit "${options[@]}" "$@") | tee "$tmp/$label.log"
  [[ "$(git -C "$tree" remote get-url upstream)" == https://github.com/go-silex/unkillable-kit.git ]] || fail "$label upstream fetch"
  [[ "$(git -C "$tree" remote get-url --push upstream)" == no_push ]] || fail "$label upstream push"
  [[ "$(git -C "$tree" remote get-url origin)" == "https://github.com/$origin.git" ]] || fail "$label origin"
  if [[ "$real" == yes ]]; then
    [[ "$(cd "$tree" && gh repo set-default --view)" == "$origin" ]] || fail 'real gh default view'
    [[ "$(git -C "$tree" config --local --get remote.origin.gh-resolved)" == base ]] || fail 'real gh config'
  else
    ! git -C "$tree" config --local --get remote.origin.gh-resolved >/dev/null || fail "$label fake gh default"
    grep -Eiq 'gh.*(not configured|not set)' "$tmp/$label.log" || fail "$label missing skip disclosure"
  fi
  [[ "$(git -C "$tree" rev-list --count "$base"..HEAD)" == 2 ]] || fail "$label must make exactly two commits"
  first="$(git -C "$tree" rev-parse HEAD^1)"
  [[ "$(git -C "$tree" rev-parse "$first^1")" == "$base" ]] || fail "$label parent lineage"
  [[ "$(git -C "$tree" log -1 --format=%s "$first")" == 'chore(product): pin kit inheritance' ]] || fail "$label inheritance commit"
  [[ "$(git -C "$tree" log -1 --format=%s HEAD)" == 'chore(product): bootstrap sample apps' ]] || fail "$label bootstrap commit"
  marker="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).upstreamCommit' "$tree/config/product/inheritance.json")"
  [[ "$marker" == "$base" ]] || fail "$label inheritance pin"
  git -C "$tree" cat-file -e "$first:config/product/inheritance.json" || fail "$label uncommitted inheritance"
  [[ -f "$tree/apps/sample-api/package.json" ]] || fail "$label missing API"
  if [[ " $* " == *' --web '* ]]; then [[ -f "$tree/apps/sample-web/package.json" ]] || fail "$label missing web"; else [[ ! -e "$tree/apps/sample-web" ]] || fail "$label unexpected web"; fi
  if [[ " $* " == *' --mcp '* ]]; then [[ -f "$tree/apps/sample-mcp/package.json" ]] || fail "$label missing MCP"; else [[ ! -e "$tree/apps/sample-mcp" ]] || fail "$label unexpected MCP"; fi
  for kind in api web; do
    [[ -d "$tree/apps/sample-$kind" ]] || continue
    for path in .dev.vars .env .turbo/create-product-poison; do
      [[ ! -e "$tree/apps/sample-$kind/$path" ]] || fail "$label copied ignored starter file: $kind/$path"
    done
    if grep -rFl -- 'KIT_COPY_POISON=starter-' "$tree/apps/sample-$kind" > "$tmp/$label-poison"; then
      fail "$label copied starter poison into Product files"
    else
      [[ $? -eq 1 ]] || fail "$label could not scan Product files for poison"
    fi
  done
  local -a grep_args tree_args
  for path in HEAD --cached; do
    grep_args=() tree_args=()
    if [[ "$path" == HEAD ]]; then tree_args=(HEAD); else grep_args=(--cached); fi
    if git -C "$tree" grep -Fq "${grep_args[@]}" -e 'KIT_COPY_POISON=starter-' "${tree_args[@]}" -- apps/sample-api apps/sample-web scripts/product config/product docs/product; then
      fail "$label committed or staged starter poison"
    else
      [[ $? -eq 1 ]] || fail "$label could not scan commit or index for poison"
    fi
  done
  diff -qr "$tree/apps/starter-api/migrations" "$tree/apps/sample-api/migrations" >/dev/null || fail "$label migration bytes"
  # Path-mode dogfood exercises the actual generated Product, not a hand-planted fixture.
  bash "$ROOT/scripts/kit/dogfood-zero-edit.sh" --generated-product "$tree"
}
run_case api example/sample-api no
run_case web example/sample-web no --web
run_case mcp example/sample-mcp no --mcp
clone gh-failure
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
echo 'fixture: repository cannot be resolved' >&2
exit 1
GH
chmod +x "$tmp/bin/gh"
failure_base="$(git -C "$tmp/gh-failure" rev-parse HEAD)"
if (cd "$tmp/gh-failure" && PATH="$tmp/bin:$PATH" bash scripts/kit/create-product.sh sample --origin example/unresolvable --accept-parent-origin --commit) >"$tmp/gh-failure.log" 2>&1; then
  fail 'gh failure was accepted'
fi
[[ "$(git -C "$tmp/gh-failure" remote get-url --push upstream)" == no_push ]] || fail 'gh failure lost upstream protection'
[[ "$(git -C "$tmp/gh-failure" remote get-url origin)" == https://github.com/example/unresolvable.git ]] || fail 'gh failure lost Product origin'
[[ "$(git -C "$tmp/gh-failure" rev-parse HEAD)" == "$failure_base" && ! -e "$tmp/gh-failure/config/product/inheritance.json" ]] || fail 'gh failure wrote Product files'
! git -C "$tmp/gh-failure" config --local --get remote.origin.gh-resolved >/dev/null || fail 'gh failure faked default'
run_case all example/sample-all no --web --mcp
if [[ -n "$real_origin" ]]; then
  run_case real-gh "$real_origin" yes
else
  echo 'Real gh default proof not run: supply --real-origin owner/repo for an accessible existing repository.'
fi
echo 'create-product generator output smoke passed'
