#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/hermetic-git.sh
source "$ROOT/scripts/kit/lib/hermetic-git.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/scripts/kit/lib" "$repo/config/kit" "$repo/.github" "$repo/apps/example-api" "$repo/packages/core"
cp "$ROOT/scripts/kit/check-zero-edit-zones.sh" "$ROOT/scripts/kit/configure-product-dependabot.cjs" "$repo/scripts/kit/"
cp "$ROOT/scripts/kit/lib/product-dependabot.cjs" "$repo/scripts/kit/lib/"
cp "$ROOT/config/kit/zero-edit-zones.json" "$repo/config/kit/"
cp "$ROOT/.github/dependabot.yml" "$repo/.github/"
printf '{"dependencies":{"shared":"1.0.0"}}\n' | tee "$repo/package.json" "$repo/apps/example-api/package.json" "$repo/packages/core/package.json" >/dev/null
printf 'lock baseline\n' > "$repo/bun.lock"
git -C "$repo" init -q
git -C "$repo" add .
commit() { git -C "$repo" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "$1"; }
commit baseline
base="$(git -C "$repo" rev-parse HEAD)"
check() { (cd "$repo" && GITHUB_REPOSITORY="${IDENTITY:-example/product}" bash scripts/kit/check-zero-edit-zones.sh >/dev/null 2>&1); }
generate() { (cd "$repo" && GITHUB_REPOSITORY="${IDENTITY:-example/product}" node scripts/kit/configure-product-dependabot.cjs >/dev/null 2>&1); }
pass() { if ! "$@"; then echo "expected success: $*" >&2; exit 1; fi; }
fail() { if "$@"; then echo "expected failure: $*" >&2; exit 1; fi; }
IDENTITY=go-silex/unkillable-kit pass check
fail check
fail generate
mkdir -p "$repo/config/product" "$repo/apps/product-api"
printf '{"upstreamCommit":"%s"}\n' "$base" > "$repo/config/product/inheritance.json"
printf '{"dependencies":{"shared":"1.0.0"}}\n' > "$repo/apps/product-api/package.json"
git -C "$repo" add . && commit product
pass check
if (cd "$repo" && env -u GITHUB_REPOSITORY node scripts/kit/configure-product-dependabot.cjs >/dev/null 2>&1); then
  echo 'generator accepted an unknown identity' >&2; exit 1
fi
printf '{"upstreamCommit": "%s"}\n' "$base" > "$repo/config/product/inheritance.json"
fail generate
git -C "$repo" checkout -- config/product/inheritance.json
pass generate
pass check
git -C "$repo" remote add origin "$tmp/local-origin"
(cd "$repo" && env -u GITHUB_REPOSITORY bash scripts/kit/check-zero-edit-zones.sh >/dev/null)
if (cd "$repo" && env -u GITHUB_REPOSITORY node scripts/kit/configure-product-dependabot.cjs >/dev/null 2>&1); then
  echo 'generator accepted a local origin as a GitHub identity' >&2; exit 1
fi
git -C "$repo" remote remove origin
# Run the actual guard self-test against the generated Product configuration.
guard="$tmp/guard"
mkdir -p "$guard/scripts/kit/lib" "$guard/config/kit" "$guard/config/product" "$guard/.github"
cp -R "$ROOT/scripts/kit/deps-guard" "$guard/scripts/kit/"
cp "$ROOT/scripts/kit/test-deps-guard.ts" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$guard/scripts/kit/"
cp "$ROOT/scripts/kit/lib/product-declaration.cjs" "$guard/scripts/kit/lib/"
cp "$ROOT/config/kit/zero-edit-zones.json" "$guard/config/kit/"
cp "$repo/config/product/inheritance.json" "$guard/config/product/"
cp "$repo/.github/dependabot.yml" "$guard/.github/"
cp "$ROOT/bunfig.toml" "$ROOT/package.json" "$guard/"
git -C "$guard" init -q
(cd "$guard" && GITHUB_REPOSITORY=example/product bun --no-env-file scripts/kit/test-deps-guard.ts)
# A second Dependabot filename is forbidden even with an active exception.
expiry="$(node -e 'const d = new Date(); d.setUTCDate(d.getUTCDate() + 30); process.stdout.write(d.toISOString().slice(0, 10))')"
exception() {
  printf '{"version":1,"exceptions":[{"path":"%s","reason":"fixture exception reason","owner":"fixture","expires":"%s","ticket":"TEST-1","alternatives_considered":["fixture"],"why_not_alternative":"fixture justification"}]}\n' "$1" "$expiry" > "$repo/config/product/zero-edit-exceptions.json"
}
# An excepted zones edit cannot remove or exclude the fixed Dependabot trigger.
# Exercise working-tree, index-only, and committed config divergence separately.
for location in worktree index committed; do
  (
    repo="$tmp/policy-bypass-$location"
    git clone -q --no-hardlinks "$tmp/repo" "$repo"
    node - "$repo/config/kit/zero-edit-zones.json" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const zones = JSON.parse(fs.readFileSync(path, 'utf8'))
zones.protected_files = zones.protected_files.filter((p) => p !== '.github/dependabot.yml')
zones.protected_files.push(':(exclude).github/dependabot.yml')
fs.writeFileSync(path, `${JSON.stringify(zones, null, 2)}\n`)
NODE
    exception config/kit/zero-edit-zones.json
    if [[ "$location" == committed ]]; then
      printf 'version: 2\nupdates:\n  - package-ecosystem: bun\n    directory: /\n' > "$repo/.github/dependabot.yml"
      git -C "$repo" add config/kit/zero-edit-zones.json config/product/zero-edit-exceptions.json .github/dependabot.yml
      commit 'attempt policy bypass'
    else
      printf 'version: 2\nupdates: []\n' > "$repo/.github/dependabot.yml"
      if [[ "$location" == index ]]; then
        git -C "$repo" add .github/dependabot.yml
        git -C "$repo" show "$base:.github/dependabot.yml" > "$repo/.github/dependabot.yml"
      fi
    fi
    if output="$(cd "$repo" && GITHUB_REPOSITORY=example/product bash scripts/kit/check-zero-edit-zones.sh 2>&1)"; then
      echo "checker accepted policy bypass ($location)" >&2
      exit 1
    fi
    if [[ "$output" != *'untrusted Product Dependabot policy config/kit/zero-edit-zones.json'* ]]; then
      echo "checker rejected $location for the wrong reason: $output" >&2
      exit 1
    fi
  )
done
printf 'version: 2\nupdates: []\n' > "$repo/.github/dependabot.yaml"
git -C "$repo" add .github/dependabot.yaml
exception '.github/dependabot.yaml'
fail check
fail generate
git -C "$repo" rm --cached -q -- .github/dependabot.yaml
rm "$repo/.github/dependabot.yaml"
rm "$repo/config/product/zero-edit-exceptions.json"
# Neither a renderer nor the policy used to authorize it may be excepted away.
for policy in scripts/kit/lib/product-dependabot.cjs config/kit/zero-edit-zones.json; do
  exception "$policy"
  printf '\n ' >> "$repo/$policy"
  fail check
  fail generate
  git -C "$repo" checkout -- "$policy"
  rm "$repo/config/product/zero-edit-exceptions.json"
done
# A rename must not hide the removal of a protected Kit manifest.
mkdir -p "$repo/apps/product-rename"
git -C "$repo" mv packages/core/package.json apps/product-rename/package.json
exception packages/core/package.json
fail generate
git -C "$repo" mv apps/product-rename/package.json packages/core/package.json
rm "$repo/config/product/zero-edit-exceptions.json"
# The documented example is exactly the renderer's output.
node - "$ROOT" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const root = process.argv[2]
const { renderProductDependabot } = require(`${root}/scripts/kit/lib/product-dependabot.cjs`)
assert.equal(fs.readFileSync(`${root}/docs/kit/templates/product-dependabot.example.yml`, 'utf8'),
  renderProductDependabot(['/apps/product-api', '/apps/product-web']))
NODE
# Product bump and shared lock change do not alter protected manifests.
printf '{"dependencies":{"shared":"1.1.0"}}\n' > "$repo/apps/product-api/package.json"
printf 'lock shared update\n' > "$repo/bun.lock"
git clone -q --depth=1 "file://$repo" "$tmp/shallow"
if (cd "$tmp/shallow" && GITHUB_REPOSITORY=example/product bash scripts/kit/check-zero-edit-zones.sh >/dev/null 2>&1); then
  echo 'checker accepted incomplete history' >&2; exit 1
fi
if (cd "$tmp/shallow" && GITHUB_REPOSITORY=example/product node scripts/kit/configure-product-dependabot.cjs >/dev/null 2>&1); then
  echo 'generator accepted incomplete history' >&2; exit 1
fi
pass check
printf '{"dependencies":{"shared":"1.1.0"}}\n' > "$repo/packages/core/package.json"
fail check
fail generate
git -C "$repo" checkout -- packages/core/package.json
cp "$repo/.github/dependabot.yml" "$tmp/valid.yml"
printf 'version: 2\nupdates: []\n' > "$repo/.github/dependabot.yml"
git -C "$repo" add .github/dependabot.yml
cp "$tmp/valid.yml" "$repo/.github/dependabot.yml"
fail check
git -C "$repo" restore --staged .github/dependabot.yml
pass check
printf 'version: 2\nupdates: []\n' > "$repo/.github/dependabot.yml"
fail check
pass generate
printf '\n  - package-ecosystem: github-actions\n    directory: /\n' >> "$repo/.github/dependabot.yml"
fail check
cp "$tmp/valid.yml" "$repo/.github/dependabot.yml"
mkdir -p "$repo/apps/product-web"
printf '{}\n' > "$repo/apps/product-web/package.json"
git -C "$repo" add apps/product-web/package.json
fail check
pass generate
pass check
# An exact protected manifest is Kit-owned even without a protected app prefix.
node - "$repo" <<'NODE'
const assert = require('node:assert/strict')
const root = process.argv[2]
const { productManifestDirectories, renderProductDependabot } = require(`${root}/scripts/kit/lib/product-dependabot.cjs`)
const zones = require(`${root}/config/kit/zero-edit-zones.json`)
zones.protected_files.push('apps/product-api/package.json')
const directories = productManifestDirectories(root, zones)
assert.deepEqual(directories, ['/apps/product-web'])
assert(!renderProductDependabot(directories).includes('/apps/product-api'))
NODE
mv "$repo/.github/dependabot.yml" "$tmp/target"
ln -s "$tmp/target" "$repo/.github/dependabot.yml"
fail check
fail generate
rm "$repo/.github/dependabot.yml"
cp "$tmp/target" "$repo/.github/dependabot.yml"
printf '{"upstreamCommit":"%040d"}\n' 0 > "$repo/config/product/inheritance.json"
fail check
fail generate
rm "$repo/config/product/inheritance.json"
fail check
fail generate
# Kit may change its own manifests with its own identity and no marker.
printf '{}' > "$repo/packages/core/package.json"
IDENTITY=go-silex/unkillable-kit pass check
echo 'product Dependabot fixtures passed'
