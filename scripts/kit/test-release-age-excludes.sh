#!/usr/bin/env bash
# Hermetic fixtures for the release-age exemption gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="${ROOT}/scripts/kit/check-release-age-excludes.ts"
source "${ROOT}/scripts/kit/lib/gate-launch.sh"
TMP="$(mktemp -d -t release-age-excludes.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
assert_case() {
  local name="$1" expected="$2" marker="$3" output rc=0
  output="$(FIXTURE_ROOT="$TMP" FIXTURE_SCANNER="$SCANNER" bun "${GATE[@]}" -e \
    'const { checkReleaseAgeExcludes } = await import(process.env.FIXTURE_SCANNER); checkReleaseAgeExcludes(process.env.FIXTURE_ROOT)' 2>&1)" || rc=$?
  if [[ "$rc" -eq "$expected" && "$output" == *"$marker"* ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (rc=$rc, expected $expected and '$marker'): $output" >&2
    FAIL=$((FAIL + 1))
  fi
}
fixture() { printf '[install]\nminimumReleaseAgeExcludes = [%s]\n' "$1" >"$TMP/bunfig.toml"; }
printf '[install]\nminimumReleaseAge = 259200\n' >"$TMP/bunfig.toml"
assert_case 'absent list' 0 '0 exemption(s)'
fixture ''
assert_case 'empty list' 0 '0 exemption(s)'
fixture '"pkg@1.2.3", "@scope/name@0.0.1-alpha.1", "a-b.c_d@10.20.30", "@_scope/-name@1.0.0", "@.scope/_name@1.0.0", "@scope/node_modules@1.0.0", "pkg@18446744073709551615.18446744073709551615.18446744073709551615-18446744073709551616"'
assert_case 'exact names and versions including large numeric prerelease' 0 '7 exemption(s)'
for spec in 'pkg' 'pkg@^1.2.0' 'pkg@latest' 'pkg@1.0.0 || 1.0.1' '@scope@1.2.3' '@scope/name/extra@1.2.3' '@scope/.@1.0.0' '@scope/..@1.0.0' '@scope/.name@1.0.0' 'Bad@1.2.3' '_bad@1.2.3' '.bad@1.2.3' 'node_modules@1.2.3' 'favicon.ico@1.2.3' '@Scope/name@1.2.3' '@scope/Name@1.2.3' 'pkg@01.2.3' 'pkg@1.2.3-01' 'pkg@1.2.3-' 'pkg@1.2.3+build' 'pkg@1.2.3-alpha+build' 'pkg@1.2.3+foo..bar' 'pkg@1.2' 'pkg@1.2.3 ' 'pkg@18446744073709551616.0.0' 'pkg@0.18446744073709551616.0' 'pkg@0.0.18446744073709551616' ; do
  fixture "\"$spec\""
  assert_case "reject $spec" 1 "$spec"
done
long_name="$(printf '%0214d' 0)"
fixture "\"$long_name@1.0.0\""
assert_case '214-character package name' 0 '1 exemption(s)'
fixture "\"${long_name}a@1.0.0\""
assert_case 'reject 215-character package name' 1 'not an exact package version'
fixture '42'
assert_case 'reject non-string' 1 'minimumReleaseAgeExcludes[0] 42'
fixture '"pkg@1.2.3", "pkg@1.2.3"'
assert_case 'reject duplicate' 1 'minimumReleaseAgeExcludes[1] "pkg@1.2.3" is duplicated'
printf '[install]\nminimumReleaseAgeExcludes = "pkg@1.2.3"\n' >"$TMP/bunfig.toml"
assert_case 'reject non-list' 1 'not a list'
printf '[install]\nminimumReleaseAgeExcludes = [\n' >"$TMP/bunfig.toml"
assert_case 'reject malformed TOML' 1 'Fix bunfig.toml'
mkdir -p "$TMP/copied/scripts/kit" "$TMP/alternate"
cp "$SCANNER" "$TMP/copied/scripts/kit/check-release-age-excludes.ts"
printf '[install]\nminimumReleaseAgeExcludes = []\n' >"$TMP/alternate/bunfig.toml"
printf '[install]\nminimumReleaseAgeExcludes = []\n' >"$TMP/copied/bunfig.toml"
production_rc=0
production="$(cd "$TMP/alternate" && RELEASE_AGE_ROOT="$TMP/alternate" FIXTURE_ROOT="$TMP/alternate" \
  FIXTURE_SCANNER="$SCANNER" bun "${GATE[@]}" "$TMP/copied/scripts/kit/check-release-age-excludes.ts" 2>&1)" || production_rc=$?
if [[ "$production_rc" -eq 0 && "$production" == *'check-release-age-excludes: OK (0 exemption(s))'* ]]; then
  echo 'PASS: copied production entrypoint accepts valid script-relative config'
  PASS=$((PASS + 1))
else
  echo "FAIL: copied production entrypoint did not succeed (rc=$production_rc): $production" >&2
  FAIL=$((FAIL + 1))
fi
printf '[install]\nminimumReleaseAgeExcludes = ["pkg"]\n' >"$TMP/copied/bunfig.toml"
production_rc=0
production="$(cd "$TMP/alternate" && RELEASE_AGE_ROOT="$TMP/alternate" FIXTURE_ROOT="$TMP/alternate" \
  FIXTURE_SCANNER="$SCANNER" bun "${GATE[@]}" "$TMP/copied/scripts/kit/check-release-age-excludes.ts" 2>&1)" || production_rc=$?
if [[ "$production_rc" -eq 1 && "$production" == *'minimumReleaseAgeExcludes[0] "pkg" is not an exact package version'* ]]; then
  echo 'PASS: production entrypoint rejects invalid script-relative config despite cwd and environment'
  PASS=$((PASS + 1))
else
  echo "FAIL: production entrypoint did not reject script-relative config (rc=$production_rc): $production" >&2
  FAIL=$((FAIL + 1))
fi
echo "== Release-age exemptions: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
