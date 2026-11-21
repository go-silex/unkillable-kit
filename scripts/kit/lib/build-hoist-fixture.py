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
    lib = scripts / "lib"
    scripts.mkdir(parents=True)
    lib.mkdir(parents=True)
    shutil.copy(scanner, scripts / "check-lock-ranges.ts")
    for name in ("jsonc-strict.ts", "materialize-tree.ts"):
        src = scanner.parent / "lib" / name
        if src.exists():
            shutil.copy(src, lib / name)

home = root / ".hermetic-home"
home.mkdir(parents=True, exist_ok=True)
env = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": str(home),
    "XDG_CONFIG_HOME": str(home),
    "TMPDIR": str(home),
    "BUN_INSTALL_CACHE_DIR": str(cache),
}


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
