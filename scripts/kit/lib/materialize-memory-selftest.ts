#!/usr/bin/env bun
/**
 * Deterministic memory bound for materializeTree: a N-MiB blob must not grow
 * RSS by nearly N MiB (the old full-buffer path did).
 *
 * Usage: bun scripts/kit/lib/materialize-memory-selftest.ts [MiB=64]
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeTree } from './materialize-tree.ts'

const mib = Number(process.argv[2] ?? 64)
if (!Number.isFinite(mib) || mib < 1) {
  console.error('usage: materialize-memory-selftest.ts [MiB]')
  process.exit(2)
}
const bytes = Math.floor(mib * 1024 * 1024)
const root = mkdtempSync(join(tmpdir(), 'mat-mem-'))
const snap = join(root, 'out')

function git(args: string[], cwd = root) {
  const r = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
    },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(' ')} failed`)
  return r.stdout
}

try {
  git(['init', '-q'])
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'mem', private: true, packageManager: `bun@${Bun.version}` })}\n`,
  )
  writeFileSync(
    join(root, 'bun.lock'),
    '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "mem", "dependencies": {} } },\n  "packages": {}\n}\n',
  )
  // Deterministic content without holding the whole file in one Buffer in the parent longer than needed.
  const bin = join(root, 'data.bin')
  const out = createWriteStream(bin)
  const chunk = Buffer.alloc(1024 * 1024, 0x5a)
  for (let i = 0; i < mib; i += 1) {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  git(['add', '.'])
  git(['commit', '-qm', 'mem'])

  const samples: number[] = []
  const baseline = process.memoryUsage().rss
  samples.push(baseline)
  const timer = setInterval(() => samples.push(process.memoryUsage().rss), 20)
  const t0 = performance.now()
  await materializeTree(root, 'HEAD', snap)
  clearInterval(timer)
  samples.push(process.memoryUsage().rss)
  const ms = performance.now() - t0
  const peak = Math.max(...samples)
  const growth = peak - baseline
  const written = readFileSync(join(snap, 'data.bin'))
  if (written.length !== bytes || written[0] !== 0x5a || written[bytes - 1] !== 0x5a) {
    console.error(`FAIL: bytes mismatch len=${written.length} want=${bytes}`)
    process.exit(1)
  }
  // Peak growth must stay well under the blob size (old path buffered the whole
  // blob and peaked near 10×). Fixed allocator noise dominates tiny blobs, so
  // the bound is max(48 MiB, 90% of the blob).
  const limit = Math.max(48 * 1024 * 1024, Math.floor(bytes * 0.9))
  console.log(
    JSON.stringify({
      mib,
      ms: Math.round(ms),
      baseline_rss: baseline,
      peak_rss: peak,
      growth_rss: growth,
      limit_rss: limit,
    }),
  )
  if (growth > limit) {
    console.error(`FAIL: RSS growth ${growth} exceeds ${limit} for ${mib} MiB blob`)
    process.exit(1)
  }
  console.log('PASS: materialize memory bound')
} finally {
  rmSync(root, { recursive: true, force: true })
}
