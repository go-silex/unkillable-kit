#!/usr/bin/env bash
# Hermetic self-test for check-doc-hygiene.ts. Fixtures only; no network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SCANNER="${ROOT}/scripts/kit/check-doc-hygiene.ts"
[[ -f "$SCANNER" ]] || { echo "FAIL: missing $SCANNER" >&2; exit 1; }
# GATE: the package.json launch flags of this scanner.
source "${ROOT}/scripts/kit/lib/gate-launch.sh"

PASS=0
FAIL=0
assert_case() {
  local name="$1" expected="$2" tree="$3" marker="$4"
  local output rc=0
  output="$(DOC_HYGIENE_ROOT="$tree" bun "${GATE[@]}" "$SCANNER" "${5:-}" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$expected" ]] && [[ "$output" == *"$marker"* ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (expected rc=$expected and marker '$marker', got rc=$rc)" >&2
    echo "$output" >&2
    FAIL=$((FAIL + 1))
  fi
}

write_base() {
  local tree="$1"
  mkdir -p "$tree/.dev" "$tree/docs/kit" "$tree/config/kit"
  printf '{}\n' >"$tree/config/kit/doc-hygiene-baseline.json"
  cat >"$tree/.dev/stack.yml" <<'EOF'
schema_version: "1.0"
docs:
  path: docs/kit
standards:
  testing: docs/kit/testing.md
  agent_entry: AGENTS.md
  agents: AGENTS.md
  contributing: README.md
EOF
  cat >"$tree/AGENTS.md" <<'EOF'
# Agents

See the [kit index](docs/kit/README.md) and [testing](docs/kit/testing.md).
EOF
  cat >"$tree/README.md" <<'EOF'
# Fixture

See the [kit index](docs/kit/README.md).
EOF
  cat >"$tree/docs/kit/README.md" <<'EOF'
# Kit documentation

- [Testing](testing.md)
EOF
  cat >"$tree/docs/kit/testing.md" <<'EOF'
# Testing

Back to the [index](README.md#kit-documentation).
[External](https://example.test) [mail](mailto:test@example.test) [anchor](#testing)
[home](~/notes.md) [placeholder](<DOC_PATH>) [later](...)

```md
[example only](missing-in-fence.md)
```
EOF
}

TMP="$(mktemp -d -t doc-hygiene.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "== doc hygiene self-test =="
BASE="$TMP/base"
write_base "$BASE"
MALFORMED="$TMP/malformed-baseline"
cp -R "$BASE" "$MALFORMED"
printf '{"README.md":{"overLimitLines":-1,"maxLineBytes":1,"fileBytes":1}}\n' >"$MALFORMED/config/kit/doc-hygiene-baseline.json"
assert_case "invalid baseline fails closed" 1 "$MALFORMED" "cannot read baseline"

assert_case "valid documentation tree" 0 "$BASE" "check-doc-hygiene: OK"

BROKEN="$TMP/broken-link"
cp -R "$BASE" "$BROKEN"
printf '\n[Broken](missing.md)\n' >>"$BROKEN/README.md"
assert_case "broken internal link" 1 "$BROKEN" "README.md:5: broken internal link: missing.md"

STANDARD="$TMP/missing-standard"
cp -R "$BASE" "$STANDARD"
printf '  absent: docs/kit/absent.md\n' >>"$STANDARD/.dev/stack.yml"
assert_case "missing standard target" 1 "$STANDARD" "absent target does not exist"

ORPHAN="$TMP/orphan"
cp -R "$BASE" "$ORPHAN"
printf '# Orphan\n' >"$ORPHAN/docs/kit/orphan.md"
assert_case "documentation not indexed" 1 "$ORPHAN" "document is not referenced by docs/kit/README.md"

# Limits count UTF-8 bytes, including fenced and reference lines; the newline
# is part of file size but not line length. No line exemptions.
BUDGET="$TMP/budget"
cp -R "$BASE" "$BUDGET"
printf '%0400d\n' 0 >"$BUDGET/README.md"
assert_case "400-byte line accepted" 0 "$BUDGET" "check-doc-hygiene: OK"
printf '%0401d\n' 0 >"$BUDGET/README.md"
assert_case "new long line in clean file" 1 "$BUDGET" "new documentation budget violation"
printf '```text\n%0401d\n```\n' 0 >"$BUDGET/README.md"
assert_case "fenced long line counts" 1 "$BUDGET" "new documentation budget violation"
printf '[ref]: https://example.test/%0400d\n' 0 >"$BUDGET/README.md"
assert_case "link reference long line counts" 1 "$BUDGET" "new documentation budget violation"
printf '%0200d' 0 | tr '0' 'x' >"$BUDGET/README.md"
printf '%s\n' "$(printf 'é%.0s' {1..100})" >>"$BUDGET/README.md"
assert_case "400-byte multibyte line accepted" 0 "$BUDGET" "check-doc-hygiene: OK"
printf '%s\n' "$(printf 'é%.0s' {1..201})" >"$BUDGET/README.md"
assert_case "multibyte line exceeds budget" 1 "$BUDGET" "new documentation budget violation"

rm "$BUDGET/config/kit/doc-hygiene-baseline.json"
assert_case "regeneration requires an existing baseline" 1 "$BUDGET" "cannot read baseline" --regenerate-baseline
assert_case "initial baseline construction" 0 "$BUDGET" "check-doc-hygiene: OK" --init-baseline
assert_case "initial baseline cannot overwrite" 1 "$BUDGET" "initial baseline already exists" --init-baseline
cp "$BUDGET/config/kit/doc-hygiene-baseline.json" "$TMP/original-baseline"
printf '%0401d\n' 0 >>"$BUDGET/README.md"
assert_case "new long line in baselined file" 1 "$BUDGET" "overLimitLines"
assert_case "regeneration refuses increase" 1 "$BUDGET" "documentation budget worsened" --regenerate-baseline
if ! cmp -s "$TMP/original-baseline" "$BUDGET/config/kit/doc-hygiene-baseline.json"; then
  echo "FAIL: refused regeneration changed baseline" >&2; FAIL=$((FAIL + 1))
fi
cp -R "$BASE" "$TMP/growth"
GROWTH="$TMP/growth"
printf '%0401d\n%0401d\n' 0 0 >"$GROWTH/README.md"
rm "$GROWTH/config/kit/doc-hygiene-baseline.json"
assert_case "construct growth baseline" 0 "$GROWTH" "check-doc-hygiene: OK" --init-baseline
printf 'small\n' >>"$GROWTH/README.md"
assert_case "baselined file grows" 1 "$GROWTH" "fileBytes"
printf '%0402d\n' 0 >"$GROWTH/README.md"
assert_case "mixed improvement and worsening refused" 1 "$GROWTH" "documentation budget worsened" --regenerate-baseline
printf '%0400d\n%0401d\n' 0 0 >"$GROWTH/README.md"
assert_case "lower metrics make baseline stale" 1 "$GROWTH" "stale documentation budget baseline"
assert_case "regeneration lowers metrics" 0 "$GROWTH" "check-doc-hygiene: OK" --regenerate-baseline
printf '%0400d\n' 0 >"$GROWTH/README.md"
assert_case "improvement makes baseline stale" 1 "$GROWTH" "stale documentation budget baseline"
assert_case "regeneration drops improvement" 0 "$GROWTH" "check-doc-hygiene: OK" --regenerate-baseline
assert_case "regenerated baseline is current" 0 "$GROWTH" "check-doc-hygiene: OK"

SIZE="$TMP/size"
cp -R "$BASE" "$SIZE"
for ((i = 0; i < 150; i++)); do printf '%0399d\n' 0; done >"$SIZE/docs/kit/large.md"
printf '%s\n' '- [Large](large.md)' >>"$SIZE/docs/kit/README.md"
assert_case "60000-byte file accepted" 0 "$SIZE" "check-doc-hygiene: OK"
printf '\n' >>"$SIZE/docs/kit/large.md"
assert_case "new file over 60000 bytes" 1 "$SIZE" "new documentation budget violation"

# A formerly oversized file may not drop out of the baseline while another
# frozen metric worsens, even when its new line length is below the limit.
DROP="$TMP/drop"
cp -R "$BASE" "$DROP"
for ((i = 0; i < 30001; i++)); do printf 'x\n'; done >"$DROP/README.md"
rm "$DROP/config/kit/doc-hygiene-baseline.json"
assert_case "construct oversized baseline" 0 "$DROP" "check-doc-hygiene: OK" --init-baseline
printf 'xx\n' >"$DROP/README.md"
assert_case "drop with a worse metric refused" 1 "$DROP" "documentation budget worsened: maxLineBytes" --regenerate-baseline

# A cwd .env or bunfig preload re-points the root unless the package.json flags close it.
assert_gate_launch DOC_HYGIENE_ROOT "$BROKEN" "README.md:5: broken internal link: missing.md"

echo "== doc hygiene summary: $PASS pass, $FAIL fail =="
[[ "$FAIL" -eq 0 ]]
