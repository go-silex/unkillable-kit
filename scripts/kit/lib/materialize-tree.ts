/**
 * Materialize a Git tree as raw blobs (no checkout filters/attributes).
 * Streams `git cat-file --batch` under GIT_NO_LAZY_FETCH=1. Paths stay as
 * raw bytes; only mode-120000 symlink targets are buffered (size-capped).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from 'node:fs'
import { sep } from 'node:path'
import type { Readable } from 'node:stream'

/** Shared env for every git child: refuse promisor lazy fetches. */
export function gitNoLazyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_NO_LAZY_FETCH: '1' }
}

type TreeEntry = { mode: string; oid: string; path: Buffer }

const SLASH = 0x2f
const TAB = 0x09
const NUL = 0x00
const LF = 0x0a
/** Symlink targets are small; refuse oversized ones closed. */
const MAX_SYMLINK_TARGET = 16 * 1024

function pathForError(path: Buffer): string {
  return path.toString('utf8')
}

function joinRoot(snapshot: string, relative: Buffer): Buffer {
  return Buffer.concat([Buffer.from(snapshot, 'utf8'), Buffer.from(sep, 'utf8'), relative])
}

function dirnameBuf(path: Buffer): Buffer {
  const i = path.lastIndexOf(SLASH)
  if (i <= 0) return Buffer.from('.')
  return path.subarray(0, i)
}

function parseLsTreeRecord(record: Buffer): TreeEntry | undefined {
  const tab = record.indexOf(TAB)
  if (tab < 0) return undefined
  const meta = record.subarray(0, tab).toString('ascii')
  const path = Buffer.from(record.subarray(tab + 1))
  const [mode, , oid] = meta.split(' ')
  if (!(mode && oid && path.length > 0) || mode === '160000') return undefined
  return { mode, oid, path }
}

function parseLsTreeBuffer(buf: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = []
  let start = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== NUL) continue
    const record = buf.subarray(start, i)
    start = i + 1
    const entry = record.length ? parseLsTreeRecord(record) : undefined
    if (entry) entries.push(entry)
  }
  return entries
}

function listTreeEntries(root: string, tree: string): TreeEntry[] {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', tree], {
    cwd: root,
    env: gitNoLazyEnv(),
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

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = error.code
    return typeof code === 'string' ? code : String(code)
  }
  return ''
}

function assertSymlinkContained(snapshot: string, relativePath: Buffer): void {
  const linkPath = joinRoot(snapshot, relativePath)
  const snapshotRoot = realpathSync(snapshot)
  const rootPrefix = snapshotRoot.endsWith(sep) ? snapshotRoot : snapshotRoot + sep
  try {
    const real = realpathSync(linkPath)
    if (!(real === snapshotRoot || real.startsWith(rootPrefix))) {
      throw new Error(`candidate symlink escapes snapshot: ${pathForError(relativePath)}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('candidate symlink')) throw error
    if (errorCode(error) === 'ENOENT') return
    throw new Error(`candidate symlink unreadable: ${pathForError(relativePath)}`)
  }
}

type ByteReader = {
  readLine: () => Promise<string>
  readExact: (n: number) => Promise<Buffer>
  writeExact: (fd: number, n: number) => Promise<void>
}

/**
 * Chunk-queue reader: never Buffer.concat's the whole stream into one growing buffer.
 * Only allocates for small reads (headers / symlink targets).
 */
export function createByteReader(stream: Readable): ByteReader {
  const chunks: Buffer[] = []
  let offset = 0
  let buffered = 0
  let ended = false
  const waiters: Array<() => void> = []
  const wake = () => {
    while (waiters.length) waiters.shift()!()
  }
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    buffered += chunk.length
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
    while (buffered < min) {
      if (ended) throw new Error('cannot materialize candidate tree: truncated cat-file stream')
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  }

  function consume(n: number, into: Buffer | null, intoOffset: number): number {
    let left = n
    let filled = intoOffset
    while (left > 0) {
      const head = chunks[0]
      if (!head) throw new Error('cannot materialize candidate tree: truncated cat-file stream')
      const available = head.length - offset
      const take = Math.min(available, left)
      if (into) head.copy(into, filled, offset, offset + take)
      offset += take
      filled += take
      left -= take
      buffered -= take
      if (offset === head.length) {
        chunks.shift()
        offset = 0
      }
    }
    return filled - intoOffset
  }

  return {
    async readLine() {
      while (true) {
        let searched = 0
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!
          const from = i === 0 ? offset : 0
          const nl = chunk.indexOf(LF, from)
          if (nl >= 0) {
            const size = searched + (nl - from)
            await need(size + 1)
            const line = Buffer.allocUnsafe(size)
            consume(size, line, 0)
            consume(1, null, 0) // LF
            return line.toString('utf8')
          }
          searched += chunk.length - from
        }
        await need(buffered + 1)
      }
    },
    async readExact(n: number) {
      await need(n)
      const out = Buffer.allocUnsafe(n)
      consume(n, out, 0)
      return out
    },
    async writeExact(fd: number, n: number) {
      let left = n
      while (left > 0) {
        await need(1)
        const head = chunks[0]
        if (!head) throw new Error('cannot materialize candidate tree: truncated cat-file stream')
        const available = head.length - offset
        const wrote = writeSync(fd, head, offset, Math.min(available, left))
        if (wrote <= 0) throw new Error('cannot materialize candidate tree: write made no progress')
        offset += wrote
        left -= wrote
        buffered -= wrote
        if (offset === head.length) {
          chunks.shift()
          offset = 0
        }
      }
    },
  }
}

async function parseBlobHeader(reader: ByteReader, oid: string): Promise<number> {
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
  return size
}

function ensureParentDir(dest: Buffer): void {
  mkdirSync(dirnameBuf(dest), { recursive: true })
}

async function writeBlobEntry(
  snapshot: string,
  entry: TreeEntry,
  reader: ByteReader,
  size: number,
  symlinks: Buffer[],
): Promise<void> {
  const dest = joinRoot(snapshot, entry.path)
  ensureParentDir(dest)
  if (entry.mode === '120000') {
    if (size > MAX_SYMLINK_TARGET) {
      throw new Error(
        `cannot materialize candidate tree: symlink target too large for ${pathForError(entry.path)}`,
      )
    }
    const body = await reader.readExact(size)
    await reader.readExact(1)
    symlinkSync(body, dest)
    symlinks.push(entry.path)
    return
  }
  const fd = openSync(dest, 'w', entry.mode === '100755' ? 0o755 : 0o644)
  try {
    await reader.writeExact(fd, size)
    await reader.readExact(1)
  } finally {
    closeSync(fd)
  }
  if (entry.mode === '100755') chmodSync(dest, 0o755)
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

function pathEquals(a: Buffer, b: string): boolean {
  return a.equals(Buffer.from(b, 'utf8'))
}

/** Write each blob/symlink from `<tree>` into `snapshot` with raw bytes. */
export async function materializeTree(root: string, tree: string, snapshot: string): Promise<void> {
  const entries = listTreeEntries(root, tree)
  const batch = spawn('git', ['cat-file', '--batch'], {
    cwd: root,
    env: gitNoLazyEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!(batch.stdin && batch.stdout)) throw new Error('cannot materialize candidate tree')
  const stderrChunks: Buffer[] = []
  batch.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))
  const reader = createByteReader(batch.stdout)
  const symlinks: Buffer[] = []
  try {
    for (const entry of entries) {
      batch.stdin.write(`${entry.oid}\n`)
      const size = await parseBlobHeader(reader, entry.oid)
      await writeBlobEntry(snapshot, entry, reader, size, symlinks)
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
    !(
      entries.some((e) => pathEquals(e.path, 'bun.lock')) &&
      entries.some((e) => pathEquals(e.path, 'package.json'))
    )
  ) {
    throw new Error('candidate lock inputs are missing')
  }
}
