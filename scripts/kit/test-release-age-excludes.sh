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
  output="$(RELEASE_AGE_ROOT="$TMP" bun "${GATE[@]}" "$SCANNER" 2>&1)" || rc=$?
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
fixture '"pkg@1.2.3", "@scope/name@0.0.1-alpha.1+build.01", "a-b.c_d@10.20.30+sha-1"'
assert_case 'exact versions including prerelease and build' 0 '3 exemption(s)'
for spec in 'pkg' 'pkg@^1.2.0' 'pkg@latest' 'pkg@1.0.0 || 1.0.1' '@scope@1.2.3' '@scope/name/extra@1.2.3' 'Bad@1.2.3' '_bad@1.2.3' 'pkg@01.2.3' 'pkg@1.2.3-01' 'pkg@1.2.3-' 'pkg@1.2.3+foo..bar' 'pkg@1.2' 'pkg@1.2.3 ' ; do
  fixture "\"$spec\""
  assert_case "reject $spec" 1 "$spec"
done
fixture '42'
assert_case 'reject non-string' 1 'minimumReleaseAgeExcludes[0] 42'
fixture '"pkg@1.2.3", "pkg@1.2.3"'
assert_case 'reject duplicate' 1 'minimumReleaseAgeExcludes[1] "pkg@1.2.3" is duplicated'
printf '[install]\nminimumReleaseAgeExcludes = "pkg@1.2.3"\n' >"$TMP/bunfig.toml"
assert_case 'reject non-list' 1 'not a list'
printf '[install]\nminimumReleaseAgeExcludes = [\n' >"$TMP/bunfig.toml"
assert_case 'reject malformed TOML' 1 'Fix bunfig.toml'
mkdir -p "$TMP/stolen"
printf '[install]\nminimumReleaseAgeExcludes = ["pkg"]\n' >"$TMP/stolen/bunfig.toml"
assert_gate_launch RELEASE_AGE_ROOT "$TMP/stolen" 'not an exact package version'
echo "== Release-age exemptions: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
