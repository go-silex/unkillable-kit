#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/docs/kit/architecture/adr"
cp "$root"/docs/kit/architecture/adr/*.md "$tmp/docs/kit/architecture/adr/"
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
gate="$root/scripts/kit/check-adr-frontmatter.ts"
adr="$tmp/docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md"
second="$tmp/docs/kit/architecture/adr/0002-session-hmac-interim-vs-better-auth.md"
run() { ADR_FRONTMATTER_ROOT="$tmp" bun --no-install "$gate" "$@"; }
expect_failure() {
  local label="$1"
  shift
  if run "$@" >/dev/null 2>&1; then echo "Expected failure: $label" >&2; exit 1; fi
}
restore() { cp "$root/docs/kit/architecture/adr/$(basename "$1")" "$1"; }
run
sed -i 's/^status: accepted/status: invalid/' "$adr"
expect_failure status
restore "$adr"
sed -i 's/^status: accepted/status: proposed/' "$adr"
expect_failure normative-nonaccepted --write
restore "$adr"
sed -i "s/^summary:.*/summary: 'Decision (rejected)'/" "$adr"
expect_failure misleading-summary --write
restore "$adr"
sed -i '/^normative:/d' "$adr"
expect_failure missing-field
restore "$adr"
sed -i '/^summary:/d' "$adr"
expect_failure missing-summary
restore "$adr"
sed -i "s/^summary:.*/summary: ''/" "$adr"
expect_failure empty-summary
restore "$adr"
sed -i 's/Platform packages compose deployable apps/stale/' "$tmp/docs/kit/architecture/index.md"
expect_failure stale-index
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
sed -i '/| \[ADR-0001\]/d' "$tmp/docs/kit/architecture/index.md"
expect_failure missing-row
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
sed -i 's/ADR-0001/ADR-9999/' "$tmp/docs/kit/architecture/index.md"
expect_failure unknown-number
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
sed -i "/ADR-0001.* |/a | [ADR-9999](./adr/9999-ghost.md) | Ghost |" "$tmp/docs/kit/architecture/index.md"
expect_failure ghost-row
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
sed -i "s/^summary:.*/summary: 'two \\\\| three'/" "$adr"
run --write
bun -e 'const html = Bun.markdown.html(await Bun.file(process.argv[1]).text()); if (!html.includes("<td>two \\| three</td>")) throw new Error("summary did not render intact")' "$tmp/docs/kit/architecture/index.md"
run
restore "$adr"
cp "$root/docs/kit/architecture/index.md" "$tmp/docs/kit/architecture/index.md"
cp "$adr" "$tmp/docs/kit/architecture/adr/0001-duplicate.md"
expect_failure duplicate-number
rm "$tmp/docs/kit/architecture/adr/0001-duplicate.md"
sed -i "/^summary:/i supersedes: [docs/kit/architecture/adr/9999-missing.md]" "$adr"
expect_failure broken-supersession
restore "$adr"
sed -i 's/^axial: false/axial: true/' "$second"
expect_failure second-axial
restore "$second"
proposed="$tmp/docs/kit/architecture/adr/0016-tasks-owner-org-tenancy.md"
sed -i 's/^status: proposed/status: rejected/' "$proposed"
expect_failure changed-status
run --write
grep -F 'Tasks owner-org tenancy (rejected)' "$tmp/docs/kit/architecture/index.md" >/dev/null
run
echo 'ADR frontmatter mutations passed'
