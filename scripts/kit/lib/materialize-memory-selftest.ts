#!/usr/bin/env bun
/**
 * Compare peak RSS growth during materializeTree with a bound that separates
 * streaming from buffering the whole blob.
 *
 * Usage: bun scripts/kit/lib/materialize-memory-selftest.ts [MiB=128]
 */
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeTree } from './materialize-tree.ts'

const MIB = 1024 * 1024
const mib = Number(process.argv[2] ?? 128)
if (!Number.isFinite(mib) || mib < 1) {
  console.error('usage: materialize-memory-selftest.ts [MiB]')
  process.exit(2)
}
const bytes = Math.floor(mib * MIB)
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
  // Generate deterministic content without allocating the whole blob.
  const bin = join(root, 'data.bin')
  const out = createWriteStream(bin)
  const chunk = Buffer.alloc(MIB, 0x5a)
  for (let i = 0; i < mib; i += 1) {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  git(['add', '.'])
  git(['commit', '-qm', 'mem'])

  Bun.gc(true)
  const baseline = process.memoryUsage.rss()
  let peak = baseline
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage.rss())
  }
  const timer = setInterval(sample, 5)
  const t0 = performance.now()
  try {
    await materializeTree(root, 'HEAD', snap)
    sample()
  } finally {
    clearInterval(timer)
  }
  const ms = performance.now() - t0
  const growth = peak - baseline

  const fd = openSync(join(snap, 'data.bin'), 'r')
  try {
    const size = fstatSync(fd).size
    const ends = Buffer.alloc(2)
    if (
      size !== bytes ||
      readSync(fd, ends, 0, 1, 0) !== 1 ||
      readSync(fd, ends, 1, 1, bytes - 1) !== 1 ||
      ends[0] !== 0x5a ||
      ends[1] !== 0x5a
    ) {
      throw new Error(`FAIL: bytes mismatch len=${size} want=${bytes}`)
    }
  } finally {
    closeSync(fd)
  }

  // On Bun 1.4.4, the original sampler at 128 MiB measured 28–33 MiB
  // streaming vs. 265–267 MiB for the full-buffer mutant. CI once measured
  // 58 MiB streaming at 64 MiB. At the default fixture size, 96 MiB leaves
  // room for that variance and is still 32 MiB below a single full blob.
  const limit = Math.max(96 * MIB, Math.floor(bytes * 0.75))
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
    process.exitCode = 1
  } else {
    console.log('PASS: materialize memory bound')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
