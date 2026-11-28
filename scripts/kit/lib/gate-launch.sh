# Gate launch for the kit scanner self-tests (Roxabi/roxabi-boilerplate-cf#370).
# Source after ROOT and SCANNER are set; assert_gate_launch also needs TMP and the PASS / FAIL
# counters.
#
# GATE holds the flags the root package.json launches SCANNER with. Every script segment that runs
# it must agree. --config is made absolute so that a fixture can launch from any cwd. Bun reads a cwd
# .env and a cwd bunfig.toml (preload, define) before the gate's own code runs; --no-env-file and
# --config close those two channels. The fixture launches drop the BUN_OPTIONS that the Root gate
# gives its tasks, so that they test the package.json flags alone.

# shellcheck shell=bash

_gate_flags="$(node -e '
  const [pkg, rel] = process.argv.slice(1)
  const scripts = JSON.parse(require("node:fs").readFileSync(pkg, "utf8")).scripts ?? {}
  const flags = new Set()
  for (const line of Object.values(scripts))
    for (const segment of line.split("&&")) {
      const words = segment.trim().split(/\s+/)
      if (words.at(-1) !== rel) continue
      if (words[0] !== "bun") {
        console.error(`package.json launches ${rel} without bun: ${segment.trim()}`)
        process.exit(1)
      }
      flags.add(words.slice(1, words.at(-2) === "run" ? -2 : -1).join(" "))
    }
  if (flags.size !== 1) {
    console.error(`package.json must launch ${rel} with one set of flags, found ${flags.size}`)
    process.exit(1)
  }
  for (const flag of [...flags][0].split(" ")) if (flag !== "") console.log(flag)
' "$ROOT/package.json" "${SCANNER#"$ROOT"/}")" || {
  echo "FAIL: cannot read the package.json launch flags of $SCANNER" >&2
  exit 1
}
GATE=()
while IFS= read -r _flag; do
  case "$_flag" in
    "") continue ;;
    --config=/*) ;;
    --config=*) _flag="--config=${ROOT}/${_flag#--config=}" ;;
  esac
  GATE+=("$_flag")
done <<<"$_gate_flags"
unset _flag _gate_flags

# assert_gate_requires_install <script> <diagnostic> — copy the current tracked tree into a new
# temporary root that ignores TMP/TMPDIR, then prove its actual resolver cannot find yaml before
# running the package script with a fresh Bun cache. IP network tracing is an additional observation
# when strace is available; the missing-dependency, cache and node_modules assertions are portable.
assert_gate_requires_install() {
  local script="$1" diagnostic="$2" fixture cache trace='' resolution output diagnostic_count cached
  local resolution_rc=0 rc=0 network_ok=1
  if [[ " ${GATE[*]} " != *" --no-install "* ]]; then
    echo "FAIL: ${script} launcher must pass --no-install" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if ! fixture="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}" gate-launch.XXXXXX)"; then
    echo "FAIL: ${script} could not create an isolated dependency-free fixture" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  cache="$fixture/cache"
  mkdir "$cache"
  if ! git -C "$ROOT" ls-files -z | tar -C "$ROOT" --null --files-from=- -cf - | tar -xf - -C "$fixture"; then
    echo "FAIL: ${script} could not copy the tracked tree into its fixture" >&2
    rm -rf "$fixture"
    FAIL=$((FAIL + 1))
    return
  fi
  resolution="$(
    cd "$fixture" &&
      env BUN_INSTALL_CACHE_DIR="$cache" NODE_PATH= bun --no-env-file --no-install -e '
        const { createRequire } = require("node:module")
        const requireYaml = createRequire(`${process.cwd()}/packages/flows/package.json`)
        try {
          process.stdout.write(requireYaml.resolve("yaml"))
          process.exit(1)
        } catch (error) {
          if (error && typeof error === "object" && error.code === "MODULE_NOT_FOUND") process.exit(0)
          console.error(error)
          process.exit(2)
        }
      '
  )" || resolution_rc=$?
  if [[ "$resolution_rc" -ne 0 || -n "$resolution" ]]; then
    echo "FAIL: ${script} fixture resolver found yaml or failed unexpectedly: ${resolution:-exit $resolution_rc}" >&2
    rm -rf "$fixture"
    FAIL=$((FAIL + 1))
    return
  fi
  if command -v strace >/dev/null; then
    trace="$fixture/network.trace"
    output="$(
      cd "$fixture" &&
        env \
          BUN_INSTALL_CACHE_DIR="$cache" \
          NODE_PATH= \
          HTTP_PROXY=http://127.0.0.1:9 \
          HTTPS_PROXY=http://127.0.0.1:9 \
          ALL_PROXY=http://127.0.0.1:9 \
          NO_PROXY= \
          strace -f -e trace=network -o "$trace" bun run "$script" 2>&1
    )" || rc=$?
    grep -Eq 'AF_INET6?' "$trace" && network_ok=0
  else
    output="$(
      cd "$fixture" &&
        env \
          BUN_INSTALL_CACHE_DIR="$cache" \
          NODE_PATH= \
          HTTP_PROXY=http://127.0.0.1:9 \
          HTTPS_PROXY=http://127.0.0.1:9 \
          ALL_PROXY=http://127.0.0.1:9 \
          NO_PROXY= \
          bun run "$script" 2>&1
    )" || rc=$?
  fi
  diagnostic_count="$(grep -Fxc "$diagnostic" <<<"$output" || true)"
  cached="$(find "$cache" -type f -print -quit)"
  if [[ "$rc" -ne 0 ]] \
    && [[ "$diagnostic_count" -eq 1 ]] \
    && [[ ! -e "$fixture/node_modules" ]] \
    && [[ -z "$cached" ]] \
    && ! grep -Fq 'Cannot find package' <<<"$output" \
    && ! grep -Eq '^[[:space:]]*at .*\(' <<<"$output" \
    && [[ "$network_ok" -eq 1 ]]; then
    if [[ -n "$trace" ]]; then
      echo "PASS: ${script}-requires-install (no IP network syscall observed)"
    else
      echo "PASS: ${script}-requires-install (IP network trace unavailable: strace not installed)"
    fi
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${script}-requires-install (expected one diagnostic, no node_modules/cache files, and no IP network syscall when traced; rc=$rc)" >&2
    printf 'output:\n%s\n' "$output" >&2
    [[ -z "$trace" ]] || { printf 'trace:\n' >&2; cat "$trace" >&2; }
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$fixture"
}

# assert_gate_rethrows_yaml_initialization <script> <diagnostic> — run the actual package script
# with a locally resolved yaml entrypoint that throws during evaluation. That error is not a missing
# dependency and must stay visible rather than becoming the install diagnostic.
assert_gate_rethrows_yaml_initialization() {
  local script="$1" diagnostic="$2" fixture output
  local init_error="Cannot find package 'yaml' during installed package initialization" rc=0
  if ! fixture="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}" gate-launch-init.XXXXXX)"; then
    echo "FAIL: ${script} could not create an initialization-error fixture" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if ! git -C "$ROOT" ls-files -z | tar -C "$ROOT" --null --files-from=- -cf - | tar -xf - -C "$fixture"; then
    echo "FAIL: ${script} could not copy the tracked tree into its initialization-error fixture" >&2
    rm -rf "$fixture"
    FAIL=$((FAIL + 1))
    return
  fi
  mkdir -p "$fixture/node_modules/yaml"
  printf '%s\n' '{"name":"yaml","version":"0.0.0-test","main":"index.js"}' \
    >"$fixture/node_modules/yaml/package.json"
  printf '%s\n' \
    "const error = new Error(\"${init_error}\")" \
    "error.code = 'E_YAML_INIT'" \
    'throw error' >"$fixture/node_modules/yaml/index.js"
  output="$(cd "$fixture" && env NODE_PATH= bun run "$script" 2>&1)" || rc=$?
  if [[ "$rc" -ne 0 ]] && [[ "$output" == *"$init_error"* ]] && ! grep -Fq "$diagnostic" <<<"$output"; then
    echo "PASS: ${script}-yaml-initialization-error"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${script}-yaml-initialization-error (the installed module error must not become the install diagnostic; rc=$rc)" >&2
    printf 'output:\n%s\n' "$output" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$fixture"
}

# assert_gate_launch <root variable> <stolen root> <stolen marker> — launch SCANNER with GATE and
# the root variable unset, as package.json runs it, from a cwd whose .env sets that variable to
# <stolen root>, then from one whose bunfig.toml preload does. Under GATE each scan must equal the
# scan from a clean cwd. With the flag that closes the channel dropped, it must report
# <stolen marker>, so each flag is shown to close its own channel.
assert_gate_launch() {
  local var="$1" stolen="$2" marker="$3" base="$TMP/gate launch"
  local channel flag clean clean_rc closed closed_rc open
  local -a kept
  mkdir -p "$base/clean" "$base/env" "$base/bunfig"
  printf '%s="%s"\n' "$var" "$stolen" >"$base/env/.env"
  printf 'process.env.%s = "%s"\n' "$var" "$stolen" >"$base/bunfig/steal.ts"
  printf 'preload = ["%s"]\n' "$base/bunfig/steal.ts" >"$base/bunfig/bunfig.toml"
  clean_rc=0
  clean="$(cd "$base/clean" && env -u BUN_OPTIONS -u "$var" bun "${GATE[@]}" "$SCANNER" 2>&1)" ||
    clean_rc=$?
  for channel in env bunfig; do
    kept=()
    for flag in "${GATE[@]}"; do
      case "$channel:$flag" in
        env:--no-env-file | bunfig:--config=*) ;;
        *) kept+=("$flag") ;;
      esac
    done
    closed_rc=0
    closed="$(cd "$base/$channel" && env -u BUN_OPTIONS -u "$var" bun "${GATE[@]}" "$SCANNER" 2>&1)" ||
      closed_rc=$?
    open="$(cd "$base/$channel" && env -u BUN_OPTIONS -u "$var" bun "${kept[@]}" "$SCANNER" 2>&1)" ||
      true
    if [[ "$clean" == *"$(basename "$SCANNER" .ts): "* ]] \
      && [[ "$closed_rc" -eq "$clean_rc" && "$closed" == "$clean" ]] \
      && [[ "$open" == *"$marker"* && "$open" != "$clean" ]]; then
      echo "PASS: gate-launch-$channel"
      PASS=$((PASS + 1))
    else
      echo "FAIL: gate-launch-$channel (a cwd $channel must re-point the scan once its flag is dropped, and change nothing under the package.json flags)" >&2
      printf 'clean cwd (rc=%s):\n%s\npackage.json flags (rc=%s):\n%s\nflag dropped:\n%s\n' \
        "$clean_rc" "$clean" "$closed_rc" "$closed" "$open" >&2
      FAIL=$((FAIL + 1))
    fi
  done
}
