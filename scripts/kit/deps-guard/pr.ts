/** Read-only Dependabot admission over one immutable repository/PR/base/head snapshot. */

import {
  INHERITANCE_MARKER,
  PRODUCT_CONFIG,
  parseDeclaration,
} from '../lib/product-declaration.cjs'
import { evaluateWorkflowChange, type WorkflowChange } from './actions.ts'
import type { GitHubApi } from './github.ts'
import { at, str } from './json.ts'
import { dependencyEligibility } from './metadata.ts'
import { evaluateLockChange } from './npm-rules.ts'
import type { Reason, Registry, Verdict } from './types.ts'

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/
const MANIFEST = /^(?:[^/]+\/)*package\.json$/
const SHA = /^[a-f0-9]{40}$/
type PrSnapshot = {
  repositoryId: number
  pullRequestId: number
  pullRequest: number
  headSha: string
  baseSha: string
  baseRef: string
}
export type PrContext = {
  repo: string
  snapshot: PrSnapshot
  cooldownSeconds: number
  now: Date
  registry: Registry
  api: GitHubApi
  readOwnershipPolicy: () => string
}
export type PrVerdict = Verdict & { snapshot: PrSnapshot }
type PullFile = { filename: string; status: string }
type PullCommit = {
  sha: string
  author: { login?: string } | null
  committer: { login?: string } | null
  commit: { message?: string; verification?: { verified?: boolean } }
}
const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/')

function validateSnapshot(s: PrSnapshot): void {
  if (
    !(
      [s.repositoryId, s.pullRequestId, s.pullRequest].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      ) &&
      SHA.test(s.headSha) &&
      SHA.test(s.baseSha)
    ) ||
    typeof s.baseRef !== 'string' ||
    !s.baseRef ||
    s.baseRef.length > 255
  )
    throw new Error('invalid expected PR snapshot')
}

async function assertCurrent(ctx: PrContext): Promise<void> {
  const { api, repo, snapshot: s } = ctx
  const pull = await api.get(`/repos/${repo}/pulls/${s.pullRequest}`)
  if (
    pull.status !== 200 ||
    at(pull.body, 'id') !== s.pullRequestId ||
    at(pull.body, 'number') !== s.pullRequest ||
    at(pull.body, 'base', 'repo', 'id') !== s.repositoryId ||
    str(pull.body, 'head', 'sha') !== s.headSha ||
    str(pull.body, 'base', 'ref') !== s.baseRef ||
    at(pull.body, 'user', 'id') !== 49699333 ||
    str(pull.body, 'user', 'login') !== 'dependabot[bot]' ||
    str(pull.body, 'state') !== 'open'
  )
    throw new Error('current PR identity, author or snapshot differs from expected')
  const ref = await api.get(`/repos/${repo}/git/ref/heads/${enc(s.baseRef)}`)
  if (
    ref.status !== 200 ||
    str(ref.body, 'object', 'sha') !== s.baseSha ||
    str(ref.body, 'ref') !== `refs/heads/${s.baseRef}`
  )
    throw new Error('current base ref differs from expected snapshot')
}

function comparisonPage(
  body: unknown,
  status: number,
  baseSha: string,
): Record<string, unknown> & { commits: unknown[]; total_commits: number } {
  const data = body as Record<string, unknown> | null
  if (
    status !== 200 ||
    !data ||
    !Array.isArray(data.commits) ||
    typeof data.total_commits !== 'number' ||
    !Number.isSafeInteger(data.total_commits) ||
    !['ahead', 'diverged'].includes(String(data.status)) ||
    data.ahead_by !== data.total_commits ||
    data.total_commits <= 0 ||
    str(data, 'base_commit', 'sha') !== baseSha
  )
    throw new Error('incomplete or invalid immutable comparison')
  return data as Record<string, unknown> & { commits: unknown[]; total_commits: number }
}

function comparisonFiles(body: Record<string, unknown>, mergeBase: string): PullFile[] {
  if (!(SHA.test(mergeBase) && Array.isArray(body.files)) || body.files.length >= 300)
    throw new Error('comparison files incomplete or at GitHub cap')
  const files = body.files as PullFile[]
  if (
    files.some(
      (f) => !f || typeof f.filename !== 'string' || !f.filename || typeof f.status !== 'string',
    ) ||
    new Set(files.map((f) => f.filename)).size !== files.length
  )
    throw new Error('invalid comparison files')
  return files
}

function validateCommits(commits: PullCommit[], total: number, headSha: string): void {
  if (
    commits.length !== total ||
    commits.some(
      (c) => !(c && SHA.test(c.sha) && c.commit) || typeof c.commit.message !== 'string',
    ) ||
    new Set(commits.map((c) => c.sha)).size !== commits.length ||
    commits[commits.length - 1]?.sha !== headSha
  )
    throw new Error('comparison commit membership invalid')
}

function validateLaterPage(body: Record<string, unknown>, total: number, mergeBase: string): void {
  if (body.total_commits !== total || str(body, 'merge_base_commit', 'sha') !== mergeBase)
    throw new Error('inconsistent comparison pages')
}

async function compare(
  ctx: PrContext,
): Promise<{ commits: PullCommit[]; files: PullFile[]; mergeBase: string }> {
  const { api, repo, snapshot: s } = ctx
  const path = `/repos/${repo}/compare/${s.baseSha}...${s.headSha}`
  const commits: PullCommit[] = []
  let files: PullFile[] | undefined
  let mergeBase = ''
  let total = -1
  for (let page = 1; page <= 30; page++) {
    const response = await api.get(`${path}?per_page=100&page=${page}`)
    const body = comparisonPage(response.body, response.status, s.baseSha)
    if (page === 1) {
      total = body.total_commits
      mergeBase = str(body, 'merge_base_commit', 'sha') ?? ''
      files = comparisonFiles(body, mergeBase)
    } else validateLaterPage(body, total, mergeBase)
    if (body.commits.length === 0 || body.commits.length > 100)
      throw new Error('incomplete comparison commits')
    commits.push(...(body.commits as PullCommit[]))
    if (commits.length === total) break
    if (commits.length > total || body.commits.length !== 100)
      throw new Error('incomplete comparison commits')
  }
  if (!files) throw new Error('comparison commit membership invalid')
  validateCommits(commits, total, s.headSha)
  return { commits, files, mergeBase }
}

function commitReasons(commits: PullCommit[]): Reason[] {
  const reasons: Reason[] = []
  for (const c of commits) {
    const problems: string[] = []
    if (c.author?.login !== 'dependabot[bot]')
      problems.push(`author is ${c.author?.login ?? 'unknown'}`)
    if (c.committer?.login !== 'web-flow')
      problems.push(`committer is ${c.committer?.login ?? 'unknown'}`)
    if (c.commit.verification?.verified !== true) problems.push('signature not verified')
    if (problems.length)
      reasons.push({
        code: 'FOREIGN_COMMIT',
        subject: c.sha.slice(0, 12),
        detail: problems.join('; '),
      })
  }
  return reasons
}

function classifyFiles(
  files: PullFile[],
  subject: string,
): { reasons: Reason[]; workflows: string[]; lockChanged: boolean } {
  const reasons: Reason[] = []
  const workflows: string[] = []
  let lockChanged = false
  for (const f of files) {
    const edit = f.filename === 'bun.lock' || MANIFEST.test(f.filename)
    if (f.filename === 'bun.lock') lockChanged = true
    if (WORKFLOW.test(f.filename)) workflows.push(f.filename)
    if (edit && f.status !== 'modified')
      reasons.push({
        code: 'UNEXPECTED_FILE',
        subject: f.filename,
        detail: `${f.status} (only edits are expected)`,
      })
    if (!(edit || WORKFLOW.test(f.filename)))
      reasons.push({
        code: 'UNEXPECTED_FILE',
        subject: f.filename,
        detail: 'not a dependency manifest, lockfile or workflow',
      })
  }
  if (!lockChanged && workflows.length === 0)
    reasons.push({
      code: 'UNEXPECTED_FILE',
      subject,
      detail: 'neither bun.lock nor a workflow changed: nothing to verify',
    })
  return { reasons, workflows, lockChanged }
}

function validPolicyPaths(value: unknown, prefix: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (p) =>
        typeof p === 'string' &&
        p.length > 0 &&
        !p.startsWith('/') &&
        !p.includes('//') &&
        !p.split('/').some((part: string) => part === '.' || part === '..') &&
        (prefix ? p.endsWith('/') : !p.endsWith('/')),
    )
  )
}

function parseOwnershipPolicy(text: string) {
  const policy = JSON.parse(text)
  if (
    policy?.version !== 1 ||
    !validPolicyPaths(policy.protected_prefixes, true) ||
    !validPolicyPaths(policy.protected_files, false) ||
    !policy.protected_files.includes('package.json') ||
    !policy.protected_prefixes.includes('packages/') ||
    !Array.isArray(policy.kit_origin_allowlist) ||
    policy.kit_origin_allowlist.length === 0 ||
    !policy.kit_origin_allowlist.every(
      (entry: unknown) =>
        typeof entry === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry),
    ) ||
    policy.inheritance_file !== INHERITANCE_MARKER ||
    policy.protected_prefixes.some(
      (p: string) => /^apps(?:\/|$)/.test(p) && !/^apps\/[^/]+\/$/.test(p),
    )
  )
    throw new Error('ownership policy malformed')
  return policy
}

async function readOwnershipIdentity(
  ctx: PrContext,
  mergeBase: string,
  kit: boolean,
): Promise<void> {
  const { api, repo, snapshot } = ctx
  const root = `/repos/${repo}`
  const revisions = [mergeBase, snapshot.baseSha, snapshot.headSha]
  const states = await Promise.all(
    revisions.map(async (sha) => ({
      marker: await api.raw(`${root}/contents/${enc(INHERITANCE_MARKER)}?ref=${sha}`),
      declaration: await api.raw(`${root}/contents/${enc(PRODUCT_CONFIG)}?ref=${sha}`),
    })),
  )
  if (
    states.some(
      (state) => state.marker !== states[0]?.marker || state.declaration !== states[0]?.declaration,
    )
  )
    throw new Error('inheritance marker or Product declaration changed across revisions')
  const state = states[0]
  if (!state) throw new Error('identity unavailable')
  if (state.marker !== undefined) {
    const marker = JSON.parse(state.marker)
    if (
      kit ||
      typeof marker?.upstreamCommit !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(marker.upstreamCommit.trim())
    )
      throw new Error('inheritance marker conflicts with repository identity or is malformed')
  } else if (!kit) {
    throw new Error('repository is not allowlisted and has no inheritance marker')
  }
  const declaration = parseDeclaration(state.declaration ?? null, !kit)
  if (declaration.findings.length || (kit && state.declaration !== undefined))
    throw new Error('Product declaration missing, malformed, or conflicts with Kit identity')
}

/** Policy comes from the same trusted checkout as the guard, never from the PR or a moving ref. */
async function ownershipReasons(
  ctx: PrContext,
  files: PullFile[],
  mergeBase: string,
): Promise<Reason[]> {
  const { repo } = ctx
  const unavailable = (detail: string): Reason[] => [
    { code: 'OWNERSHIP_UNAVAILABLE', subject: repo, detail },
  ]
  try {
    const policy = parseOwnershipPolicy(ctx.readOwnershipPolicy())
    const kit = policy.kit_origin_allowlist.includes(repo)
    await readOwnershipIdentity(ctx, mergeBase, kit)
    if (kit) return []
    const findings: Reason[] = files
      .filter(
        ({ filename }) =>
          policy.protected_files.includes(filename) ||
          policy.protected_prefixes.some(
            (p: string) => filename === p.slice(0, -1) || filename.startsWith(p),
          ),
      )
      .map(({ filename }) => ({
        code: 'KIT_PATH' as const,
        subject: filename,
        detail: 'Kit-owned path in a Product; update the Kit and inherit it instead',
      }))
    for (const { filename } of files) {
      if (
        WORKFLOW.test(filename) &&
        !filename.startsWith('.github/workflows/product-') &&
        !policy.protected_files.includes(filename) &&
        !policy.protected_prefixes.some((prefix: string) => filename.startsWith(prefix))
      ) {
        findings.push({
          code: 'OWNERSHIP_UNAVAILABLE',
          subject: filename,
          detail: 'workflow is not classified as Product or Kit',
        })
      }
    }
    return findings
  } catch (error) {
    return unavailable(
      `identity or ownership policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function evaluatePr(ctx: PrContext): Promise<PrVerdict> {
  const { api, repo, snapshot: s } = ctx
  validateSnapshot(s)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid repository')
  await assertCurrent(ctx)
  const { commits, files, mergeBase } = await compare(ctx)
  const reasons = commitReasons(commits)
  const checked = [`commits: ${commits.length} checked (author, committer, signature)`]
  const eligibility = dependencyEligibility(commits.map((c) => c.commit.message as string))
  if (eligibility)
    reasons.push({
      code: 'METADATA_UNAVAILABLE',
      subject: `${repo}#${s.pullRequest}`,
      detail: eligibility,
    })
  const {
    reasons: fileReasons,
    workflows,
    lockChanged,
  } = classifyFiles(files, `${repo}#${s.pullRequest}`)
  reasons.push(...fileReasons)
  reasons.push(...(await ownershipReasons(ctx, files, mergeBase)))
  const root = `/repos/${repo}`
  const content = (path: string, sha: string) => api.raw(`${root}/contents/${enc(path)}?ref=${sha}`)
  const verdicts: Verdict[] = []
  if (lockChanged) {
    const [base, head] = await Promise.all([
      content('bun.lock', mergeBase),
      content('bun.lock', s.headSha),
    ])
    if (base === undefined || head === undefined)
      throw new Error('bun.lock missing on base or head')
    verdicts.push(await evaluateLockChange(base, head, ctx))
  }
  if (workflows.length) {
    const changes: WorkflowChange[] = await Promise.all(
      workflows.map(async (path) => ({
        path,
        base: await content(path, mergeBase),
        head: await content(path, s.headSha),
      })),
    )
    verdicts.push(await evaluateWorkflowChange(api, changes))
  }
  for (const v of verdicts) {
    reasons.push(...v.reasons)
    checked.push(...v.checked)
  }
  await assertCurrent(ctx)
  return { verdict: reasons.length ? 'WITHHOLD' : 'PASS', reasons, checked, snapshot: { ...s } }
}
