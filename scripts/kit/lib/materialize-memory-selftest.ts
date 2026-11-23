#!/usr/bin/env bun
/**
 * Verify writeExact writes each chunk before a paced source sends the next.
 * The source and writer alternate by event-loop turn, not by elapsed time.
 * Separately verify the large materialized Git blob byte for byte. Neither
 * check bounds process memory or the queue under a real cat-file producer.
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
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { createByteReader, materializeTree } from './materialize-tree.ts'

const MIB = 1024 * 1024
const mib = Number(process.argv[2] ?? 128)
if (!Number.isFinite(mib) || mib < 1) {
  console.error('usage: materialize-memory-selftest.ts [MiB]')
  process.exit(2)
}
const bytes = Math.floor(mib * MIB)
const root = mkdtempSync(resolve(tmpdir(), 'mat-mem-'))
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

async function checkPacedWriter(): Promise<boolean> {
  const stream = new Readable({ read() {} })
  const reader = createByteReader(stream)
  const chunk = Buffer.alloc(64 * 1024, 0x5a)
  const total = 4 * chunk.length
  const fd = openSync(join(root, 'paced.bin'), 'w')
  let firstMiss: { written: number; expected: number } | undefined
  async function feed() {
    // Let the stream enter flowing mode before delivering the first chunk.
    await setImmediate()
    for (let expected = chunk.length; expected <= total; expected += chunk.length) {
      stream.push(chunk)
      // The data listener wakes need(); its promise continuations drain and
      // write synchronously before the next event-loop turn starts.
      await setImmediate()
      if (expected < total) {
        const written = fstatSync(fd).size
        if (written !== expected) firstMiss ??= { written, expected }
      }
    }
    stream.push(null)
  }
  try {
    await Promise.all([reader.writeExact(fd, total), feed()])
    if (fstatSync(fd).size !== total) throw new Error('FAIL: paced writer size mismatch')
  } finally {
    closeSync(fd)
  }
  if (firstMiss) {
    console.error(
      `FAIL: writeExact did not stream before next chunk (wrote ${firstMiss.written}, expected ${firstMiss.expected})`,
    )
    return false
  }
  return true
}

function checkBlob(expected: Buffer) {
  const fd = openSync(join(snap, 'data.bin'), 'r')
  try {
    const size = fstatSync(fd).size
    if (size !== bytes) throw new Error(`FAIL: bytes mismatch len=${size} want=${bytes}`)
    const actual = Buffer.allocUnsafe(expected.length)
    for (let offset = 0; offset < bytes; offset += actual.length) {
      const length = Math.min(actual.length, bytes - offset)
      let read = 0
      while (read < length) {
        const count = readSync(fd, actual, read, length - read, offset + read)
        if (count === 0) throw new Error(`FAIL: unexpected EOF at byte ${offset + read}`)
        read += count
      }
      if (!actual.subarray(0, length).equals(expected.subarray(0, length))) {
        throw new Error(`FAIL: bytes mismatch in chunk at offset ${offset}`)
      }
    }
  } finally {
    closeSync(fd)
  }
}

try {
  if (await checkPacedWriter()) {
    await checkMaterializedBlob()
    console.log('PASS: writeExact streams paced chunks and materialize preserves blob bytes')
  } else {
    process.exitCode = 1
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

async function checkMaterializedBlob() {
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
  const chunk = Buffer.allocUnsafe(MIB)
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = i % 251
  for (let offset = 0; offset < bytes; offset += chunk.length) {
    const length = Math.min(chunk.length, bytes - offset)
    if (!out.write(chunk.subarray(0, length))) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  git(['add', '.'])
  git(['commit', '-qm', 'mem'])

  await materializeTree(root, 'HEAD', snap)
  checkBlob(chunk)
}
