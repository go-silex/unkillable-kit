/**
 * Materialize a Git tree as raw blobs (no checkout filters/attributes).
 * Streams `git cat-file --batch` under GIT_NO_LAZY_FETCH=1.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { Readable } from 'node:stream'

export type TreeEntry = { mode: string; oid: string; path: string }

function parseLsTreeLine(line: string): TreeEntry | undefined {
  const tab = line.indexOf('\t')
  if (tab < 0) return undefined
  const meta = line.slice(0, tab)
  const path = line.slice(tab + 1)
  const [mode, , oid] = meta.split(' ')
  if (!(mode && oid && path) || mode === '160000') return undefined
  return { mode, oid, path }
}

function parseLsTreeBuffer(buf: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = []
  let start = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) continue
    const line = buf.subarray(start, i).toString('utf8')
    start = i + 1
    const entry = line ? parseLsTreeLine(line) : undefined
    if (entry) entries.push(entry)
  }
  return entries
}

export function listTreeEntries(root: string, tree: string): TreeEntry[] {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', tree], {
    cwd: root,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    failMaterializeEarly(
      'cannot list candidate tree',
      `${result.stderr || result.stdout || ''}`.toString().trim(),
    )
  }
  return parseLsTreeBuffer(result.stdout as Buffer)
}

function failMaterializeEarly(prefix: string, detail: string): never {
  if (/lazy|partial|promisor|filter/i.test(detail)) {
    throw new Error(
      `cannot materialize candidate tree without fetching (partial clone); ${detail || 'set GIT_NO_LAZY_FETCH'}`,
    )
  }
  throw new Error(detail ? `${prefix}: ${detail}` : prefix)
}

function assertSymlinkContained(snapshot: string, relativePath: string): void {
  const linkPath = join(snapshot, relativePath)
  const snapshotRoot = realpathSync(snapshot)
  try {
    const real = realpathSync(linkPath)
    if (!(real === snapshotRoot || real.startsWith(snapshotRoot + sep))) {
      throw new Error(`candidate symlink escapes snapshot: ${relativePath}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('candidate symlink')) throw error
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : ''
    if (code === 'ENOENT') return
    throw new Error(`candidate symlink unreadable: ${relativePath}`)
  }
}

function createByteReader(stream: Readable): {
  readLine: () => Promise<string>
  readExact: (n: number) => Promise<Buffer>
} {
  let buf = Buffer.alloc(0)
  let ended = false
  const waiters: Array<() => void> = []
  const wake = () => {
    while (waiters.length) waiters.shift()!()
  }
  stream.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    wake()
  })
  stream.on('end', () => {
    ended = true
    wake()
  })
  stream.on('error', (error) => {
    ended = true
    wake()
    throw error
  })

  async function need(min: number): Promise<void> {
    while (buf.length < min) {
      if (ended) throw new Error('cannot materialize candidate tree: truncated cat-file stream')
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  }

  return {
    async readLine() {
      while (true) {
        const nl = buf.indexOf(0x0a)
        if (nl >= 0) {
          const line = buf.subarray(0, nl).toString('utf8')
          buf = buf.subarray(nl + 1)
          return line
        }
        await need(buf.length + 1)
      }
    },
    async readExact(n: number) {
      await need(n)
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
  }
}

function writeEntry(snapshot: string, entry: TreeEntry, body: Buffer, symlinks: string[]): void {
  const dest = join(snapshot, entry.path)
  mkdirSync(dirname(dest), { recursive: true })
  if (entry.mode === '120000') {
    symlinkSync(body.toString('utf8'), dest)
    symlinks.push(entry.path)
    return
  }
  writeFileSync(dest, body)
  if (entry.mode === '100755') chmodSync(dest, 0o755)
}

type ByteReader = { readLine: () => Promise<string>; readExact: (n: number) => Promise<Buffer> }

async function readBlob(reader: ByteReader, oid: string): Promise<Buffer> {
  const header = await reader.readLine()
  if (header.endsWith(' missing')) {
    throw new Error(`cannot materialize candidate tree: missing object ${oid}`)
  }
  const parts = header.split(' ')
  if (parts.length < 3 || parts[0] !== oid) {
    throw new Error(`cannot materialize candidate tree: unexpected cat-file header ${header}`)
  }
  const size = Number(parts[2])
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`cannot materialize candidate tree: bad object size for ${oid}`)
  }
  const body = await reader.readExact(size)
  await reader.readExact(1)
  return body
}

function failMaterialize(detail: string): never {
  if (/lazy|partial|promisor|filter/i.test(detail)) {
    throw new Error(
      `cannot materialize candidate tree without fetching (partial clone); ${detail || 'set GIT_NO_LAZY_FETCH'}`,
    )
  }
  throw new Error(
    detail ? `cannot materialize candidate tree: ${detail}` : 'cannot materialize candidate tree',
  )
}

/** Write each blob/symlink from `<tree>` into `snapshot` with raw bytes. */
export async function materializeTree(root: string, tree: string, snapshot: string): Promise<void> {
  const entries = listTreeEntries(root, tree)
  const batch = spawn('git', ['cat-file', '--batch'], {
    cwd: root,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!(batch.stdin && batch.stdout)) throw new Error('cannot materialize candidate tree')
  const stderrChunks: Buffer[] = []
  batch.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))
  const reader = createByteReader(batch.stdout)
  const symlinks: string[] = []
  try {
    for (const entry of entries) {
      batch.stdin.write(`${entry.oid}\n`)
      writeEntry(snapshot, entry, await readBlob(reader, entry.oid), symlinks)
    }
    batch.stdin.end()
  } catch (error) {
    batch.kill('SIGKILL')
    throw error
  }
  const exit = await new Promise<number>((resolve) =>
    batch.on('close', (code) => resolve(code ?? 1)),
  )
  if (exit !== 0) failMaterialize(Buffer.concat(stderrChunks).toString('utf8').trim())
  for (const path of symlinks) assertSymlinkContained(snapshot, path)
  if (
    !(entries.some((e) => e.path === 'bun.lock') && entries.some((e) => e.path === 'package.json'))
  ) {
    throw new Error('candidate lock inputs are missing')
  }
}
