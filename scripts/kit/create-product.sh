#!/usr/bin/env bash
# Materialize a Product in a fresh, dedicated clone. Never creates or pushes a remote.
set -euo pipefail

die() { echo "create-product: $*" >&2; exit 1; }
usage() {
  echo 'usage: bash scripts/kit/create-product.sh <name> --origin <owner>/<repo> --accept-parent-origin --commit [--web] [--mcp] [--skip-gh-default]'
}

name='' product_origin='' accept=0 commit=0 web=0 mcp=0 skip_gh=0
while (($#)); do
  case "$1" in
    --origin) (($# >= 2)) || die 'missing --origin value'; [[ -z "$product_origin" ]] || die 'duplicate --origin'; product_origin=$2; shift 2 ;;
    --accept-parent-origin) accept=1; shift ;;
    --commit) commit=1; shift ;;
    --web) web=1; shift ;;
    --mcp) mcp=1; shift ;;
    --skip-gh-default) skip_gh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [[ -z "$name" ]] || die 'only one name is allowed'; name=$1; shift ;;
  esac
done
[[ "$name" =~ ^[a-z][a-z0-9-]{0,38}$ && "$name" != *- ]] || die 'name must be a lowercase slug without edge hyphens (maximum 39 characters)'
case "$name" in example|starter|mcp-example) die 'reserved name' ;; esac
[[ "$product_origin" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$product_origin" != */. && "$product_origin" != */.. && "$product_origin" != .* ]] || die '--origin must be owner/repo'
((accept)) || die '--accept-parent-origin is required for a dedicated clone'
((commit)) || die '--commit is required for the two local commits'
for cmd in git node bun tar realpath; do command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"; done
if ((!skip_gh)); then command -v gh >/dev/null 2>&1 || die 'gh is required unless --skip-gh-default is specified'; fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'run at the root of a git work tree'
[[ "$(pwd -P)" == "$(cd "$root" && pwd -P)" ]] || die 'run at the root of the dedicated clone'
[[ "$(realpath "$(git rev-parse --git-dir)")" == "$(realpath "$(git rev-parse --git-common-dir)")" ]] || die 'linked/shared worktrees are not supported'
[[ $(git worktree list --porcelain | grep -c '^worktree ') == 1 ]] || die 'multiple worktrees are not supported'
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || die 'working tree must be clean'
[[ ! -e "$(git rev-parse --git-path MERGE_HEAD)" ]] || die 'finish the merge first'
if git config --get core.hooksPath >/dev/null 2>&1; then
  die 'custom core.hooksPath prevents installing Kit hooks; use a clone without an inherited hooksPath'
fi
if env | grep -q '^LEFTHOOK[^=]*='; then
  die 'unset LEFTHOOK environment overrides so normal Kit hooks can run'
fi
[[ "$(git remote)" == origin ]] || die 'expected exactly one remote named origin; already rewired or not a fresh clone'
parent_url=$(git remote get-url origin)
case "$parent_url" in
  https://github.com/*) parent_id=${parent_url#https://github.com/}; new_url="https://github.com/${product_origin}.git" ;;
  git@github.com:*) parent_id=${parent_url#git@github.com:}; new_url="git@github.com:${product_origin}.git" ;;
  *) die 'parent origin must use a GitHub HTTPS or SSH URL' ;;
esac
parent_id=${parent_id%.git}
node - "$parent_id" "$product_origin" <<'NODE' || die 'parent must be allowlisted and Product origin must not be allowlisted'
const zones = require('./config/kit/zero-edit-zones.json')
const allowed = zones.kit_origin_allowlist.map(x => x.toLowerCase())
if (!allowed.includes(process.argv[2].toLowerCase()) || allowed.includes(process.argv[3].toLowerCase())) process.exit(1)
NODE
[[ -z "$(git config --local --get-regexp '^remote\..*\.gh-resolved$' || true)" ]] || die 'existing gh default configuration is not a fresh clone'
for path in "apps/$name-api" "apps/$name-web" "apps/$name-mcp" config/product/inheritance.json scripts/product/validate.sh .github/workflows/product-ci.yml config/product/deploy-gate.json docs/product/AGENTS.md config/product/coverage-order.txt; do
  [[ ! -e "$path" && ! -L "$path" ]] || die "destination already exists: $path"
done
[[ -d apps/starter-api && -f apps/starter-api/package.json ]] || die 'API starter missing'
if ((web)); then [[ -d apps/starter-web && -f apps/starter-web/package.json ]] || die 'web starter missing'; fi
[[ -f scripts/kit/create-product-templates.sh ]] || die 'product templates helper missing'
head_sha=$(git rev-parse --verify 'HEAD^{commit}') || die 'HEAD is not a commit'
if git rev-parse --verify 'refs/remotes/origin/main^{commit}' >/dev/null 2>&1; then
  parent_sha=$(git rev-parse 'refs/remotes/origin/main^{commit}')
elif git rev-parse --verify 'refs/heads/main^{commit}' >/dev/null 2>&1; then
  parent_sha=$(git rev-parse 'refs/heads/main^{commit}')
else
  parent_sha=$head_sha
fi
[[ "$head_sha" == "$parent_sha" ]] || die 'HEAD must equal the inherited parent tip'

# From here on failure is intentionally fix-forward: never reset or clean the clone.
trap 'echo "create-product: stopped; existing remotes, files and commits were preserved. Fix the cause and continue manually or use a new dedicated clone." >&2' ERR
git remote rename origin upstream
git remote add origin "$new_url"
git remote set-url --push upstream no_push
[[ "$(git remote get-url upstream)" == "$parent_url" && "$(git remote get-url --push upstream)" == no_push && "$(git remote get-url origin)" == "$new_url" ]] || die 'remote verification failed; preserve this state and fix forward'
if ((skip_gh)); then
  echo 'gh default repository: not configured (--skip-gh-default)'
else
  if ! gh repo set-default origin; then
    die 'gh default failed after remote rewrite; ensure the Product repository exists and authentication works, then run gh repo set-default origin and proceed manually or use a new clone'
  fi
  [[ "$(gh repo set-default --view)" == "$product_origin" && "$(git config --local --get remote.origin.gh-resolved || true)" == base ]] || die 'gh default verification failed; fix forward manually'
fi

# Install the inherited lockfile and its prepare hook before either commit.
bun install --frozen-lockfile
for hook in pre-commit commit-msg; do
  [[ -x "$(git rev-parse --git-path "hooks/$hook")" ]] || die "Kit $hook hook was not installed"
done

mkdir -p config/product
printf '{\n  "version": 1,\n  "upstreamCommit": "%s"\n}\n' "$parent_sha" > config/product/inheritance.json
node - "$name" "$web" <<'NODE'
const fs = require('node:fs')
const [name, web] = process.argv.slice(2)
const file = '.dev/stack.yml'
let s = fs.readFileSync(file, 'utf8')
function replace(from, to) {
  if (!s.includes(from)) throw new Error(`stack template missing: ${from}`)
  s = s.replace(from, to)
}
replace('name: cf-chemin-a\n', `name: ${name}\n`)
replace('  path: apps/example-api\n', `  path: apps/${name}-api\n`)
replace('  component: roxabi-boilerplate-cf\n', `  component: ${name}\n`)
if (web === '1') replace('  path: apps/example-web\n', `  path: apps/${name}-web\n`)
else {
  const start = s.indexOf('\nfrontend:\n')
  const end = s.indexOf('\nshared:\n', start)
  if (start < 0 || end < 0) throw new Error('stack frontend block missing')
  s = s.slice(0, start) + '\nfrontend: null' + s.slice(end)
}
replace('    - apps/example-api/.dev.vars\n', `    - apps/example-api/.dev.vars\n    - apps/${name}-api/.dev.vars\n`)
fs.writeFileSync(file, s)
NODE
git add -- config/product/inheritance.json .dev/stack.yml
git commit -m 'chore(product): pin kit inheritance'

copy_starter() {
  local kind=$1 target="apps/$name-$1"
  mkdir -p "$target"
  git archive HEAD "apps/starter-$kind" | tar -x -C "$target" --strip-components=2 --exclude='apps/starter-api/src/worker-configuration.d.ts'
}
copy_starter api
if ((web)); then copy_starter web; fi
node - "$name" "$web" <<'NODE'
const fs = require('node:fs')
const [name, web] = process.argv.slice(2)
function patch(file, replacements) {
  let text = fs.readFileSync(file, 'utf8')
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`${file}: missing ${from}`)
    text = text.replaceAll(from, to)
  }
  fs.writeFileSync(file, text)
}
const api = `apps/${name}-api`
patch(`${api}/package.json`, [['starter-api', `${name}-api`]])
// Runtime types are generated locally, not copied into Product source control.
const packageFile = `${api}/package.json`
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
pkg.scripts.typecheck = pkg.scripts.typecheck.replace(' --check &&', ' &&')
fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`)
fs.writeFileSync(`${api}/.gitignore`, '/src/worker-configuration.d.ts\n')
patch(`${api}/wrangler.toml`, [['starter-api', `${name}-api`]])
patch(`${api}/kit-schema-manifest.json`, [['apps/starter-api', api]])
patch(`${api}/vitest.config.ts`, [['starter-api', `${name}-api`]])
patch(`${api}/README.md`, [['starter-api', `${name}-api`], ['<product>', name]])
if (web === '1') {
  const dir = `apps/${name}-web`
  patch(`${dir}/package.json`, [['starter-web', `${name}-web`]])
  patch(`${dir}/vitest.config.ts`, [['starter-web', `${name}-web`]])
  patch(`${dir}/README.md`, [['starter-api', `${name}-api`], ['starter-web', `${name}-web`], ['Starter Web', `${name} Web`]])
  for (const file of ['index.html', 'src/app.tsx']) patch(`${dir}/${file}`, [['Starter Web', `${name} Web`]])
}
NODE
bash scripts/kit/kit-schema-sync.sh --app "apps/$name-api" --modules core,audit
bash scripts/kit/create-product-templates.sh "$name" "$web" "$mcp"
bun install
git add -- "apps/$name-api/package.json"
if ((web)); then git add -- "apps/$name-web/package.json"; fi
if ((mcp)); then git add -- "apps/$name-mcp/package.json"; fi
node scripts/kit/configure-product-dependabot.cjs
bun run zero-edit
git add -- "apps/$name-api" scripts/product/validate.sh .github/workflows/product-ci.yml .github/dependabot.yml config/product/deploy-gate.json docs/product/AGENTS.md config/product/coverage-order.txt bun.lock
if ((web)); then git add -- "apps/$name-web"; fi
if ((mcp)); then git add -- "apps/$name-mcp"; fi
git commit -m "chore(product): bootstrap $name apps"
bun run validate:full
bash scripts/product/validate.sh
if ((skip_gh)); then echo 'gh default repository: not configured (--skip-gh-default)'; else echo "gh default repository: $(gh repo set-default --view)"; fi
printf '%s\n' 'Deferred operator steps: git push -u origin main; configure CI App secrets; issue-triage init --dry-run then write; configure Cloudflare locally and perform cutover.'
