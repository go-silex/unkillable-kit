#!/usr/bin/env bash
# CP-FALSIFY — mechanical canary: oracle tests MUST fail with assertion failures
# when isGlobOrNullOrigin is neutered. Requires a healthy baseline before mutation,
# uses a disposable package copy and re-runs the original oracle green afterward.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${ROOT}/packages/auth/src/better-auth-env.ts"
TEST_FILE="${ROOT}/packages/auth/src/better-auth-origins.test.ts"
ORACLE_FILE="src/better-auth-origins.test.ts"
REL="packages/auth/src/better-auth-env.ts"

# shellcheck source=/dev/null
source_classifier() {
  python3 - "$@" <<'PY'
import json
import sys


def parse_vitest_report(text: str) -> dict | None:
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def assertion_failures(report: dict) -> tuple[int, list[str]]:
    count = 0
    snippets: list[str] = []
    for suite in report.get("testResults", []):
        for assertion in suite.get("assertionResults", []):
            if assertion.get("status") != "failed":
                continue
            messages = assertion.get("failureMessages") or []
            if not messages:
                continue
            count += 1
            first = messages[0].splitlines()[0].strip()
            snippets.append(first)
    return count, snippets


def suite_infra_messages(report: dict) -> list[str]:
    msgs: list[str] = []
    for suite in report.get("testResults", []):
        if suite.get("status") != "failed":
            continue
        if suite.get("assertionResults"):
            continue
        msg = (suite.get("message") or "").strip()
        if msg:
            msgs.append(msg)
    return msgs


def classify(mode: str, exit_code: int, raw_output: str) -> tuple[str, str]:
    report = parse_vitest_report(raw_output)
    if report is None:
        return "infra", "no parseable Vitest JSON report"

    total = int(report.get("numTotalTests") or 0)
    failed = int(report.get("numFailedTests") or 0)
    success = bool(report.get("success"))
    assertion_count, snippets = assertion_failures(report)
    infra_msgs = suite_infra_messages(report)

    if mode == "baseline":
        if total <= 0:
            hint = infra_msgs[0] if infra_msgs else "0 tests collected"
            return "infra", f"baseline collected 0 tests: {hint}"
        if exit_code != 0:
            tail = "\n".join(raw_output.splitlines()[-12:])
            return "fail", f"baseline exit {exit_code} (expected 0)\n{tail}"
        if failed != 0 or not success:
            return "fail", f"baseline unhealthy: {failed}/{total} failed"
        return "ok", f"baseline green ({total} tests)"

    if mode == "mutated":
        if exit_code == 0:
            return "fail", "mutated oracle still passed (tautological?)"
        if total <= 0:
            hint = infra_msgs[0] if infra_msgs else "0 tests collected"
            return "infra", f"mutated run executed 0 tests: {hint}"
        if assertion_count <= 0:
            if infra_msgs:
                return "infra", infra_msgs[0]
            return (
                "infra",
                f"non-zero exit but no assertion failures (failedTests={failed})",
            )
        summary = "; ".join(snippets[:3])
        return "ok", summary

    raise SystemExit(f"unknown mode: {mode}")


def run_self_test() -> None:
    healthy = {
        "numTotalTests": 6,
        "numFailedTests": 0,
        "success": True,
        "testResults": [
            {
                "status": "passed",
                "assertionResults": [{"status": "passed", "failureMessages": []}],
            }
        ],
    }
    mutated = {
        "numTotalTests": 6,
        "numFailedTests": 2,
        "success": False,
        "testResults": [
            {
                "status": "failed",
                "assertionResults": [
                    {
                        "status": "failed",
                        "failureMessages": ["AssertionError: expected throw"],
                    }
                ],
            }
        ],
    }
    import_fail = {
        "numTotalTests": 0,
        "numFailedTests": 0,
        "success": False,
        "testResults": [
            {
                "status": "failed",
                "message": 'Failed to resolve import "zod"',
                "assertionResults": [],
            }
        ],
    }

    cases = [
        ("baseline-healthy", "baseline", 0, json.dumps(healthy), "ok"),
        ("mutated-assertions", "mutated", 1, json.dumps(mutated), "ok"),
        ("baseline-import", "baseline", 1, json.dumps(import_fail), "infra"),
        ("mutated-import", "mutated", 1, json.dumps(import_fail), "infra"),
        ("mutated-still-green", "mutated", 0, json.dumps(healthy), "fail"),
    ]

    failed = 0
    for name, mode, code, payload, expect in cases:
        kind, detail = classify(mode, code, payload)
        if kind != expect:
            print(f"  FAIL: {name} expected {expect}, got {kind}: {detail}", file=sys.stderr)
            failed += 1
        else:
            print(f"  PASS: {name} ({kind})")

    if failed:
        raise SystemExit(f"self-test: {failed} classifier case(s) failed")
    print("self-test: classifier OK")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--self-test":
        run_self_test()
        sys.exit(0)

    mode = sys.argv[1]
    exit_code = int(sys.argv[2])
    raw_path = sys.argv[3]
    raw_output = open(raw_path, encoding="utf-8").read()
    kind, detail = classify(mode, exit_code, raw_output)
    print(kind)
    print(detail)
PY
}

run_oracle() {
  local package_dir="$1"
  local json_file got
  json_file="${TEMP_DIR}/oracle.json"
  set +e
  (
    cd "${package_dir}"
    bun run test -- "${ORACLE_FILE}" --reporter=json --outputFile="${json_file}"
  ) >/dev/null 2>&1
  got=$?
  set -e
  ORACLE_EXIT=$got
  ORACLE_OUT="$(cat "${json_file}")"
  rm -f "${json_file}"
}

classify_oracle() {
  local mode="$1"
  local tmp
  tmp="${TEMP_DIR}/classification.txt"
  printf '%s' "${ORACLE_OUT}" >"${tmp}"
  source_classifier "${mode}" "${ORACLE_EXIT}" "${tmp}"
  rm -f "${tmp}"
}

if [[ "${1:-}" == "--self-test" ]]; then
  echo "== CP-FALSIFY classifier self-test =="
  source_classifier --self-test
  exit 0
fi

if [[ ! -f "${TARGET}" ]]; then
  echo "FAIL: missing ${TARGET}" >&2
  exit 1
fi
if [[ ! -f "${TEST_FILE}" ]]; then
  echo "FAIL: no oracle test file found (${TEST_FILE})" >&2
  exit 1
fi
if ! grep -q 'assertTrustedOrigins' "${TEST_FILE}"; then
  echo "FAIL: ${TEST_FILE} does not exercise assertTrustedOrigins" >&2
  exit 1
fi
if ! grep -q 'isGlobOrNullOrigin' "${TARGET}"; then
  echo "FAIL: isGlobOrNullOrigin not found in ${TARGET}" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kit-falsify.XXXXXX")"
trap 'rm -rf "${TEMP_DIR}"' EXIT
mkdir -p "${TEMP_DIR}/packages/auth"
tar -C "${ROOT}/packages/auth" --exclude=node_modules --exclude=.vitest -cf - . |
  tar -C "${TEMP_DIR}/packages/auth" -xf -
ln -s "${ROOT}/packages/auth/node_modules" "${TEMP_DIR}/packages/auth/node_modules"
ln -s "${ROOT}/node_modules" "${TEMP_DIR}/node_modules"
ln -s "${ROOT}/packages/config" "${TEMP_DIR}/packages/config"
ln -s "${ROOT}/packages/ui" "${TEMP_DIR}/packages/ui"

echo "== CP-FALSIFY baseline =="
run_oracle "${ROOT}/packages/auth"
mapfile -t BASELINE_RESULT < <(classify_oracle baseline)
BASELINE_KIND="${BASELINE_RESULT[0]}"
BASELINE_DETAIL="$(printf '%s\n' "${BASELINE_RESULT[@]:1}")"
if [[ "${BASELINE_KIND}" == "infra" ]]; then
  echo "FAIL: baseline infrastructure error — ${BASELINE_DETAIL}" >&2
  exit 1
fi
if [[ "${BASELINE_KIND}" != "ok" ]]; then
  echo "FAIL: unhealthy baseline — ${BASELINE_DETAIL}" >&2
  exit 1
fi
echo "  ${BASELINE_DETAIL}"

python3 - "${TEMP_DIR}/${REL}" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
pat = re.compile(
    r"function isGlobOrNullOrigin\([^)]*\):\s*boolean\s*\{.*?\n\}",
    re.S,
)
match = pat.search(text)
if not match:
    sys.exit(f"FAIL: could not locate isGlobOrNullOrigin body in {path}")
mutated = "function isGlobOrNullOrigin(_o: string): boolean {\n  return false\n}"
path.write_text(text[: match.start()] + mutated + text[match.end() :])
PY

echo "== CP-FALSIFY mutated oracle =="
run_oracle "${TEMP_DIR}/packages/auth"
mapfile -t MUTATED_RESULT < <(classify_oracle mutated)
MUTATED_KIND="${MUTATED_RESULT[0]}"
MUTATED_DETAIL="$(printf '%s\n' "${MUTATED_RESULT[@]:1}")"
if [[ "${MUTATED_KIND}" == "infra" ]]; then
  echo "FAIL: mutated run failed for infrastructure reasons — ${MUTATED_DETAIL}" >&2
  echo "${ORACLE_OUT}" >&2
  exit 1
fi
if [[ "${MUTATED_KIND}" != "ok" ]]; then
  echo "FAIL: ${MUTATED_DETAIL}" >&2
  echo "${ORACLE_OUT}" >&2
  exit 1
fi
cp "${TARGET}" "${TEMP_DIR}/${REL}"

echo "== CP-FALSIFY post-restore baseline =="
run_oracle "${TEMP_DIR}/packages/auth"
mapfile -t POST_RESULT < <(classify_oracle baseline)
POST_KIND="${POST_RESULT[0]}"
POST_DETAIL="$(printf '%s\n' "${POST_RESULT[@]:1}")"
if [[ "${POST_KIND}" != "ok" ]]; then
  echo "FAIL: post-restore baseline — ${POST_DETAIL}" >&2
  exit 1
fi
echo "  ${POST_DETAIL}"

echo "broke ${REL} → test failed with ${MUTATED_DETAIL}"
exit 0
