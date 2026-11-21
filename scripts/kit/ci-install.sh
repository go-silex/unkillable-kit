#!/usr/bin/env bash
# Frozen Bun install with the selected Node's bundled node-gyp on PATH only for this process.
# Called by Kit Root core / grouped coverage and the Product CI template after checkout + Node + Bun setup.
set -euo pipefail

# Expose the selected Node's bundled node-gyp only to this install.
node_gyp="$(npm prefix -g)/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
test -x "$node_gyp"
bin="${RUNNER_TEMP}/node-gyp-bin"
mkdir -p "$bin"
ln -s "$node_gyp" "$bin/node-gyp"
PATH="$bin:$PATH" bun install --frozen-lockfile --minimum-release-age 0
