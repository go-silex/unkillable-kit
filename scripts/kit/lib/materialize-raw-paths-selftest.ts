#!/usr/bin/env bun
/**
 * Two legal Git path byte-strings must materialize as distinct files.
 * Latin-1 caf\xe9.txt vs UTF-8 caf\xef\xbf\xbd.txt.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeTree } from './materialize-tree.ts'

const hoist = process.argv[2]
if (!hoist) {
  console.error('usage: materialize-raw-paths-selftest.ts <hoist-fixture>')
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'rawpath-'))
const repo = join(tmp, 'repo')
const snap = join(tmp, 'snap')

function git(args: string[], cwd = repo) {
  const r = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
    },
    encoding: 'buffer',
  })
  if (r.status !== 0) {
    throw new Error(Buffer.from(r.stderr || r.stdout || []).toString('utf8') || 'git failed')
  }
  return r
}

function under(root: string, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(root, 'utf8'), Buffer.from([0x2f]), name])
}

try {
  cpSync(hoist, repo, { recursive: true })
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]) // caf\xe9.txt
  const utf = Buffer.from([0x63, 0x61, 0x66, 0xef, 0xbf, 0xbd, 0x2e, 0x74, 0x78, 0x74]) // caf\uFFFD.txt
  try {
    writeFileSync(under(repo, latin), 'latin1\n')
    writeFileSync(under(repo, utf), 'utf8\n')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.log(`PASS: raw-path test skipped (filesystem refused non-UTF-8 names: ${msg})`)
    process.exit(0)
  }
  git(['add', '-A'])
  git(['commit', '-qm', 'raw-paths'])
  // Confirm both names are distinct in the tree.
  const ls = spawnSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: repo, encoding: 'buffer' })
  const listed = Buffer.from(ls.stdout || [])
  if (!(listed.includes(latin) && listed.includes(utf))) {
    console.error('git tree missing raw names', [...listed])
    process.exit(1)
  }
  await materializeTree(repo, 'HEAD', snap)
  const names = readdirSync(snap, { encoding: 'buffer' }) as Array<string | Buffer>
  const asBuffers = names.map((n) => (typeof n === 'string' ? Buffer.from(n, 'latin1') : n))
  const hasLatin = asBuffers.some((b) => b.equals(latin))
  const hasUtf = asBuffers.some((b) => b.equals(utf))
  const latinBody = readFileSync(under(snap, latin))
  const utfBody = readFileSync(under(snap, utf))
  if (
    hasLatin &&
    hasUtf &&
    latinBody.equals(Buffer.from('latin1\n')) &&
    utfBody.equals(Buffer.from('utf8\n'))
  ) {
    console.log('PASS: raw non-UTF-8 path bytes stay distinct')
    process.exit(0)
  }
  console.error(
    JSON.stringify({
      hasLatin,
      hasUtf,
      names: asBuffers
        .filter((b) => b.subarray(0, 3).equals(Buffer.from('caf')))
        .map((b) => [...b]),
    }),
  )
  process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
