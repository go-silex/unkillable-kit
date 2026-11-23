import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { kitAppPrefixes } from './root-gate-enrollment'

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const fail = (message: string): never => {
  throw new Error(message)
}
type Identity = {
  repository: string
  checkoutSha: string
  runId: string
  runAttempt: string
  recipeHash: string
  runnerHash: string
}
const regular = (path: string) => {
  if (!lstatSync(path).isFile()) fail(`not a regular file: ${path}`)
}
const json = (path: string) => {
  regular(path)
  return JSON.parse(readFileSync(path, 'utf8'))
}
const same = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const version = (root: string, workspace: string) =>
  json(createRequire(join(root, workspace, 'package.json')).resolve('vitest/package.json'))
    .version as string

export function runPart(
  root: string,
  workspace: string,
  index: number,
  count: number,
  raw: string,
  bound: Identity,
) {
  const dir = resolve(raw)
  mkdirSync(dir, { recursive: false })
  const blob = join(dir, `blob-${index}-${count}.json`)
  const env = {
    ...process.env,
    COVERAGE_ONLY: workspace,
    COVERAGE_PART: `${index}/${count}`,
    COVERAGE_BLOB: blob,
  }
  const child = spawnSync(process.execPath, ['run', 'test:coverage'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  const exitCode = child.status ?? 1
  if (exitCode !== 0 || child.error || child.signal) fail('coverage part failed')
  regular(blob)
  writeFileSync(
    join(dir, `part-${index}-${count}.json`),
    `${JSON.stringify({
      version: 1,
      kind: 'coverage-part',
      workspace,
      index,
      count,
      ...bound,
      vitestVersion: version(root, workspace),
      blobSha256: digest(blob),
      exitCode,
      complete: true,
    })}\n`,
    { flag: 'wx' },
  )
}

function validatePartManifest(
  item: Record<string, unknown>,
  workspace: string,
  index: number,
  count: number,
  vitestVersion: string,
  bound: Identity,
) {
  if (
    item.version !== 1 ||
    item.kind !== 'coverage-part' ||
    item.workspace !== workspace ||
    item.index !== index ||
    item.count !== count ||
    item.complete !== true ||
    item.exitCode !== 0 ||
    item.vitestVersion !== vitestVersion
  )
    fail('invalid part manifest')
  for (const [key, value] of Object.entries(bound))
    if (item[key] !== value) fail(`part identity mismatch: ${key}`)
}

function stageParts(
  root: string,
  workspace: string,
  count: number,
  raw: string,
  bound: Identity,
  stage: string,
): string[] {
  const safe = workspace.replace('/', '__')
  const prefix = `coverage-raw-${bound.runId}-${bound.runAttempt}-${safe}-`
  const expected = Array.from({ length: count }, (_, i) => `${prefix}${i + 1}-of-${count}`)
  if (!same(readdirSync(raw), expected)) fail('raw artifact inventory mismatch')
  const blobs = join(stage, 'blobs')
  mkdirSync(blobs)
  const hashes: string[] = []
  for (let i = 1; i <= count; i++) {
    const dir = join(raw, `${prefix}${i}-of-${count}`)
    if (!lstatSync(dir).isDirectory()) fail('raw artifact is not a directory')
    const blob = `blob-${i}-${count}.json`
    const manifest = `part-${i}-${count}.json`
    if (!same(readdirSync(dir), [blob, manifest])) fail('raw part inventory mismatch')
    const item = json(join(dir, manifest))
    validatePartManifest(item, workspace, i, count, version(root, workspace), bound)
    regular(join(dir, blob))
    const hash = digest(join(dir, blob))
    if (item.blobSha256 !== hash) fail('part blob digest mismatch')
    hashes.push(hash)
    copyFileSync(join(dir, blob), join(blobs, blob))
  }
  return hashes
}

function runVitest(cwd: string, stage: string, [executable, ...args]: string[]) {
  const log = join(stage, 'vitest.log')
  const fd = openSync(log, 'w')
  const child = (() => {
    try {
      return spawnSync(executable, args, { cwd, stdio: ['inherit', fd, fd] })
    } finally {
      closeSync(fd)
    }
  })()
  const output = readFileSync(log)
  process.stdout.write(output)
  if (child.status !== 0 || child.error || child.signal) fail('native Vitest command failed')
  if (output.includes('Excluding it from coverage.'))
    fail('native Vitest silently excluded a file from coverage')
}

function replayParts(root: string, workspace: string, stage: string) {
  const cwd = join(root, workspace)
  const listing = join(stage, 'listing.json')
  const report = join(stage, 'report.json')
  runVitest(cwd, stage, ['bunx', 'vitest', 'list', '--filesOnly', `--json=${listing}`])
  const merge = [
    '--merge-reports',
    join(stage, 'blobs'),
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${report}`,
  ]
  const command = kitAppPrefixes(root).has(`${workspace}/`)
    ? ['bunx', 'vitest', 'run', '--coverage']
    : ['node', join(root, 'scripts/kit/root-gate-coverage-floors.ts'), workspace]
  runVitest(cwd, stage, [...command, ...merge])
  const listed = json(listing).map((item: { file: string }) => item.file)
  const replayed = json(report).testResults.map((item: { name: string }) => item.name)
  if (
    !listed.length ||
    listed.some((p: unknown) => typeof p !== 'string') ||
    replayed.some((p: unknown) => typeof p !== 'string') ||
    new Set(listed).size !== listed.length ||
    new Set(replayed).size !== replayed.length ||
    !same(listed, replayed)
  )
    fail('merged test file inventory mismatch')
  if (listed.some((path: string) => !resolve(path).startsWith(`${cwd}${sep}`)))
    fail('foreign test path')
  const summaryPath = join(root, 'coverage', basename(workspace), 'coverage-summary.json')
  if (!existsSync(summaryPath))
    fail(`missing coverage-summary.json for ${workspace}: expected ${summaryPath}`)
  const summary = json(summaryPath)
  for (const path of Object.keys(summary))
    if (path !== 'total' && !resolve(path).startsWith(`${cwd}${sep}`)) fail('foreign coverage path')
}

export function mergeParts(
  root: string,
  workspace: string,
  count: number,
  raw: string,
  receipt: string,
  bound: Identity,
) {
  const stage = mkdtempSync(join(tmpdir(), 'kit-coverage-merge-'))
  try {
    const hashes = stageParts(root, workspace, count, raw, bound, stage)
    replayParts(root, workspace, stage)
    writeFileSync(
      receipt,
      `${JSON.stringify({
        version: 1,
        group: 'coverage',
        shard: workspace,
        ...bound,
        tasks: ['test:coverage'],
        results: [{ task: 'test:coverage', exitCode: 0 }],
        complete: true,
        partition: { count, blobs: hashes },
      })}\n`,
      { flag: 'wx' },
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
