#!/usr/bin/env bun
/**
 * Bound sampled post-GC external (Buffer) memory during materializeTree, which
 * catches the full-buffer writeExact regression. It is not a bound on all
 * memory: data held as JS heap values, or released within one event-loop turn,
 * is not counted. Report RSS separately: it also includes allocator pages
 * retained after Buffers are reclaimed.
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

  function sampleMemory() {
    // Bun updates its external-memory accounting on GC. Sample RSS first so
    // the diagnostic also sees pages that the collection is about to release.
    const rss = process.memoryUsage.rss()
    Bun.gc(true)
    return { rss, external: process.memoryUsage().external }
  }
  const baseline = sampleMemory()
  let peakRss = baseline.rss
  let peakExternal = baseline.external
  const sample = () => {
    const { rss, external } = sampleMemory()
    peakRss = Math.max(peakRss, rss)
    peakExternal = Math.max(peakExternal, external)
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
  const growth = peakExternal - baseline.external

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

  // On Bun 1.4.4 with a pinned core and a slowed writer, a 128 MiB blob
  // reached at most 2.2 MiB of sampled live external memory and 9 MiB of
  // queued data; the mutant held about 128 MiB live. A 32 MiB bound at
  // this fixture size leaves headroom without permitting Buffer-held full-blob
  // buffering.
  const limit = Math.max(16 * MIB, Math.floor(bytes / 4))
  console.log(
    JSON.stringify({
      mib,
      ms: Math.round(ms),
      baseline_rss: baseline.rss,
      peak_rss: peakRss,
      growth_rss: peakRss - baseline.rss,
      baseline_external: baseline.external,
      peak_external: peakExternal,
      growth_external: growth,
      limit_external: limit,
    }),
  )
  if (growth > limit) {
    console.error(`FAIL: live external growth ${growth} exceeds ${limit} for ${mib} MiB blob`)
    process.exitCode = 1
  } else {
    console.log('PASS: materialize memory bound')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
