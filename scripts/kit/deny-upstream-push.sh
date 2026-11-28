#!/usr/bin/env bash
# Block product repos from pushing to kit / intermediate parents.
#
# Shipped **in the kit** so product forks need NOT edit lefthook.yml.
#
# Kit clone heuristic (brand-agnostic, ADR-0009):
#   no config/product/inheritance.json → kit → allow
# Product clone:
#   has inheritance marker (or transitional kit-baseline) → deny remote name `upstream`
#   + optional URL substrings
#
# Product multi-hop extend (zero-edit free — do not patch this file):
#   - env DENY_UPSTREAM_URL_SUBSTRINGS=comma,separated,slugs
#   - docs/product/deny-upstream.json → { "urlSubstrings": ["…"] }
#   - optional kit config/kit/deny-upstream-remotes.json (kit-generic only)
#
# The pre-push wrapper passes the remote name and URL, in that order.
#
# Client-side UX only — LEFTHOOK=0 / --no-verify still bypass; real integrity = GH write ACLs.
set -euo pipefail

remote_name="${1:-}"
remote_url="${2:-}"

# Resolve monorepo root (lefthook / harness may run with different $PWD).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi

deny() {
  echo "deny-upstream-push: blocked push to denied parent/kit remote" >&2
  echo "  remote=${remote_name:-?} url=${remote_url:-?}" >&2
  echo "  Shared kit changes → land on a kit clone (push origin / contribute flow)." >&2
  echo "  Product repo → only: git push origin …" >&2
  echo "  Multi-hop: DENY_UPSTREAM_URL_SUBSTRINGS or docs/product/deny-upstream.json" >&2
  exit 1
}

# Lowercase owner/repo from a git remote URL. Empty if not that shape.
normalize_owner_repo() {
  local u="${1:-}"
  u="${u#"${u%%[![:space:]]*}"}"
  u="${u%"${u##*[![:space:]]}"}"
  u="${u%%\?*}"
  u="${u%%#*}"
  u="${u%/}"
  u="${u%.git}"
  local path=""
  if [[ "${u}" == ssh://* ]]; then
    path="${u#ssh://}"
    path="${path#*@}"
    path="${path#*/}"
  elif [[ "${u}" == http://* || "${u}" == https://* ]]; then
    path="${u#*://}"
    path="${path#*/}"
  elif [[ "${u}" != *://* && "${u}" == *:* ]]; then
    # scp-style: [user@]host:owner/repo — user is not always git
    path="${u#*:}"
  elif [[ "${u}" == */* ]]; then
    path="${u}"
  else
    return 0
  fi
  path="${path#/}"
  local owner="${path%%/*}"
  local rest="${path#*/}"
  local repo="${rest%%/*}"
  if [[ -z "${owner}" || -z "${repo}" || "${owner}" == "${path}" ]]; then
    return 0
  fi
  printf '%s/%s' "$(printf '%s' "${owner}" | tr '[:upper:]' '[:lower:]')" "$(printf '%s' "${repo}" | tr '[:upper:]' '[:lower:]')"
}

is_owner_repo_token() {
  [[ "${1}" =~ ^[^[:space:]/]+/[^[:space:]/]+$ ]]
}

# Collect urlSubstrings from a JSON file via Bun (missing/invalid → empty, warn once).
# Prints one substring per line (trimmed, non-empty).
read_json_substrings() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "deny-upstream-push: warn: bun not found; ignoring ${file}" >&2
    return 0
  fi
  # shellcheck disable=SC2016
  if ! bun -e '
    const fs = require("fs");
    const path = process.argv[1];
    let raw;
    try { raw = fs.readFileSync(path, "utf8"); } catch { process.exit(0); }
    let data;
    try { data = JSON.parse(raw); } catch {
      console.error("deny-upstream-push: warn: invalid JSON, ignoring " + path);
      process.exit(0);
    }
    const arr = data && Array.isArray(data.urlSubstrings) ? data.urlSubstrings : [];
    for (const s of arr) {
      if (typeof s === "string") {
        const t = s.trim();
        if (t) console.log(t);
      }
    }
  ' "${file}" 2>/dev/null; then
    return 0
  fi
}

# --- kit tree: no product inheritance marker → maintainer no-op ---
if [[ ! -f "${REPO_ROOT}/config/product/inheritance.json" ]]; then
  exit 0
fi

# --- build substring denylist (union) — no brand builtins ---
declare -a SUBSTRINGS=()

while IFS= read -r line; do
  [[ -n "${line}" ]] && SUBSTRINGS+=("${line}")
done < <(read_json_substrings "${REPO_ROOT}/config/kit/deny-upstream-remotes.json")

while IFS= read -r line; do
  [[ -n "${line}" ]] && SUBSTRINGS+=("${line}")
done < <(read_json_substrings "${REPO_ROOT}/docs/product/deny-upstream.json")

if [[ -n "${DENY_UPSTREAM_URL_SUBSTRINGS:-}" ]]; then
  IFS=',' read -ra ENV_PARTS <<< "${DENY_UPSTREAM_URL_SUBSTRINGS}"
  for part in "${ENV_PARTS[@]}"; do
    trimmed="$(echo "${part}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "${trimmed}" ]] && SUBSTRINGS+=("${trimmed}")
  done
fi

# Product: never push to a remote named upstream (immediate parent convention)
if [[ "${remote_name}" == "upstream" ]]; then
  deny
fi

# Product: owner/repo entries match the normalized identity (exact, case-insensitive).
# Other entries stay raw URL substrings (private chassis).
remote_id="$(normalize_owner_repo "${remote_url}")"
for s in "${SUBSTRINGS[@]}"; do
  [[ -z "${s}" ]] && continue
  if is_owner_repo_token "${s}"; then
    entry_id="$(normalize_owner_repo "${s}")"
    if [[ -n "${remote_id}" && -n "${entry_id}" && "${remote_id}" == "${entry_id}" ]]; then
      deny
    fi
  elif [[ "${remote_url}" == *"${s}"* ]]; then
    deny
  fi
done

exit 0
