#!/usr/bin/env bun
/**
 * Bound unread cat-file payload as chunks enter the reader queue. This catches
 * full-blob queuing even if the event loop never samples the live buffers.
 * Also bound sampled post-GC external memory; this is not a bound on the JS
 * heap or on allocations released between samples. RSS is diagnostic only,
 * since it includes allocator pages retained after Buffers are reclaimed.
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
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { materializeTree } from './materialize-tree.ts'

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

/** Instrument both writers in a scratch copy; leave the shipped reader untouched. */
async function loadMaterializer() {
  const source = readFileSync(new URL('./materialize-tree.ts', import.meta.url), 'utf8')
  const anchor = '    buffered += chunk.length\n'
  const [before, after, ...extra] = source.split(anchor)
  if (after === undefined || extra.length > 0) {
    throw new Error('cannot attach memory probe to the cat-file queue')
  }
  const path = join(root, 'materialize-tree.ts')
  writeFileSync(
    path,
    `${before}${anchor}    onQueued?.(buffered)\n${after}
let onQueued: ((bytes: number) => void) | undefined
export function observeQueue(observer: (bytes: number) => void) { onQueued = observer }
`,
  )
  return (await import(path)) as {
    materializeTree: typeof materializeTree
    observeQueue: (observer: (bytes: number) => void) => void
  }
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

  const { materializeTree, observeQueue } = await loadMaterializer()

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
  let peakBuffered = 0
  observeQueue((buffered) => {
    // Take one synchronous external sample with the whole fixture still live,
    // if it ever fits in the queue. Timer samples alone can miss that window.
    if (peakBuffered < bytes && buffered >= bytes) sample()
    peakBuffered = Math.max(peakBuffered, buffered)
  })
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

  // With a 128 MiB blob on Bun 1.4.4 (including one busy core), the streaming
  // writer queued at most 7.2 MiB and grew sampled external memory by at most
  // 0.7 MiB. The mutant reached 128 MiB queued and about 128 MiB external
  // growth. Keep the same 32 MiB ceiling for each independent measurement.
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
      peak_buffered: peakBuffered,
      limit_buffered: limit,
    }),
  )
  if (peakBuffered > limit) {
    console.error(`FAIL: queued blob bytes ${peakBuffered} exceed ${limit} for ${mib} MiB blob`)
    process.exitCode = 1
  } else if (growth > limit) {
    console.error(`FAIL: live external growth ${growth} exceeds ${limit} for ${mib} MiB blob`)
    process.exitCode = 1
  } else {
    console.log('PASS: materialize memory bound')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
