import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

export function pullRequestCheckout(root: string) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('missing pull-request event payload')
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const base: unknown = event?.pull_request?.base?.sha
  const head: unknown = event?.pull_request?.head?.sha
  const checkout = process.env.GITHUB_SHA ?? ''
  if (!(isSha(base) && isSha(head) && isSha(checkout)))
    throw new Error('malformed pull-request revisions')

  // GitHub evaluates quality on its merge commit, not on the PR branch in isolation.
  // Bind the checkout and its ordered parents without consulting mutable refs.
  if (git(root, 'rev-parse', '--is-shallow-repository').trim() !== 'false')
    throw new Error('shallow pull-request checkout')
  const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').trim()
  const [actual, baseParent, headParent, extra] = parents.split(' ')
  const mismatch = 'pull-request payload does not match checkout and merge parents'
  if (actual !== checkout || headParent !== head || !isSha(baseParent) || extra)
    throw new Error(mismatch)
  const baseAdvanced = baseParent !== base
  if (
    baseAdvanced &&
    spawnSync('git', ['merge-base', '--is-ancestor', base, baseParent], {
      cwd: root,
      stdio: 'ignore',
    }).status !== 0
  )
    throw new Error(mismatch)
  // GitHub can build the exact merge checkout after its event's base advanced.
  // This proves the checkout, but both consumers retain full coverage of that change.
  return { base, checkout, baseAdvanced }
}

export function committedPaths(root: string, base: string, head: string): string[] {
  // With renames disabled, both ownership zones of a cross-zone move are examined.
  return git(root, 'diff', '--no-renames', '--name-only', '-z', base, head, '--')
    .split('\0')
    .filter(Boolean)
}

export function hasAppManifestAt(root: string, revision: string, workspace: string): boolean {
  const manifest = `:(literal)${workspace}/package.json`
  const entry = git(root, 'ls-tree', '-rz', '--full-tree', revision, '--', manifest)
  return /^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry)
}
