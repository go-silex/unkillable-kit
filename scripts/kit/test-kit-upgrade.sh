#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
# shellcheck source=lib/hermetic-git.sh
source "${ROOT}/scripts/kit/lib/hermetic-git.sh"
unset GITHUB_REPOSITORY
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/bun" <<'BUN'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$KIT_UPGRADE_TEST_LOG"
if [[ ${FAIL_FROZEN:-} == 1 && ${1:-} == install && ${2:-} == --frozen-lockfile ]]; then exit 1; fi
if [[ ${FAIL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then exit 1; fi
if [[ ${REAL_LOCK:-} == 1 && ${1:-} == install && ${2:-} == --frozen-lockfile ]]; then
  exec bun "$@"
fi
if [[ ${REAL_LOCK:-} == 1 && ${1:-} == run && ${2:-} == lock-ranges:check ]]; then
  bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts
  rc=$?
  if [[ $rc -eq 0 && ${DIRTY_AFTER_CHECK:-} == 1 ]]; then
    printf '\n' >> bun.lock
  fi
  exit "$rc"
fi
BUN
chmod +x "$tmp/bun"
export KIT_UPGRADE_BUN="$tmp/bun"
touch "$tmp/harness-sentinel"
export KIT_UPGRADE_HARNESS_SENTINEL="$tmp/harness-sentinel"
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid

fixture() {
  local name=$1
  dir="$tmp/$name"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir/seed/scripts/kit" "$dir/seed/config/kit" "$dir/seed/.github/workflows"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$dir/seed/scripts/kit/"
  printf '{"version":1,"kit_origin_allowlist":["kit"]}\n' > "$dir/seed/config/kit/zero-edit-zones.json"
  printf '{"packageManager":"bun@1.0"}\n' > "$dir/seed/package.json"
  echo lock > "$dir/seed/bun.lock"
  echo upstream-license > "$dir/seed/LICENSE"
  git -C "$dir/seed" init -q -b main
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm initial
  git clone -q --bare "$dir/seed" "$dir/upstream.git"
  git clone -q "$dir/upstream.git" "$dir/product"
  git -C "$dir/product" remote rename origin upstream
  git -C "$dir/product" remote add origin product
  mkdir -p "$dir/product/config/product"
  printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
  git -C "$dir/product" add .
  git -C "$dir/product" commit -qm product
}
advance() {
  echo updated > "$dir/seed/change"
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm update
  git -C "$dir/seed" push -q "$dir/upstream.git" main
}
run_upgrade() { (cd "$dir/product" && bash scripts/kit/kit-upgrade.sh "$@") >"$dir/out" 2>&1; }
pass() { echo "PASS: $1"; }

fixture kit
git -C "$dir/product" remote set-url origin kit
git -C "$dir/product" rm -q config/product/inheritance.json
git -C "$dir/product" commit -qm kit
if run_upgrade; then exit 1; fi
grep -q 'requires a product clone' "$dir/out"
pass 'kit mode refused'
fixture dirty
echo dirty >> "$dir/product/bun.lock"
if run_upgrade; then exit 1; fi
grep -q 'clean the working tree' "$dir/out"
pass 'dirty tree refused'
fixture current
run_upgrade
grep -q 'already up to date' "$dir/out"
pass 'already up to date'
fixture clean
advance
run_upgrade
[[ $(git -C "$dir/product" rev-list --parents -n 1 HEAD | wc -w) == 3 ]]
[[ $(git -C "$dir/product" show HEAD:config/product/inheritance.json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).upstreamCommit))') == $(git -C "$dir/seed" rev-parse HEAD) ]]
[[ -z $(git -C "$dir/product" status --porcelain) ]]
[[ $(cat "$KIT_UPGRADE_TEST_LOG") == $'install --frozen-lockfile --minimum-release-age 0\nrun lock-ranges:check\nrun zero-edit' ]]
pass 'clean upgrade rewrites marker and commits'
fixture license
before_license=$(git -C "$dir/product" show HEAD:LICENSE)
echo changed-upstream-license > "$dir/seed/LICENSE"
advance
run_upgrade
[[ $(git -C "$dir/product" show HEAD:LICENSE) == "$before_license" ]]
[[ -z $(git -C "$dir/product" status --porcelain) ]]
pass 'LICENSE preserved when present and different'
fixture absent
git -C "$dir/seed" rm -q LICENSE
git -C "$dir/seed" commit -qm remove-license
git -C "$dir/seed" push -q "$dir/upstream.git" main
git -C "$dir/product" fetch -q upstream
git -C "$dir/product" merge -q --no-edit upstream/main
echo new-upstream-license > "$dir/seed/LICENSE"
advance
run_upgrade
if git -C "$dir/product" cat-file -e HEAD:LICENSE 2>/dev/null; then exit 1; fi
[[ ! -e "$dir/product/LICENSE" && -z $(git -C "$dir/product" status --porcelain) ]]
pass 'LICENSE kept absent'
fixture manager
printf '{"packageManager":"bun@2.0"}\n' > "$dir/seed/package.json"
advance
run_upgrade
grep -q 'packageManager moves' "$dir/out"
pass 'packageManager notice printed'
fixture token
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/ci.yml"
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && ! -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'establish the effective CI_APP_ID' "$dir/out"
pass 'create-github-app-token bump stops before merge'
fixture large-token
echo 'uses: actions/create-github-app-token@v3' > "$dir/seed/.github/workflows/a.yml"
mkdir -p "$dir/product/.github/workflows"
for ((i=0; i<5000; i++)); do printf 'repository workflow padding %05d\n' "$i"; done > "$dir/product/.github/workflows/z.yml"
git -C "$dir/product" add .github/workflows/z.yml
git -C "$dir/product" commit -qm repository-workflow
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if run_upgrade; then exit 1; fi
grep -q 'establish the effective CI_APP_ID' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && ! -f "$dir/product/.git/MERGE_HEAD" ]]
pass 'large workflow diff still stops token bump'
fixture lock
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'merge remains open' "$dir/out"
pass 'lock-ranges failure leaves merge open without commit'

stability_fixture() {
  dir="$tmp/$1"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir/seed"
  git -C "$ROOT" archive HEAD | tar -x -C "$dir/seed"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/check-lock-ranges.ts" "$dir/seed/scripts/kit/"
  cp "$ROOT/package.json" "$dir/seed/package.json"
  git -C "$dir/seed" init -q -b main
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm initial
  git clone -q --bare "$dir/seed" "$dir/upstream.git"
  git clone -q "$dir/upstream.git" "$dir/product"
  git -C "$dir/product" remote rename origin upstream
  git -C "$dir/product" remote add origin product
  mkdir -p "$dir/product/config/product"
  printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
  git -C "$dir/product" add config/product/inheritance.json
  git -C "$dir/product" commit -qm product
}

stability_fixture stable-merge
advance
REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
git -C "$dir/product" show HEAD:bun.lock | cmp - "$ROOT/bun.lock"
pass 'upgrade commits install-stable staged lock'

stability_fixture frozen-fail
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_FROZEN=1 REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'merge remains open' "$dir/out"
pass 'frozen install failure leaves merge open'

stability_fixture check-fail
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if FAIL_LOCK=1 REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'merge remains open' "$dir/out"
pass 'lock-ranges check failure leaves merge open'

stability_fixture dirty-after-check
advance
DIRTY_AFTER_CHECK=1 REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
[[ -n $(git -C "$dir/product" status --porcelain -- bun.lock) ]]
git -C "$dir/product" show HEAD:bun.lock | cmp - "$ROOT/bun.lock"
pass 'working bun.lock dirty after staging is not committed'

stability_fixture decoy-env
advance
mkdir -p "$dir/decoy"
printf '%s\n' '{"lockfileVersion":1,"workspaces":{"":{"name":"decoy","dependencies":{"left-pad":"^1.0.0"}}},"packages":{"left-pad":["left-pad@2.0.0","",{},"sha512-x"]}}' >"$dir/decoy/bun.lock"
LOCK_RANGES_ROOT="$dir/decoy" REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
if grep -q 'left-pad' "$dir/out"; then
  echo 'FAIL: decoy LOCK_RANGES_ROOT was consulted' >&2
  exit 1
fi
pass 'inherited LOCK_RANGES_ROOT decoy is ignored'

stability_fixture out-of-range
node -e '
const fs=require("fs");
const lockPath=process.argv[1], pkgPath=process.argv[2];
const pkg=JSON.parse(fs.readFileSync(pkgPath,"utf8"));
pkg.overrides={...(pkg.overrides||{}), lefthook:"^2.3.0"};
fs.writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+"\n");
const lock=fs.readFileSync(lockPath,"utf8");
const old="  \"overrides\": {\n    \"@better-auth/core\": \"1.7.27\",\n  },";
const next=lock.replace(old,"  \"overrides\": {\n    \"@better-auth/core\": \"1.7.27\",\n    \"lefthook\": \"^2.3.0\",\n  },");
if(next===lock||!next.includes("lefthook@2.2.2")) process.exit(1);
fs.writeFileSync(lockPath,next);
' "$dir/seed/bun.lock" "$dir/seed/package.json"
advance
before=$(git -C "$dir/product" rev-parse HEAD)
if REAL_LOCK=1 run_upgrade; then exit 1; fi
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -f "$dir/product/.git/MERGE_HEAD" ]]
grep -q 'does not satisfy the range\|does not satisfy\|lefthook' "$dir/out"
pass 'out-of-range staged resolution leaves merge open'

# Hoisting-only three-app product: ordinary-stable lock commits through kit-upgrade.
build_hoist_product() {
  dir="$tmp/hoist-upgrade"
  export KIT_UPGRADE_TEST_LOG="$dir/bun.log"
  mkdir -p "$dir"
  hoist_cache="$dir/cache"
  mkdir -p "$hoist_cache"
  cat >"$dir/build-hoist.py" <<'HOISTPY'
#!/usr/bin/env python3
"""Build a three-app hoisting-stable lock fixture with a loopback registry."""
from __future__ import annotations
import datetime as dt, json, os, shutil, subprocess, sys, tarfile, threading
from base64 import b64encode
from hashlib import sha512
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

root = Path(sys.argv[1]).resolve()
cache = Path(sys.argv[2]).resolve()
scanner = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
extra_files = {}  # filled by callers via env JSON if needed

if root.exists():
    shutil.rmtree(root)
root.mkdir(parents=True)
cache.mkdir(parents=True, exist_ok=True)

bodies: dict[str, bytes] = {}
records: dict[tuple[str, str], dict] = {}
logs: list[str] = []
port_box = {"port": 0}


def make_tgz(name: str, version: str) -> tuple[str, bytes, str]:
    raw = json.dumps({"name": name, "version": version}).encode()
    buf = BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("package/package.json")
        info.size = len(raw)
        tar.addfile(info, BytesIO(raw))
    blob = buf.getvalue()
    path = f"{name}/-/{name}-{version}.tgz"
    integrity = "sha512-" + b64encode(sha512(blob).digest()).decode()
    return path, blob, integrity


for version in ("1.0.0", "1.0.1"):
    path, blob, integrity = make_tgz("kit-pin", version)
    bodies[path] = blob
    records[("kit-pin", version)] = {
        "name": "kit-pin",
        "version": version,
        "dist": {"tarball": "", "integrity": integrity},
    }


class Registry(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: A003
        return

    def do_GET(self):  # noqa: N802
        path = self.path.strip("/")
        logs.append(path)
        if path == "kit-pin":
            versions = ["1.0.0", "1.0.1"]
            obj = {
                "name": "kit-pin",
                "dist-tags": {"latest": "1.0.1"},
                "versions": {},
                "time": {
                    "modified": "2025-01-01T00:00:00.000Z",
                    "created": "2025-01-01T00:00:00.000Z",
                },
            }
            for v in versions:
                meta = json.loads(json.dumps(records[("kit-pin", v)]))
                meta["dist"]["tarball"] = f"http://127.0.0.1:{port_box['port']}/kit-pin/-/kit-pin-{v}.tgz"
                obj["versions"][v] = meta
                obj["time"][v] = "2025-01-01T00:00:00.000Z"
            buf = json.dumps(obj).encode()
            mime = "application/json"
        elif path in bodies:
            buf = bodies[path]
            mime = "application/octet-stream"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(buf)))
        self.end_headers()
        self.wfile.write(buf)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
port_box["port"] = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{port_box['port']}/"

bun_version = subprocess.check_output(["bun", "-v"], text=True).strip()
(root / "package.json").write_text(
    json.dumps(
        {
            "name": "hoist-root",
            "private": True,
            "workspaces": ["apps/*"],
            "trustedDependencies": [],
            "packageManager": f"bun@{bun_version}",
        },
        indent=2,
    )
    + "\n"
)
(root / "bunfig.toml").write_text(f'[install]\nregistry = "{url}"\nminimumReleaseAge = 259200\n')
for app, ver in (("a", "1.0.1"), ("b", "1.0.0"), ("c", "1.0.1")):
    app_dir = root / "apps" / app
    app_dir.mkdir(parents=True)
    (app_dir / "package.json").write_text(json.dumps({"name": app, "dependencies": {"kit-pin": ver}}) + "\n")
if scanner is not None:
    scripts = root / "scripts" / "kit"
    scripts.mkdir(parents=True)
    shutil.copy(scanner, scripts / "check-lock-ranges.ts")

env = {**os.environ, "BUN_INSTALL_CACHE_DIR": str(cache)}


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bun", *args],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )


r = run("install", "--lockfile-only", "--ignore-scripts")
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("initial lockfile-only failed")

lock = json.loads(
    subprocess.check_output(
        ["bun", "-e", 'console.log(JSON.stringify(Bun.JSONC.parse(await Bun.file("bun.lock").text())))'],
        cwd=root,
        text=True,
    )
)
high = next(v for v in lock["packages"].values() if v[0] == "kit-pin@1.0.1")
low = next(v for v in lock["packages"].values() if v[0] == "kit-pin@1.0.0")
next_packages = {k: v for k, v in lock["packages"].items() if k != "kit-pin" and not k.endswith("/kit-pin")}
next_packages["kit-pin"] = low
next_packages["a/kit-pin"] = high
next_packages["c/kit-pin"] = high
lock["packages"] = next_packages
(root / "bun.lock").write_text(json.dumps(lock, indent=2) + "\n")
before = (root / "bun.lock").read_bytes()

r = run("install", "--frozen-lockfile", "--minimum-release-age", "0", "--ignore-scripts")
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("frozen warmup failed")
srv.shutdown()
if (root / "bun.lock").read_bytes() != before:
    raise SystemExit("frozen rewrote lock")

# Prove ordinary offline keeps bytes and lockfile-only would rewrite.
r = run("install", "--offline", "--ignore-scripts")
if r.returncode != 0 or (root / "bun.lock").read_bytes() != before:
    raise SystemExit("ordinary offline did not keep lock")
writer = root.parent / (root.name + "-writer")
if writer.exists():
    shutil.rmtree(writer)
shutil.copytree(root, writer, ignore=shutil.ignore_patterns("node_modules", ".pkg"))
r = subprocess.run(
    ["bun", "install", "--lockfile-only", "--offline", "--ignore-scripts", "--minimum-release-age", "0"],
    cwd=writer,
    env=env,
    text=True,
    capture_output=True,
    timeout=60,
)
if r.returncode != 0:
    sys.stderr.write(r.stdout + r.stderr)
    raise SystemExit("lockfile-only offline failed")
if (writer / "bun.lock").read_bytes() == before:
    raise SystemExit("lockfile-only did not rewrite hoisting layout")
print("hoist fixture ready")
print("registry_hits", len(logs))

HOISTPY
  python3 "$dir/build-hoist.py" "$dir/seed" "$hoist_cache" "$ROOT/scripts/kit/check-lock-ranges.ts"
  printf '%s\n' 'node_modules/' '.pkg/' >"$dir/seed/.gitignore"
  rm -rf "$dir/seed/node_modules" "$dir/seed"/apps/*/node_modules "$dir/seed/.pkg"
  mkdir -p "$dir/seed/scripts/kit" "$dir/seed/config/kit" "$dir/seed/config/product"
  cp "$ROOT/scripts/kit/kit-upgrade.sh" "$ROOT/scripts/kit/resolve-tree-identity.mjs" "$dir/seed/scripts/kit/"
  cp "$ROOT/scripts/kit/check-lock-ranges.ts" "$dir/seed/scripts/kit/"
  : >"$dir/seed/config/kit/bunfig.gates.toml"
  printf '%s\n' '{"version":1,"kit_origin_allowlist":["kit"]}' >"$dir/seed/config/kit/zero-edit-zones.json"
  node -e '
const fs=require("fs");
const p=process.argv[1];
const pkg=JSON.parse(fs.readFileSync(p,"utf8"));
pkg.scripts={
  ...(pkg.scripts||{}),
  "lock-ranges:check":"bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts",
  "zero-edit":"node -e \"process.exit(0)\"",
};
fs.writeFileSync(p, JSON.stringify(pkg,null,2)+"\n");
' "$dir/seed/package.json"
  git -C "$dir/seed" init -q -b main
  git -C "$dir/seed" add .
  git -C "$dir/seed" commit -qm initial
  git clone -q --bare "$dir/seed" "$dir/upstream.git"
  git clone -q "$dir/upstream.git" "$dir/product"
  git -C "$dir/product" remote rename origin upstream
  git -C "$dir/product" remote add origin product
  mkdir -p "$dir/product/config/product"
  printf '{"version":1,"upstreamCommit":"%s"}\n' "$(git -C "$dir/product" rev-parse HEAD)" > "$dir/product/config/product/inheritance.json"
  git -C "$dir/product" add config/product/inheritance.json
  git -C "$dir/product" commit -qm product
  echo change > "$dir/seed/change"
  git -C "$dir/seed" add change
  git -C "$dir/seed" commit -qm update
  git -C "$dir/seed" push -q "$dir/upstream.git" main
}

build_hoist_product
export BUN_INSTALL_CACHE_DIR="$dir/cache"
REAL_LOCK=1 run_upgrade
[[ ! -f "$dir/product/.git/MERGE_HEAD" ]]
[[ $(git -C "$dir/product" rev-list --parents -n 1 HEAD | wc -w) == 3 ]]
(cd "$dir/product" && BUN_INSTALL_CACHE_DIR="$dir/cache" bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/check-lock-ranges.ts) >/dev/null
pass 'hoisting-only layout commits through kit-upgrade'

fixture check
advance
git -C "$dir/product" fetch -q upstream
cached=$(git -C "$dir/product" rev-parse upstream/main)
echo later > "$dir/seed/later"
git -C "$dir/seed" add later && git -C "$dir/seed" commit -qm later
git -C "$dir/seed" push -q "$dir/upstream.git" main
before=$(git -C "$dir/product" rev-parse HEAD)
run_upgrade --check
grep -q 'upgrade pending' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -z $(git -C "$dir/product" status --porcelain) ]]
[[ $(git -C "$dir/product" rev-parse upstream/main) == "$cached" ]]
pass '--check writes nothing'
fixture missing-upstream
git -C "$dir/product" remote remove upstream
if run_upgrade --check; then exit 1; fi
pass 'check refuses missing upstream'
fixture sentinel
before=$(git -C "$dir/product" rev-parse HEAD)
if (unset KIT_UPGRADE_HARNESS_SENTINEL; run_upgrade); then exit 1; fi
grep -q 'requires a test harness sentinel' "$dir/out"
[[ $(git -C "$dir/product" rev-parse HEAD) == "$before" && -z $(git -C "$dir/product" status --porcelain) ]]
pass 'override without sentinel refused without writes'
fixture merge
git -C "$dir/product" rev-parse HEAD > "$dir/product/.git/MERGE_HEAD"
if run_upgrade; then exit 1; fi
grep -q 'finish any in-progress merge' "$dir/out"
[[ -f "$dir/product/.git/MERGE_HEAD" ]]
pass 'in-progress merge refused'
