#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { data, Evaluator, Lexer, Parser } from '@actions/expressions'
import {
  captureAuthorization,
  issueAuthorization,
  readAuthorization,
  withdrawAuthorization,
} from './lib/head-authorization.cjs'
import { PREFIX, render } from './lib/head-authorization-core.cjs'
import { evaluate, land, productHold } from './lib/merge-gate.cjs'

const require = createRequire(import.meta.url)
type Queue = { number: number; sha: string; receipt: { id: number; body: string } }
type EventPayload = Parameters<typeof evaluate>[0]['payload']
type Check = {
  id?: number
  name: string
  status: string
  conclusion: string | null
  app?: { slug: string } | null
  check_suite?: { id: number }
}
type Workflow = {
  id: number
  path: string
  status: string
  conclusion: string | null
  run_attempt: number
  head_sha: string
  workflow_id?: number
  check_suite_id?: number
  event?: string
  head_branch?: string
  head_repository?: { id: number }
  pull_requests?: Array<{
    id: number
    number: number
    head: { ref: string; sha: string; repo: { id: number } }
    base: { ref: string; sha: string; repo: { id: number } }
  }>
}
type Job = { id?: number; name: string; status: string; conclusion: string | null }
type ListBody<R> =
  | R[]
  | { total_count: number; workflow_runs: R[] }
  | { total_count: number; jobs: R[] }
  | { total_count: number; check_runs: R[] }
type Pull = {
  number: number
  id: number
  state: string
  mergeable: boolean
  draft: boolean
  merged: boolean
  base: { ref: string; sha: string }
  head: { sha: string; ref: string; repo: { id: number; owner: { login: string } } }
  labels: Array<{ name: string }>
  user: { login: string; id: number }
}

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const BASE_A = '1'.repeat(40)
const BASE_B = '2'.repeat(40)
const STALE_BASE = '3'.repeat(40)
const GATE = 'config/product/deploy-gate.json'
const MARKER = 'config/product/inheritance.json'
const CI = '.github/workflows/product-ci.yml'
const E2E = '.github/workflows/product-e2e.yml'
const repo = { owner: 'kit', repo: 'fixture' }
const policy = { repositoryId: 1, operatorIds: [10], appId: 20, botUserId: 21 }
Object.assign(process.env, {
  HEAD_AUTH_REPOSITORY_ID: '1',
  HEAD_AUTH_OPERATOR_IDS: '[10]',
  HEAD_AUTH_APP_ID: '20',
  HEAD_AUTH_BOT_USER_ID: '21',
})
type Comment = {
  id: number
  node_id: string
  body: string
  user: { id: number; type: string }
  performed_via_github_app: { id: number } | null
}
const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = join(ROOT, '.github/workflows/merge-on-green.yml')

const core = () => {
  const lines: string[] = []
  const notices: string[] = []
  const warnings: string[] = []
  return {
    lines,
    notices,
    warnings,
    info: (line: string) => lines.push(line),
    notice: (line: string) => {
      lines.push(line)
      notices.push(line)
    },
    warning: (line: string) => {
      lines.push(line)
      warnings.push(line)
    },
    error: (line: string) => lines.push(line),
  }
}
const tree = (gate?: string[], marker = true) => ({
  ...(marker ? { [MARKER]: '{}' } : {}),
  ...(gate === undefined ? {} : { [GATE]: JSON.stringify({ workflows: gate }) }),
})
const run = (
  id: number,
  path = CI,
  status = 'completed',
  conclusion: string | null = 'success',
  attempt = 1,
  head_sha = HEAD,
): Workflow => ({
  id,
  path,
  status,
  conclusion: status === 'completed' ? conclusion : null,
  run_attempt: attempt,
  head_sha,
})
const job = (name = 'test', status = 'completed', conclusion: string | null = 'success'): Job => ({
  name,
  status,
  conclusion: status === 'completed' ? conclusion : null,
})
function strictNamespace<T extends object>(name: string, methods: T): T {
  return new Proxy(methods, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !(key in target)) throw new Error(`unmodeled ${name}.${key}`)
      return Reflect.get(target, key, receiver)
    },
  })
}

class Fake {
  branches: Record<string, string>
  trees: Record<string, Record<string, string>>
  prs: Record<number, Pull>
  checks: Record<string, Check[]>
  statuses: Record<string, { total_count: number; state: string }>
  runs: Record<string, Workflow[]>
  jobs: Record<number, Record<number, Job[]>> = {}
  afterJobs?: () => void
  switchAfterFirstBaseRead?: () => void
  baseReads = 0
  merges: Array<{ number: number; sha: string }> = []
  calls: string[] = []
  errors: Record<string, number> = {}
  mergeStatuses: Record<number, number> = {}
  commitAsObject = false
  baseEvents = 0
  baseEventType = 'BaseRefChangedEvent'
  commitBodies: Record<string, unknown> = {}
  comments: Record<number, Comment[]> = {}
  edited = new Set<number>()
  nextComment = 1
  writerIdentity: 'operator' | 'machine' = 'operator'
  addComment(number: number, body: string, identity = this.writerIdentity) {
    const id = this.nextComment++
    const comment: Comment = {
      id,
      node_id: `node${id}`,
      body,
      user: identity === 'operator' ? { id: 10, type: 'User' } : { id: 21, type: 'Bot' },
      performed_via_github_app: identity === 'operator' ? null : { id: 20 },
    }
    this.comments[number] ??= []
    this.comments[number].push(comment)
    return comment
  }
  constructor(options: Partial<Fake> = {}) {
    this.branches = options.branches ?? { main: BASE_A }
    this.trees = options.trees ?? {
      [BASE_A]: tree(undefined, false),
      [HEAD]: tree(undefined, false),
    }
    this.prs = options.prs ?? { 7: this.pr(7, HEAD) }
    this.checks = options.checks ?? { [HEAD]: this.greenChecks() }
    this.statuses = options.statuses ?? { [HEAD]: { total_count: 0, state: 'success' } }
    this.runs = options.runs ?? { [HEAD]: [] }
    this.github.rest = strictNamespace('github.rest', {
      pulls: strictNamespace('github.rest.pulls', this.github.rest.pulls),
      checks: strictNamespace('github.rest.checks', this.github.rest.checks),
      repos: strictNamespace('github.rest.repos', this.github.rest.repos),
      issues: strictNamespace('github.rest.issues', this.github.rest.issues),
      actions: strictNamespace('github.rest.actions', this.github.rest.actions),
    })
    this.merger.rest = strictNamespace('App.rest', {
      pulls: strictNamespace('App.rest.pulls', this.merger.rest.pulls),
    })
  }
  pr(number: number, sha: string, baseSha = STALE_BASE) {
    const id = number + 1000
    this.addComment(
      number,
      render({
        version: 1,
        kind: 'grant',
        operationId: `fixture-${number}`,
        repositoryId: 1,
        pullRequestId: id,
        pullRequest: number,
        headSha: sha,
        baseRef: 'main',
        baseSha: this.branches.main,
        lane: 'reviewed',
        source: 'manual',
        previous: null,
        evidence: 'fixture review',
      }),
    )
    return {
      number,
      id,
      state: 'open',
      mergeable: true,
      draft: false,
      merged: false,
      base: { ref: 'main', sha: baseSha },
      head: {
        sha,
        ref: sha === HEAD ? 'feature' : 'other',
        repo: { id: 1, owner: { login: 'kit' } },
      },
      labels: [{ name: 'reviewed' }],
      user: { login: 'human', id: 10 },
    }
  }
  greenChecks() {
    return [
      { name: 'CI', status: 'completed', conclusion: 'success', app: null },
      { name: 'Secret scan', status: 'completed', conclusion: 'success', app: null },
    ]
  }
  resolve(ref: string) {
    return this.branches[ref.replace('refs/heads/', '')] ?? ref
  }
  fail(key: string) {
    const status = this.errors[key]
    if (status !== undefined) throw Object.assign(new Error(key), { status })
  }
  assertRepo(params: { owner?: string; repo?: string }) {
    assert.equal(params.owner, repo.owner)
    assert.equal(params.repo, repo.repo)
  }

  page<T>(items: T[], page = 1, perPage = 30) {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('invalid page')
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) {
      throw new Error('invalid page size')
    }
    const start = (page - 1) * perPage
    const end = start + perPage
    return {
      data: structuredClone(items.slice(start, end)),
      headers: {
        link:
          end < items.length ? `<https://api.github.com/items?page=${page + 1}>; rel="next"` : '',
      },
    }
  }

  github = {
    graphql: async (_query: string, { ids, number }: { ids: string[]; number?: number }) => {
      if (number !== undefined) {
        this.fail(`timeline:${number}`)
        return {
          nodes: [],
          repository: {
            pullRequest: {
              number,
              baseRefName: this.prs[number].base.ref,
              headRefName: this.prs[number].head.ref,
              headRefOid: this.prs[number].head.sha,
              headRepository: { databaseId: this.prs[number].head.repo.id },
              timelineItems: {
                totalCount: 8,
                nodes: this.baseEvents ? [{ __typename: this.baseEventType }] : [],
                pageInfo: { hasNextPage: this.baseEvents > 1 },
              },
            },
          },
        }
      }
      return {
        nodes: ids.map((id) => {
          for (const [number, comments] of Object.entries(this.comments)) {
            const comment = comments.find((entry) => entry.node_id === id)
            if (comment)
              return {
                __typename: 'IssueComment',
                id,
                fullDatabaseId: String(comment.id),
                lastEditedAt: this.edited.has(comment.id) ? '2026-01-01T00:00:00Z' : null,
                repository: { fullDatabaseId: '1' },
                pullRequest: {
                  fullDatabaseId: String(this.prs[Number(number)].id),
                  number: Number(number),
                },
              }
          }
          return null
        }),
      }
    },
    paginate: async <P, R>(
      endpoint: (params: P & { page: number }) => Promise<{
        data: ListBody<R>
        headers?: { link?: string }
      }>,
      params: P,
    ): Promise<R[]> => {
      const all: R[] = []
      for (let page = 1; ; page++) {
        const { data, headers } = await endpoint({ ...params, page })
        all.push(
          ...(Array.isArray(data)
            ? data
            : 'workflow_runs' in data
              ? data.workflow_runs
              : 'jobs' in data
                ? data.jobs
                : data.check_runs),
        )
        if (!headers?.link?.includes('rel="next"')) return all
      }
    },
    rest: {
      issues: {
        listComments: async ({
          issue_number,
          page = 1,
          per_page = 100,
        }: {
          issue_number: number
          page?: number
          per_page?: number
        }) => {
          this.fail(`comments:${issue_number}:${page}`)
          const items = this.comments[issue_number] ?? []
          const result = this.page(items, page, per_page)
          return {
            data: result.data,
            headers: result.headers,
          }
        },
      },
      pulls: {
        list: async ({
          owner,
          repo: repoName,
          head,
          state,
          page,
          per_page,
        }: {
          owner: string
          repo: string
          head?: string
          state?: string
          page?: number
          per_page?: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`pulls.list:${page ?? 1}`)
          const pulls = Object.values(this.prs)
          return this.page(
            state === 'all' && head
              ? pulls.filter((pr) => `${pr.head.repo.owner.login}:${pr.head.ref}` === head)
              : pulls,
            page,
            per_page,
          )
        },
        get: async ({
          owner,
          repo: repoName,
          pull_number,
        }: {
          owner: string
          repo: string
          pull_number: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.calls.push(`pulls.get:${pull_number}`)
          this.fail(`pulls.get:${pull_number}`)
          return { data: structuredClone(this.prs[pull_number]) }
        },
      },
      checks: {
        listForRef: async ({
          owner,
          repo: repoName,
          ref,
          page,
          per_page,
        }: {
          owner: string
          repo: string
          ref: string
          page?: number
          per_page?: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`checks:${ref}`)
          const items = this.checks[ref] ?? []
          const { data, headers } = this.page(items, page, per_page)
          return { data: { total_count: items.length, check_runs: data }, headers }
        },
      },
      repos: {
        get: async () => ({ data: { id: 1 } }),
        getCommit: async ({
          owner,
          repo: repoName,
          ref,
        }: {
          owner: string
          repo: string
          ref: string
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`commit:${ref}`)
          const sha = this.resolve(ref)
          if (!(/^[a-f0-9]{40}$/i.test(sha) && this.trees[sha])) {
            throw Object.assign(new Error('unknown ref'), { status: 422 })
          }
          this.calls.push(`commit:${ref}:${sha}`)
          return { data: this.commitBodies[ref] ?? (this.commitAsObject ? { sha } : sha) }
        },
        getContent: async ({
          owner,
          repo: repoName,
          ref = 'refs/heads/main',
          path,
          mediaType,
        }: {
          owner: string
          repo: string
          ref?: string
          path: string
          mediaType?: { format?: string }
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`content:${ref}`)
          const sha = this.resolve(ref)
          this.calls.push(`content:${ref}:${path}:${sha}`)
          if (ref === 'refs/heads/main' && ++this.baseReads === 1) this.switchAfterFirstBaseRead?.()
          const value = this.trees[sha]?.[path]
          if (value === undefined) throw Object.assign(new Error('missing'), { status: 404 })
          if (mediaType?.format !== 'raw')
            return { data: { type: 'file', encoding: 'base64', content: value } }
          return { data: value }
        },
        getCombinedStatusForRef: async ({
          owner,
          repo: repoName,
          ref,
        }: {
          owner: string
          repo: string
          ref: string
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`status:${ref}`)
          return { data: structuredClone(this.statuses[ref]) }
        },
      },
      actions: {
        listWorkflowRunsForRepo: async ({
          owner,
          repo: repoName,
          head_sha,
          page,
          per_page,
        }: {
          owner: string
          repo: string
          head_sha: string
          page?: number
          per_page?: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`runs:${head_sha}`)
          const items = this.runs[head_sha] ?? []
          const { data, headers } = this.page(items, page, per_page)
          return { data: { total_count: items.length, workflow_runs: data }, headers }
        },
        listJobsForWorkflowRunAttempt: async ({
          owner,
          repo: repoName,
          run_id,
          attempt_number,
          page,
          per_page,
        }: {
          owner: string
          repo: string
          run_id: number
          attempt_number: number
          page?: number
          per_page?: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`jobs:${run_id}`)
          const jobs = this.jobs[run_id]?.[attempt_number]
          if (!jobs) throw Object.assign(new Error('unknown attempt'), { status: 404 })
          const { data, headers } = this.page(jobs, page, per_page)
          this.afterJobs?.()
          return { data: { total_count: jobs.length, jobs: data }, headers }
        },
        getWorkflowRun: async ({
          owner,
          repo: repoName,
          run_id,
        }: {
          owner: string
          repo: string
          run_id: number
        }) => {
          this.assertRepo({ owner, repo: repoName })
          this.fail(`run:${run_id}`)
          const value = Object.values(this.runs)
            .flat()
            .find((item) => item.id === run_id)
          if (!value) throw Object.assign(new Error('unknown run'), { status: 404 })
          return { data: structuredClone(value) }
        },
      },
    },
  }
  writer = {
    rest: {
      issues: {
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
          this.fail(`write:${issue_number}`)
          return { data: this.addComment(issue_number, body) }
        },
      },
    },
  }
  merger = {
    rest: {
      pulls: {
        merge: async ({
          owner,
          repo: repoName,
          pull_number,
          sha,
          merge_method = 'merge',
        }: {
          owner: string
          repo: string
          pull_number: number
          sha: string
          merge_method?: string
        }) => {
          this.assertRepo({ owner, repo: repoName })
          if (merge_method !== 'merge') throw new Error('non-merge method')
          const status = this.mergeStatuses[pull_number]
          if (status !== undefined) throw Object.assign(new Error('merge failed'), { status })
          if (this.prs[pull_number].head.sha !== sha)
            throw Object.assign(new Error('moved'), { status: 409 })
          this.merges.push({ number: pull_number, sha })
          const prior = this.branches.main
          const next = (this.merges.length + 7).toString(16).padStart(40, '0')
          this.trees[next] = { ...this.trees[prior], ...this.trees[sha] }
          this.branches.main = next
        },
      },
    },
  }
}
const evaluateFake = (fake: Fake) =>
  evaluate({ github: fake.github, repo, payload: { inputs: { pr: '7' } }, core: core(), policy })
const landFake = (
  fake: Fake,
  queue: Array<{ number: number; sha?: string; receipt?: { id: number; body: string } }>,
) => land({ github: fake.github, merger: fake.merger, repo, queue, core: core(), policy })

// Two reviewed, green PRs (7 on HEAD, 8 on OTHER). `declared` makes every tree a Product tree.
const pair = (declared?: string[]) => {
  const marker = declared !== undefined
  const fake = new Fake({
    trees: {
      [BASE_A]: tree(declared, marker),
      [HEAD]: tree(declared, marker),
      [OTHER]: tree(declared, marker),
    },
    prs: {},
    checks: {},
    statuses: {
      [HEAD]: { total_count: 0, state: 'success' },
      [OTHER]: { total_count: 0, state: 'success' },
    },
    runs: { [HEAD]: [], [OTHER]: [] },
  })
  fake.prs[7] = fake.pr(7, HEAD)
  fake.prs[8] = fake.pr(8, OTHER)
  fake.checks[HEAD] = fake.greenChecks()
  fake.checks[OTHER] = fake.greenChecks()
  return fake
}

type Step = { id?: string; name?: string; run?: string; with?: { script?: string } }
function shippedSteps(): Step[] {
  // The shipped workflow is trusted repository source, so a named shape is enough here.
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: { 'merge-on-green': { steps: Step[] } }
  }
  return workflow.jobs['merge-on-green'].steps
}
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...arguments_: string[]
) => (...values: unknown[]) => Promise<void>

async function runMergeWrapper(fake: Fake, queue: Queue[]) {
  const source = shippedSteps().find((step) => step.id === 'merge')?.with?.script
  assert.ok(source)
  const outputs: Record<string, string> = {}
  const failures: string[] = []
  const wrapperCore = {
    ...core(),
    setOutput: (name: string, value: string) => {
      outputs[name] = value
    },
    setFailed: (message: string) => {
      failures.push(message)
    },
  }
  const execute = new AsyncFunction('github', 'context', 'core', 'require', 'getOctokit', source)
  const previous = process.env.TO_MERGE
  process.env.TO_MERGE = JSON.stringify(queue)
  try {
    await execute(
      fake.github,
      { repo, payload: {} },
      wrapperCore,
      (id: string) => require(join(ROOT, id)),
      () => fake.merger,
    )
  } finally {
    if (previous === undefined) delete process.env.TO_MERGE
    else process.env.TO_MERGE = previous
  }
  return { outputs, failures }
}

function runFinalStep(evaluateUnreadable: string[], mergeUnreadable: string | undefined) {
  const script = shippedSteps().find((step) => step.name === 'Fail on unreadable merge gate')?.run
  assert.ok(script)
  return Bun.spawnSync(['bash', '-c', script], {
    env: {
      ...process.env,
      EVALUATE_UNREADABLE: JSON.stringify(evaluateUnreadable),
      MERGE_UNREADABLE: mergeUnreadable ?? '[]',
    },
  })
}

const cases: Array<[string, () => Promise<void>]> = []
const test = (name: string, run: () => Promise<void>) => cases.push([name, run])

test('shipped eligibility admits only validated wakeups into the serialized merge job', async () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: { 'merge-on-green': { if: string } }
  }
  const gate = workflow.jobs['merge-on-green']
  type Context = { [key: string]: string | Context }
  const dictionary = (value: Context): data.Dictionary =>
    new data.Dictionary(
      ...Object.entries(value).map(([key, item]) => ({
        key,
        value: typeof item === 'string' ? new data.StringData(item) : dictionary(item),
      })),
    )
  const expression = new Parser(
    new Lexer(`!!(${gate.if})`).lex().tokens,
    ['github', 'needs'],
    [],
  ).parse()
  for (const [event, action, ref, eligible, expected] of [
    ['workflow_run', '', 'refs/heads/main', 'true', true],
    ['workflow_dispatch', '', 'refs/heads/main', 'true', true],
    ['workflow_dispatch', '', 'refs/heads/feature', 'true', false],
    ['pull_request_target', 'labeled', 'refs/heads/main', 'true', true],
    ['pull_request_target', 'synchronize', 'refs/heads/main', 'true', false],
    ['issue_comment', 'created', 'refs/heads/main', 'true', true],
    ['issue_comment', 'created', 'refs/heads/main', '', false],
  ] as Array<[string, string, string, string, boolean]>) {
    const context = dictionary({
      needs: { preflight: { outputs: { eligible } } },
      github: {
        event_name: event,
        actor: 'operator',
        ref,
        repository: 'kit/fixture',
        event: {
          action,
          label: { name: 'reviewed' },
          issue: { pull_request: { url: 'pr' } },
          pull_request: { head: { repo: { full_name: 'kit/fixture' } } },
          repository: { default_branch: 'main' },
        },
      },
    })
    assert.equal(
      new Evaluator(expression, context).evaluate().coerceString(),
      String(expected),
      event,
    )
  }
})

test('a bootstrap head declaration is judged by its own run and holds when that run is missing', async () => {
  const api = {
    resolveCommit: async (ref: string) => ref,
    readFiles: async (ref: string) =>
      ref === BASE_A
        ? [JSON.stringify({ workflows: [CI] }), null]
        : [JSON.stringify({ workflows: [E2E] }), JSON.stringify({ workflows: [E2E] })],
    listWorkflowRuns: async () => [run(1, CI), run(2, E2E)],
    listJobs: async () => [job()],
    getWorkflowRun: async (id: number) => (id === 1 ? run(1, CI) : run(2, E2E)),
  }
  assert.deepEqual(await productHold(api, { base: BASE_A, head: HEAD }), [])
  assert.match(
    (
      await productHold({ ...api, listWorkflowRuns: async () => [] }, { base: BASE_A, head: HEAD })
    )[0],
    /missing/,
  )
})

test('missing, skipped, failed, pending, empty, attempt-changed and post-read Product evidence holds', async () => {
  for (const [name, runs, jobs, mutate] of [
    ['missing', [], [], undefined],
    ['skipped', [run(1, CI, 'completed', 'skipped')], [], undefined],
    ['failed', [run(1, CI, 'completed', 'failure')], [], undefined],
    ['queued', [run(1, CI, 'queued')], [], undefined],
    ['empty', [run(1)], [], undefined],
    ['job pending', [run(1)], [job('x', 'in_progress')], undefined],
    ['attempt changed', [run(1)], [job()], () => run(1, CI, 'completed', 'success', 2)],
  ] as Array<[string, Workflow[], Job[], (() => Workflow) | undefined]>) {
    const api = {
      resolveCommit: async (x: string) => x,
      readFiles: async () => ['{}', JSON.stringify({ workflows: [CI] })],
      listWorkflowRuns: async () => runs,
      listJobs: async () => jobs,
      getWorkflowRun: async () => mutate?.() ?? runs[0] ?? assert.fail('unknown run'),
    }
    assert.ok((await productHold(api, { base: BASE_A, head: HEAD })).length, name)
  }
})

test('coherent immutable base reads hold both mixed A/B schedules and ignore stale PR base.sha', async () => {
  for (const [first, second] of [
    [BASE_A, BASE_B],
    [BASE_B, BASE_A],
  ]) {
    const fake = new Fake({
      branches: { main: first },
      trees: {
        [BASE_A]: tree([CI], false),
        [BASE_B]: tree(undefined, true),
        [STALE_BASE]: tree(),
        [HEAD]: tree(undefined, false),
      },
    })
    fake.switchAfterFirstBaseRead = () => {
      fake.branches.main = second
    }
    assert.deepEqual((await evaluateFake(fake)).toMerge, [])
    assert.ok(fake.calls.some((call) => call === `commit:refs/heads/main:${first}`))
    assert.ok(!fake.calls.some((call) => call.includes(STALE_BASE)))
  }
})

test('coherent green Product control merges and malformed resolved SHA is unreadable', async () => {
  const green = new Fake({
    trees: { [BASE_A]: tree([CI]), [HEAD]: tree([CI]) },
    runs: { [HEAD]: [run(1)] },
  })
  green.jobs[1] = { 1: [job()] }
  const selected = await evaluateFake(green)
  await landFake(green, selected.toMerge)
  assert.deepEqual(green.merges, [{ number: 7, sha: HEAD }])
  const malformed = new Fake()
  malformed.commitBodies['refs/heads/main'] = { sha: 'not-a-sha' }
  const refused = await evaluateFake(malformed)
  assert.deepEqual(refused.toMerge, [])
  assert.equal(refused.unreadable.length, 1)
})

test('final complete verdict blocks current red checks, in-progress rerun and failed combined status', async () => {
  for (const change of [
    (f: Fake) => {
      f.checks[HEAD][0].conclusion = 'failure'
    },
    (f: Fake) => {
      f.checks[HEAD][0].status = 'in_progress'
      f.checks[HEAD][0].conclusion = null
    },
    (f: Fake) => {
      f.statuses[HEAD] = { total_count: 1, state: 'failure' }
    },
  ]) {
    const fake = new Fake()
    const selected = await evaluateFake(fake)
    change(fake)
    const landed = await landFake(fake, selected.toMerge)
    assert.equal(fake.merges.length, 0)
    assert.deepEqual(landed.unreadable, [])
  }
})

test('losing a label does not revoke an authorized candidate', async () => {
  const fake = new Fake({
    trees: {
      [BASE_A]: tree(undefined, false),
      [HEAD]: tree(undefined, false),
      [OTHER]: tree(undefined, false),
    },
    prs: {},
  })
  fake.prs[7] = fake.pr(7, HEAD)
  fake.prs[8] = fake.pr(8, OTHER)
  fake.checks[HEAD] = fake.greenChecks()
  fake.checks[OTHER] = fake.greenChecks()
  fake.statuses[OTHER] = { total_count: 0, state: 'success' }
  const selected = await evaluateFake(fake)
  fake.prs[7].labels = []
  await landFake(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [
    { number: 7, sha: HEAD },
    { number: 8, sha: OTHER },
  ])
  assert.notEqual(fake.branches.main, BASE_A)
})

test('the second sequential candidate re-resolves the immutable base after the first merge', async () => {
  const fake = new Fake({
    trees: {
      [BASE_A]: tree(undefined, false),
      [HEAD]: tree([CI]),
      [OTHER]: tree(undefined, false),
    },
    prs: {},
    checks: { [HEAD]: [], [OTHER]: [] },
    statuses: {
      [HEAD]: { total_count: 0, state: 'success' },
      [OTHER]: { total_count: 0, state: 'success' },
    },
    runs: { [HEAD]: [run(1)], [OTHER]: [] },
  })
  fake.jobs[1] = { 1: [job()] }
  fake.prs[7] = fake.pr(7, HEAD)
  fake.prs[8] = fake.pr(8, OTHER)
  fake.checks[HEAD] = fake.greenChecks()
  fake.checks[OTHER] = fake.greenChecks()
  const selected = await evaluateFake(fake)
  await landFake(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [{ number: 7, sha: HEAD }])
  assert.notEqual(fake.branches.main, BASE_A)
})

test('Kit trees use no Product Actions calls; removed and invalid declarations hold with no write', async () => {
  let actions = 0
  const kit = {
    resolveCommit: async (ref: string) => ref,
    readFiles: async () => [null, null],
    listWorkflowRuns: async () => {
      actions++
      return []
    },
    listJobs: async () => {
      actions++
      return []
    },
    getWorkflowRun: async () => {
      actions++
      return run(1)
    },
  }
  assert.deepEqual(await productHold(kit, { base: BASE_A, head: HEAD }), [])
  assert.equal(actions, 0)

  for (const headTree of [tree(undefined, false), { [MARKER]: '{}', [GATE]: '{' }]) {
    const fake = new Fake({
      trees: { [BASE_A]: tree([CI]), [HEAD]: headTree },
      statuses: { [HEAD]: { total_count: 0, state: 'success' } },
    })
    fake.checks[HEAD] = fake.greenChecks()
    const selected = await evaluateFake(fake)
    await landFake(fake, selected.toMerge)
    assert.deepEqual(selected.toMerge, [])
    assert.deepEqual(fake.merges, [])
  }
})

test('a head moved after evaluation is refused as stale and never merged unassessed', async () => {
  const fake = new Fake()
  const selected = await evaluateFake(fake)
  fake.prs[7].head.sha = OTHER
  fake.trees[OTHER] = tree()
  fake.checks[OTHER] = fake.greenChecks()
  fake.statuses[OTHER] = { total_count: 0, state: 'success' }
  const landed = await landFake(fake, selected.toMerge)
  assert.equal(landed.stale.length, 1)
  assert.equal(fake.merges.length, 0)
})

test('latest Product run, exact rerun jobs, every job, and post-job reread all fail closed', async () => {
  const declaration = JSON.stringify({ workflows: [CI] })
  for (const [runs, jobs, current, expected] of [
    [[], [], undefined, 'missing'],
    [[run(2, CI, 'completed', 'failure'), run(1)], [], undefined, 'failure'],
    [[run(1, CI, 'completed', 'skipped')], [], undefined, 'skipped'],
    [[run(1, CI, 'in_progress')], [], undefined, 'in_progress'],
    [[run(1)], [], undefined, 'no jobs'],
    [[run(1)], [job('build', 'skipped')], undefined, 'build=skipped'],
    [[run(1)], [job('build')], run(1, CI, 'completed', 'success', 2), 'attempt changed'],
  ] as Array<[Workflow[], Job[], Workflow | undefined, string]>) {
    const api = {
      resolveCommit: async (ref: string) => ref,
      readFiles: async () => ['{}', declaration],
      listWorkflowRuns: async () => runs,
      listJobs: async () => jobs,
      getWorkflowRun: async () => current ?? runs[0] ?? assert.fail('unknown run'),
    }
    assert.match(
      (await productHold(api, { base: BASE_A, head: HEAD }))[0] ?? '',
      new RegExp(expected),
    )
  }
})

test('base and head declaration union retains removals, admits bootstrap, and requires additions', async () => {
  const declaration = (workflows: string[]) => JSON.stringify({ workflows })
  const api = (base: string | null, head: string | null, runs: Workflow[]) => ({
    resolveCommit: async (ref: string) => ref,
    readFiles: async (ref: string) => (ref === BASE_A ? ['{}', base] : ['{}', head]),
    listWorkflowRuns: async () => runs,
    listJobs: async () => [job()],
    getWorkflowRun: async (id: number) =>
      runs.find((candidate) => candidate.id === id) ?? assert.fail('unknown run'),
  })
  assert.match(
    (
      await productHold(api(declaration([CI]), declaration([]), []), { base: BASE_A, head: HEAD })
    )[0] ?? '',
    /product-ci\.yml=missing/,
  )
  assert.deepEqual(
    await productHold(api(null, declaration([CI]), [run(1)]), { base: BASE_A, head: HEAD }),
    [],
  )
  assert.match(
    (
      await productHold(
        api(declaration([CI]), declaration([CI, E2E]), [
          run(1),
          run(2, E2E, 'completed', 'failure'),
        ]),
        { base: BASE_A, head: HEAD },
      )
    )[0] ?? '',
    /product-e2e\.yml=failure/,
  )
})

test('selected Product evidence is bound to the assessed head, workflow path, and post-job run identity', async () => {
  const declaration = JSON.stringify({ workflows: [CI] })
  for (const current of [run(1, CI, 'completed', 'success', 1, OTHER), run(1, E2E), run(2, CI)]) {
    const api = {
      resolveCommit: async (ref: string) => ref,
      readFiles: async () => ['{}', declaration],
      listWorkflowRuns: async () => [run(1)],
      listJobs: async () => [job()],
      getWorkflowRun: async () => current,
    }
    assert.match((await productHold(api, { base: BASE_A, head: HEAD }))[0] ?? '', /run changed/)
  }
  const wrongHead = {
    resolveCommit: async (ref: string) => ref,
    readFiles: async () => ['{}', declaration],
    listWorkflowRuns: async () => [run(1, CI, 'completed', 'success', 1, OTHER)],
    listJobs: async () => [job()],
    getWorkflowRun: async () => run(1),
  }
  assert.match((await productHold(wrongHead, { base: BASE_A, head: HEAD }))[0] ?? '', /wrong head/)
})
test('strict API fixture aggregates paginated workflow runs and exact-attempt jobs before judging', async () => {
  const fake = new Fake({ trees: { [BASE_A]: tree([CI]), [HEAD]: tree([CI]) } })
  fake.runs[HEAD] = Array.from({ length: 100 }, (_, id) => run(id + 1, E2E))
  fake.runs[HEAD].push(run(101, CI, 'completed', 'failure'))
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  fake.runs[HEAD][100] = run(101, CI)
  fake.jobs[101] = {
    1: [...Array.from({ length: 100 }, (_, id) => job(`shard-${id}`)), job('last', 'skipped')],
  }
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
})
test('the shipped Evaluate wrapper executes against the strict fake and returns its behavioral queue', async () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: { 'merge-on-green': { steps: Array<{ id?: string; with?: { script?: string } }> } }
  }
  const source = workflow.jobs['merge-on-green'].steps.find((step) => step.id === 'evaluate')?.with
    ?.script
  assert.ok(source)
  const fake = new Fake()
  const outputs: Record<string, string> = {}
  const wrapperCore = {
    ...core(),
    setOutput: (name: string, value: string) => {
      outputs[name] = value
    },
  }
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...arguments_: string[]
  ) => (...values: unknown[]) => Promise<void>
  const execute = new AsyncFunction('github', 'context', 'core', 'require', 'getOctokit', source)
  await execute(
    fake.github,
    { repo, payload: { inputs: { pr: '7' } } },
    wrapperCore,
    (id: string) => require(join(ROOT, id)),
    () => fake.merger,
  )
  const queue = JSON.parse(outputs.to_merge ?? '[]') as Queue[]
  assert.equal(queue.length, 1)
  assert.equal(queue[0].number, 7)
  assert.equal(queue[0].sha, HEAD)
  assert.equal(queue[0].receipt.id, fake.comments[7][0].id)
  assert.equal(queue[0].receipt.body, fake.comments[7][0].body)
  assert.deepEqual(JSON.parse(outputs.unreadable ?? '[]'), [])
})
test('the shipped Merge wrapper executes a fresh complete verdict and uses only the supplied merger', async () => {
  const fake = new Fake()
  const { outputs } = await runMergeWrapper(fake, (await evaluateFake(fake)).toMerge)
  assert.deepEqual(fake.merges, [{ number: 7, sha: HEAD }])
  assert.deepEqual(JSON.parse(outputs.unreadable ?? '[]'), [])
})
test('strict fixture keeps unreadable candidate failures isolated and preserves event fallback', async () => {
  for (const key of [
    'pulls.get:7',
    `checks:${HEAD}`,
    `status:${HEAD}`,
    `commit:${HEAD}`,
    `content:${HEAD}`,
  ]) {
    const fake = new Fake({
      trees: {
        [BASE_A]: tree(undefined, false),
        [HEAD]: tree(undefined, false),
        [OTHER]: tree(undefined, false),
      },
      prs: {},
      checks: { [HEAD]: [], [OTHER]: [] },
      statuses: {
        [HEAD]: { total_count: 0, state: 'success' },
        [OTHER]: { total_count: 0, state: 'success' },
      },
      runs: { [HEAD]: [], [OTHER]: [] },
    })
    fake.prs[7] = fake.pr(7, HEAD)
    fake.prs[8] = fake.pr(8, OTHER)
    fake.checks[HEAD] = fake.greenChecks()
    fake.checks[OTHER] = fake.greenChecks()
    fake.errors[key] = 502
    const result = await evaluateFake(fake)
    assert.deepEqual(
      result.toMerge.map(({ number, sha }) => ({ number, sha })),
      [{ number: 8, sha: OTHER }],
      key,
    )
    assert.equal(result.unreadable.length, 1, key)
  }
  const fallback = new Fake()
  fallback.errors['pulls.list:1'] = 502
  assert.deepEqual(
    (await evaluateFake(fallback)).toMerge.map(({ number, sha }) => ({ number, sha })),
    [{ number: 7, sha: HEAD }],
  )
})

test('the shipped final step goes red for a real unreadable Evaluate output', async () => {
  const fake = pair()
  fake.errors['pulls.get:7'] = 502
  const selected = await evaluateFake(fake)
  assert.deepEqual(
    selected.toMerge.map(({ number, sha }) => ({ number, sha })),
    [{ number: 8, sha: OTHER }],
  )
  assert.equal(selected.unreadable.length, 1)
  assert.equal(runFinalStep(selected.unreadable, '[]').exitCode, 1)
})
test('a non-409 App merge error is unreadable for that candidate, the next merges, and the shipped final step goes red', async () => {
  const clean = pair()
  const cleanSelected = await evaluateFake(clean)
  const cleanRun = await runMergeWrapper(clean, cleanSelected.toMerge)
  assert.equal(clean.merges.length, 2)
  assert.deepEqual(JSON.parse(cleanRun.outputs.unreadable ?? '[]'), [])

  const fake = pair()
  const selected = await evaluateFake(fake)
  assert.equal(selected.toMerge.length, 2)
  fake.mergeStatuses[7] = 403
  const { outputs, failures } = await runMergeWrapper(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }])
  const unreadable = JSON.parse(outputs.unreadable ?? '[]') as string[]
  assert.equal(unreadable.length, 1)
  assert.deepEqual(failures, [])
  const final = runFinalStep(selected.unreadable, outputs.unreadable)
  assert.equal(final.exitCode, 1)
  assert.ok(final.stdout.toString().includes(unreadable[0]))
})
test('fresh landing read errors hold one queued candidate, merge the next, and leave unreadable evidence', async () => {
  for (const key of [
    'pulls.get:7',
    `checks:${HEAD}`,
    `status:${HEAD}`,
    `commit:${HEAD}`,
    `content:${HEAD}`,
  ]) {
    const fake = new Fake({
      trees: {
        [BASE_A]: tree(undefined, false),
        [HEAD]: tree(undefined, false),
        [OTHER]: tree(undefined, false),
      },
      prs: {},
      checks: { [HEAD]: [], [OTHER]: [] },
      statuses: {
        [HEAD]: { total_count: 0, state: 'success' },
        [OTHER]: { total_count: 0, state: 'success' },
      },
      runs: { [HEAD]: [], [OTHER]: [] },
    })
    fake.prs[7] = fake.pr(7, HEAD)
    fake.prs[8] = fake.pr(8, OTHER)
    fake.checks[HEAD] = fake.greenChecks()
    fake.checks[OTHER] = fake.greenChecks()
    const selected = await evaluateFake(fake)
    fake.errors[key] = 502
    const landed = await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }], key)
    assert.equal(landed.unreadable.length, 1, key)
  }
})
test('a pinned merge 409 is stale evidence for that candidate and does not starve the next', async () => {
  const fake = new Fake({
    trees: {
      [BASE_A]: tree(undefined, false),
      [HEAD]: tree(undefined, false),
      [OTHER]: tree(undefined, false),
    },
    prs: {},
    checks: { [HEAD]: [], [OTHER]: [] },
    statuses: {
      [HEAD]: { total_count: 0, state: 'success' },
      [OTHER]: { total_count: 0, state: 'success' },
    },
    runs: { [HEAD]: [], [OTHER]: [] },
  })
  fake.prs[7] = fake.pr(7, HEAD)
  fake.prs[8] = fake.pr(8, OTHER)
  fake.checks[HEAD] = fake.greenChecks()
  fake.checks[OTHER] = fake.greenChecks()
  const selected = await evaluateFake(fake)
  const merge = fake.merger.rest.pulls.merge
  let first = true
  fake.merger.rest.pulls.merge = async (params: {
    owner: string
    repo: string
    pull_number: number
    sha: string
    merge_method?: string
  }) => {
    if (first) {
      first = false
      throw Object.assign(new Error('head moved'), { status: 409 })
    }
    return merge(params)
  }
  const landed = await landFake(fake, selected.toMerge)
  assert.equal(landed.stale.length, 1)
  assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }])
})
test('Product Actions run, exact-attempt job, and post-job reads remain candidate-isolated at landing', async () => {
  for (const [name, fault] of [
    [
      'run list',
      (fake: Fake) => {
        fake.errors[`runs:${HEAD}`] = 502
      },
    ],
    [
      'missing exact-attempt jobs',
      (fake: Fake) => {
        delete fake.jobs[1]
      },
    ],
    [
      'run missing after its jobs were read',
      (fake: Fake) => {
        fake.afterJobs = () => {
          fake.runs[HEAD] = fake.runs[HEAD].filter((candidate) => candidate.id !== 1)
        }
      },
    ],
  ] as Array<[string, (fake: Fake) => void]>) {
    const fake = pair([CI])
    fake.runs[HEAD] = [run(1)]
    fake.runs[OTHER] = [run(2, CI, 'completed', 'success', 1, OTHER)]
    fake.jobs[1] = { 1: [job()] }
    fake.jobs[2] = { 1: [job()] }
    const selected = await evaluateFake(fake)
    assert.equal(selected.toMerge.length, 2, name)
    fault(fake)
    const landed = await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }], name)
    assert.equal(landed.unreadable.length, 1, name)
  }
})
test('final eligibility rechecks Dependabot identity', async () => {
  const fake = new Fake()
  fake.comments[7] = []
  fake.prs[7].user = { login: 'dependabot[bot]', id: 49699333 }
  fake.writerIdentity = 'machine'
  const snapshot = await captureAuthorization({ github: fake.github, repo, prNumber: 7, policy })
  await issueAuthorization({
    github: fake.github,
    writer: fake.writer,
    repo,
    snapshot,
    policy,
    lane: 'dependabot',
    source: 'dependabot',
    evidence: 'guard',
    operationId: 'machine',
  })
  const selected = await evaluateFake(fake)
  assert.equal(selected.toMerge.length, 1)
  fake.prs[7].user = { login: 'human', id: 10 }
  await landFake(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [])
})
test('Product run outcomes and invalid or absent attempts hold before exact-attempt jobs are read', async () => {
  for (const [status, conclusion, attempt] of [
    ['completed', 'neutral', 1],
    ['completed', 'cancelled', 1],
    ['completed', 'timed_out', 1],
    ['in_progress', null, 1],
    ['completed', 'success', 'absent'],
    ['completed', 'success', Number.NaN],
    ['completed', 'success', 0],
    ['completed', 'success', -1],
    ['completed', 'success', 1.5],
  ] as Array<[string, string | null, number | 'absent']>) {
    let jobCalls = 0
    const selected = run(1, CI, status, conclusion, attempt === 'absent' ? 1 : attempt)
    if (attempt === 'absent') Reflect.deleteProperty(selected, 'run_attempt')
    assert.equal('run_attempt' in selected, attempt !== 'absent')
    const api = {
      resolveCommit: async (ref: string) => ref,
      readFiles: async () => ['{}', JSON.stringify({ workflows: [CI] })],
      listWorkflowRuns: async () => [selected],
      listJobs: async () => {
        jobCalls++
        return [job()]
      },
      getWorkflowRun: async () => selected,
    }
    assert.equal((await productHold(api, { base: BASE_A, head: HEAD })).length, 1)
    assert.equal(jobCalls, 0)
  }
})

test('attempt selection, latest-id order, two workflows, and page-two green Product evidence merge', async () => {
  for (const [attempt, first, second, expected] of [
    [2, 'failure', 'success', true],
    [2, 'success', 'skipped', false],
  ] as Array<[number, string, string, boolean]>) {
    const fake = new Fake({
      trees: { [BASE_A]: tree([CI]), [HEAD]: tree([CI]) },
      runs: { [HEAD]: [run(1, CI, 'completed', 'success', attempt)] },
    })
    fake.jobs[1] = { 1: [job('build', 'completed', first)], 2: [job('build', 'completed', second)] }
    assert.equal((await evaluateFake(fake)).toMerge.length === 1, expected)
  }
  for (const [runs, expected] of [
    [[run(2, CI, 'completed', 'failure'), run(1)], []],
    [[run(1), run(2, CI, 'completed', 'failure')], []],
    [[run(2), run(1, CI, 'completed', 'failure')], [{ number: 7, sha: HEAD }]],
    [[run(1, CI, 'completed', 'failure'), run(2)], [{ number: 7, sha: HEAD }]],
  ] as Array<[Workflow[], Array<{ number: number; sha: string }>]>) {
    const fake = new Fake({
      trees: { [BASE_A]: tree([CI]), [HEAD]: tree([CI]) },
      runs: { [HEAD]: runs },
    })
    fake.jobs[1] = { 1: [job()] }
    fake.jobs[2] = { 1: [job()] }
    assert.deepEqual(
      (await evaluateFake(fake)).toMerge.map(({ number, sha }) => ({ number, sha })),
      expected,
    )
  }
  const paged = new Fake({ trees: { [BASE_A]: tree([CI, E2E]), [HEAD]: tree([CI, E2E]) } })
  paged.runs[HEAD] = Array.from({ length: 100 }, (_, index) => run(index + 1, E2E))
  paged.runs[HEAD].push(run(101, CI), run(102, E2E))
  paged.jobs[101] = { 1: [job('ci')] }
  paged.jobs[102] = { 1: [job('e2e')] }
  assert.deepEqual(
    (await evaluateFake(paged)).toMerge.map(({ number, sha }) => ({ number, sha })),
    [{ number: 7, sha: HEAD }],
  )
  for (const [ciJob, e2eJob, expected] of [
    ['success', 'success', true],
    ['success', 'failure', false],
    ['failure', 'success', false],
  ] as Array<[string, string, boolean]>) {
    const both = new Fake({
      trees: { [BASE_A]: tree([CI, E2E]), [HEAD]: tree([CI, E2E]) },
      runs: { [HEAD]: [run(1, CI), run(2, E2E)] },
    })
    both.jobs[1] = { 1: [job('ci', 'completed', ciJob)] }
    both.jobs[2] = { 1: [job('e2e', 'completed', e2eJob)] }
    assert.equal((await evaluateFake(both)).toMerge.length === 1, expected, `${ciJob}/${e2eJob}`)
  }
})

test('retained event shapes prioritize their named PR and scan eligible page-two PRs exactly once', async () => {
  for (const [payload, expected] of [
    [{ inputs: { pr: '1000' } }, [1000, 7]],
    [{ pull_request: { number: 1000 } }, [1000, 7]],
    [{ workflow_run: { pull_requests: [{ number: 1000 }] } }, [1000, 7]],
    [{ inputs: { pr: '' } }, [7, 1000]],
  ] as Array<[EventPayload, number[]]>) {
    const fake = new Fake({
      trees: {
        [BASE_A]: tree(undefined, false),
        [HEAD]: tree(undefined, false),
        [OTHER]: tree(undefined, false),
      },
      prs: {},
      checks: { [HEAD]: [], [OTHER]: [] },
      statuses: {
        [HEAD]: { total_count: 0, state: 'success' },
        [OTHER]: { total_count: 0, state: 'success' },
      },
      runs: { [HEAD]: [], [OTHER]: [] },
    })
    fake.prs[7] = fake.pr(7, HEAD)
    for (let number = 100; number < 199; number++) {
      fake.prs[number] = { ...fake.pr(number, HEAD), labels: [] }
      fake.comments[number] = []
    }
    fake.prs[1000] = fake.pr(1000, OTHER)
    fake.checks[HEAD] = fake.greenChecks()
    fake.checks[OTHER] = fake.greenChecks()
    const result = await evaluate({ github: fake.github, repo, payload, core: core(), policy })
    const numbers = result.toMerge.map((entry) => entry.number)
    assert.deepEqual(numbers, expected)
    assert.equal(new Set(numbers).size, 2)
  }
})

test('canonical dispatch priorities lead once; absent and invalid strings scan every eligible PR', async () => {
  const fixture = () => {
    const fake = pair()
    delete fake.prs[7]
    fake.prs[1000] = fake.pr(1000, OTHER)
    return fake
  }
  const assess = async (payload: EventPayload) => {
    const fake = fixture()
    const reporter = core()
    const result = await evaluate({ github: fake.github, repo, payload, core: reporter, policy })
    return { fake, reporter, result }
  }

  const priority = await assess({ inputs: { pr: '1000' } })
  assert.deepEqual(
    priority.result.toMerge.map((candidate) => candidate.number),
    [1000, 8],
  )
  assert.deepEqual(priority.result.unreadable, [])
  assert.deepEqual(
    priority.fake.calls.filter((call) => call.startsWith('pulls.get:')),
    ['pulls.get:1000', 'pulls.get:1000', 'pulls.get:8', 'pulls.get:8'],
  )

  for (const payload of [{}, { inputs: { pr: '' } }]) {
    const ordinary = await assess(payload)
    assert.deepEqual(
      ordinary.result.toMerge.map((candidate) => candidate.number),
      [8, 1000],
    )
    assert.deepEqual(ordinary.result.unreadable, [])
  }

  for (const input of [
    '7x',
    '07',
    ' 7',
    '+7',
    '7e3',
    '0',
    '-7',
    '9007199254740992',
    'not-a-pr',
    '7\r\n::error::forged',
  ]) {
    const invalid = await assess({ inputs: { pr: input } })
    assert.deepEqual(
      invalid.result.toMerge.map((candidate) => candidate.number),
      [8, 1000],
      input,
    )
    assert.deepEqual(invalid.result.unreadable, [], input)
    assert.deepEqual(
      invalid.fake.calls.filter((call) => call.startsWith('pulls.get:')),
      ['pulls.get:8', 'pulls.get:8', 'pulls.get:1000', 'pulls.get:1000'],
      input,
    )
    const diagnostics = [...invalid.reporter.warnings, ...invalid.reporter.notices]
    assert.ok(
      diagnostics.some((line) => /invalid|dispatch|priority/i.test(line)),
      input,
    )
    assert.ok(
      diagnostics.some((line) => line.includes(JSON.stringify(input))),
      input,
    )
    assert.ok(
      diagnostics.every((line) => !/[\r\n]/.test(line)),
      input,
    )
  }
})

test('check names with CRLF are escaped in both evaluate and land decision logs', async () => {
  const fake = new Fake()
  const selected = await evaluateFake(fake)
  fake.checks[HEAD] = [
    ...fake.greenChecks(),
    { name: 'lint\r\n::error::forged', status: 'in_progress', conclusion: null },
  ]
  const evaluated = core()
  await evaluate({
    github: fake.github,
    repo,
    payload: { inputs: { pr: '7' } },
    core: evaluated,
    policy,
  })
  const landed = core()
  await land({
    github: fake.github,
    merger: fake.merger,
    repo,
    queue: selected.toMerge,
    policy,
    core: landed,
  })
  for (const output of [evaluated, landed]) {
    assert.ok(output.lines.some((line) => line.includes('lint\\r\\n::error::forged')))
    assert.ok(output.lines.every((line) => !/[\r\n]/.test(line)))
  }
  assert.deepEqual(fake.merges, [])
})

test('land rechecks draft, closed, retargeted, conflicted and still-computing candidates without starving the next', async () => {
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: () => void) =>
    realTimeout(callback, 0)) as unknown as typeof setTimeout
  try {
    for (const change of [
      { draft: true },
      { state: 'closed' },
      { base: { ref: 'feature', sha: STALE_BASE } },
      { mergeable: false },
      { mergeable: null },
    ]) {
      const fake = pair()
      fake.branches.feature = BASE_A
      const selected = await evaluateFake(fake)
      assert.equal(selected.toMerge.length, 2)
      Object.assign(fake.prs[7], change)
      const landed = await landFake(fake, selected.toMerge)
      assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }], JSON.stringify(change))
      assert.deepEqual(landed.unreadable, [], JSON.stringify(change))
      assert.deepEqual(landed.stale, [], JSON.stringify(change))
    }
  } finally {
    globalThis.setTimeout = realTimeout
  }
})
test('land refuses a missing, empty or malformed queued head pin while the next candidate merges', async () => {
  for (const pin of [undefined, '', 'bad']) {
    const fake = pair()
    const selected = await evaluateFake(fake)
    const landed = await landFake(fake, [{ ...selected.toMerge[0], sha: pin }, selected.toMerge[1]])
    assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }], String(pin))
    assert.equal(landed.unreadable.length, 1, String(pin))
    assert.deepEqual(landed.stale, [], String(pin))
  }
})
test('invalid JSON object workflow entries produce a structured Product hold', async () => {
  const api = {
    resolveCommit: async (ref: string) => ref,
    readFiles: async () => ['{}', '{"workflows":[{"toString":1}]}'],
    listWorkflowRuns: async () => [],
    listJobs: async () => [],
    getWorkflowRun: async () => run(1),
  }
  const holds = await productHold(api, { base: BASE_A, head: HEAD })
  assert.equal(holds.length, 2)
})

test('strict commit fixture accepts GitHub raw-SHA and object-SHA response representations', async () => {
  for (const objectResponse of [false, true]) {
    const fake = new Fake()
    fake.commitAsObject = objectResponse
    assert.deepEqual(
      (await evaluateFake(fake)).toMerge.map(({ number, sha }) => ({ number, sha })),
      [{ number: 7, sha: HEAD }],
    )
  }
})

test('deep compound declaration entries remain structured refusals', async () => {
  const deep = `[${'['.repeat(10000)}0${']'.repeat(10000)}]`
  const api = {
    resolveCommit: async (ref: string) => ref,
    readFiles: async () => ['{}', `{"workflows":${deep}}`],
    listWorkflowRuns: async () => [],
    listJobs: async () => [],
    getWorkflowRun: async () => run(1),
  }
  assert.equal((await productHold(api, { base: BASE_A, head: HEAD })).length, 2)
})

test('authorization adapter fences stale work, conflict, reissue and edited records', async () => {
  const { captureAuthorization, readAuthorization, issueAuthorization, withdrawAuthorization } =
    require('./lib/head-authorization.cjs')
  const { render } = require('./lib/head-authorization-core.cjs')
  const policy = { repositoryId: 1, operatorIds: [10], appId: 20, botUserId: 21 }
  const snapshot = {
    repositoryId: 1,
    pullRequestId: 2,
    pullRequest: 7,
    headSha: HEAD,
    baseRef: 'main',
    baseSha: BASE_A,
    authorId: 10,
  }
  const comments: Array<{
    id: number
    node_id: string
    body: string
    user: { id: number; type: string }
    performed_via_github_app: null
  }> = []
  const edited = new Set<number>()
  let failPage = false
  for (let id = 1; id <= 110; id++)
    comments.push({
      id,
      node_id: `node${id}`,
      body: 'ordinary',
      user: { id: 10, type: 'User' },
      performed_via_github_app: null,
    })
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { id: 1 } }),
        getCommit: async () => ({ data: snapshot.baseSha }),
      },
      pulls: {
        get: async () => ({
          data: {
            id: 2,
            number: 7,
            head: { sha: snapshot.headSha },
            base: { ref: snapshot.baseRef, sha: snapshot.baseSha },
            user: { id: snapshot.authorId },
          },
        }),
      },
      issues: {
        listComments: async ({ page }: { page: number }) => {
          if (failPage && page === 2) throw new Error('page two unavailable')
          const data = comments.slice((page - 1) * 100, page * 100)
          const link =
            page * 100 < comments.length
              ? `<https://api.github.com/comments?page=${page + 1}>; rel="next"`
              : ''
          return { data, headers: { link } }
        },
      },
    },
    graphql: async (_query: string, { ids }: { ids: string[] }) => ({
      nodes: ids.map((id: string) => {
        const comment = comments.find((c) => c.node_id === id)!
        return {
          __typename: 'IssueComment',
          id,
          fullDatabaseId: String(comment.id),
          lastEditedAt: edited.has(comment.id) ? '2026-01-01' : null,
          repository: { fullDatabaseId: '1' },
          pullRequest: { fullDatabaseId: '2', number: 7 },
        }
      }),
    }),
  }
  const writer = {
    rest: {
      issues: {
        createComment: async ({ body }: { body: string }) => {
          const id = comments.length + 1
          comments.push({
            id,
            node_id: `node${id}`,
            body,
            user: { id: 10, type: 'User' },
            performed_via_github_app: null,
          })
        },
      },
    },
  }
  const input = { github, repo, prNumber: 7, policy }
  const captured = await captureAuthorization(input)
  const grant = (operationId: string, previous = captured) =>
    issueAuthorization({
      github,
      writer,
      repo,
      snapshot: previous,
      policy,
      lane: 'reviewed',
      source: 'manual',
      evidence: 'review',
      operationId,
    })
  const first = await grant('first')
  assert.equal((await readAuthorization(input)).allowed, true)
  failPage = true
  await assert.rejects(readAuthorization(input))
  failPage = false
  snapshot.headSha = OTHER
  assert.equal((await readAuthorization(input)).allowed, false)
  snapshot.headSha = HEAD
  await withdrawAuthorization({ ...input, writer, operationId: 'withdraw', reason: 'stop' })
  await assert.rejects(grant('late'))
  const staleRecord = { ...JSON.parse(first.body.split('\n')[1]), operationId: 'crossing' }
  await writer.rest.issues.createComment({ body: render(staleRecord) })
  assert.equal((await readAuthorization(input)).allowed, false)
  const newSnapshot = await captureAuthorization(input)
  await grant('reissue', newSnapshot)
  assert.equal((await readAuthorization(input)).allowed, true)
  const latest = comments.at(-1)!
  edited.add(latest.id)
  assert.equal((await readAuthorization(input)).allowed, false)
  edited.clear()
  const conflicting = {
    ...JSON.parse(latest.body.split('\n')[1]),
    operationId: 'conflict',
    previous: newSnapshot.previous,
  }
  await writer.rest.issues.createComment({ body: render(conflicting) })
  assert.equal((await readAuthorization(input)).allowed, false)
  await grant('recover', await captureAuthorization(input))
  assert.equal((await readAuthorization(input)).allowed, true)
  const untrustedId = comments.length + 1
  comments.push({
    id: untrustedId,
    node_id: `node${untrustedId}`,
    body: first.body,
    user: { id: 999, type: 'User' },
    performed_via_github_app: null,
  })
  assert.equal((await readAuthorization(input)).allowed, true)
  await writer.rest.issues.createComment({ body: '<!-- kit-head-authorization:v1 -->\n{}' })
  assert.equal((await readAuthorization(input)).allowed, false)
  await grant('after-malformed', await captureAuthorization(input))
  assert.equal((await readAuthorization(input)).allowed, true)
})

test('writer receipts authorize both lanes without labels and bind the machine baseline', async () => {
  for (const lane of ['reviewed', 'dependabot'] as const) {
    const fake = new Fake()
    fake.comments[7] = []
    fake.prs[7].labels = []
    if (lane === 'dependabot') {
      fake.prs[7].user = { id: 49699333, login: 'dependabot[bot]' }
      fake.writerIdentity = 'machine'
    }
    const input = { github: fake.github, repo, prNumber: 7, policy }
    const snapshot = await captureAuthorization(input)
    const receipt = await issueAuthorization({
      ...input,
      writer: fake.writer,
      snapshot,
      lane,
      source: lane === 'reviewed' ? 'manual' : 'dependabot',
      operationId: `positive-${lane}`,
      evidence: 'admission',
    })
    assert.ok(receipt)
    const selected = await evaluateFake(fake)
    assert.equal(selected.toMerge.length, 1)
    assert.equal(selected.toMerge[0].receipt.id, receipt.id)
    assert.equal(selected.toMerge[0].receipt.body, receipt.body)
    await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [{ number: 7, sha: HEAD }])
  }
  for (const lane of ['reviewed', 'dependabot'] as const) {
    const fake = new Fake()
    fake.comments[7] = []
    if (lane === 'dependabot') {
      fake.prs[7].user = { id: 49699333, login: 'dependabot[bot]' }
      fake.writerIdentity = 'machine'
    }
    const input = { github: fake.github, repo, prNumber: 7, policy }
    const snapshot = await captureAuthorization(input)
    await issueAuthorization({
      ...input,
      writer: fake.writer,
      snapshot,
      lane,
      source: lane === 'reviewed' ? 'manual' : 'dependabot',
      operationId: `base-${lane}`,
      evidence: 'admission',
    })
    fake.branches.main = BASE_B
    fake.trees[BASE_B] = tree(undefined, false)
    assert.equal((await evaluateFake(fake)).toMerge.length, lane === 'reviewed' ? 1 : 0)
  }
})

test('stale labels and failed withdrawal cannot authorize a changed head', async () => {
  const fake = new Fake()
  fake.prs[7].head.sha = OTHER
  fake.trees[OTHER] = tree(undefined, false)
  fake.checks[OTHER] = fake.greenChecks()
  fake.statuses[OTHER] = { total_count: 0, state: 'success' }
  fake.errors['write:7'] = 403
  await assert.rejects(
    withdrawAuthorization({
      github: fake.github,
      writer: fake.writer,
      repo,
      prNumber: 7,
      policy,
      operationId: 'failed-withdraw',
      reason: 'push',
    }),
  )
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  fake.comments[7] = []
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
})

test('current malformed, foreign and edited authenticated records cannot authorize', async () => {
  type AuthorizationRecord = Parameters<typeof render>[0]
  for (const change of [
    (record: AuthorizationRecord) => {
      record.repositoryId = 99
    },
    (record: AuthorizationRecord) => {
      record.pullRequestId = 99
    },
    (record: AuthorizationRecord) => {
      record.pullRequest = 99
    },
    (record: AuthorizationRecord) => {
      record.headSha = OTHER
    },
    (record: AuthorizationRecord) => {
      record.lane = 'dependabot'
      record.source = 'dependabot'
    },
  ]) {
    const fake = new Fake()
    const existing = fake.comments[7][0]
    const record: AuthorizationRecord = JSON.parse(existing.body.slice(PREFIX.length))
    change(record)
    existing.body = render(record)
    assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  }
  for (const variant of ['edited', 'malformed', 'foreign issuer', 'incomplete issuer'] as const) {
    const fake = new Fake()
    const comment = fake.comments[7][0]
    if (variant === 'edited') fake.edited.add(comment.id)
    if (variant === 'malformed') comment.body = `${PREFIX}{}`
    if (variant === 'foreign issuer') comment.user.id = 999
    if (variant === 'incomplete issuer') Reflect.deleteProperty(comment, 'performed_via_github_app')
    const result = await evaluateFake(fake)
    assert.deepEqual(result.toMerge, [], variant)
  }
})

test('withdrawal or replacement after evaluation holds only that candidate', async () => {
  for (const replacement of [false, true]) {
    const fake = pair()
    const selected = await evaluateFake(fake)
    const input = { github: fake.github, repo, prNumber: 7, policy }
    if (replacement) {
      const snapshot = await captureAuthorization(input)
      await issueAuthorization({
        ...input,
        writer: fake.writer,
        snapshot,
        lane: 'reviewed',
        source: 'manual',
        evidence: 'new review',
        operationId: 'replacement',
      })
    } else {
      await withdrawAuthorization({
        ...input,
        writer: fake.writer,
        operationId: 'withdraw-final',
        reason: 'stop',
      })
    }
    await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }])
  }
})

test('comment preflight validates the freshly fetched issuer and PR association', async () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: { preflight: { steps: Step[] } }
  }
  const source = workflow.jobs.preflight.steps.find((step) => step.id === 'validate')?.with?.script
  assert.ok(source)
  const execute = new AsyncFunction('github', 'context', 'core', 'require', source)
  for (const variant of ['valid', 'foreign', 'wrong issue', 'ordinary', 'not PR'] as const) {
    const fake = new Fake()
    const comment = {
      ...fake.comments[7][0],
      issue_url: 'https://api.github.com/repos/kit/fixture/issues/7',
    }
    if (variant === 'foreign') comment.user = { id: 999, type: 'User' }
    if (variant === 'wrong issue')
      comment.issue_url = 'https://api.github.com/repos/kit/fixture/issues/8'
    if (variant === 'ordinary') comment.body = 'ordinary'
    const outputs: Record<string, string> = {}
    const github = {
      rest: {
        issues: { getComment: async () => ({ data: comment }) },
        pulls: fake.github.rest.pulls,
      },
    }
    await execute(
      github,
      {
        eventName: 'issue_comment',
        repo,
        payload: {
          issue: {
            number: 7,
            url: 'https://api.github.com/repos/kit/fixture/issues/7',
            ...(variant === 'not PR' ? {} : { pull_request: { url: 'pr' } }),
          },
          comment: { id: comment.id },
        },
      },
      {
        setOutput: (key: string, value: string) => {
          outputs[key] = value
        },
      },
      (id: string) => require(join(ROOT, id)),
    )
    assert.equal(outputs.eligible === 'true', variant === 'valid', variant)
  }
})

test('later comment pages include withdrawal and page failure cannot fall back to an old grant', async () => {
  const fake = new Fake()
  for (let i = 0; i < 105; i++) fake.addComment(7, 'ordinary')
  const input = { github: fake.github, repo, prNumber: 7, policy }
  await withdrawAuthorization({
    ...input,
    writer: fake.writer,
    operationId: 'paged-withdraw',
    reason: 'stop',
  })
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  fake.errors['comments:7:2'] = 502
  const result = await evaluateFake(fake)
  assert.deepEqual(result.toMerge, [])
  assert.equal(result.unreadable.length, 1)
})

test('concurrent captured grants conflict until a fresh explicit reissue', async () => {
  const fake = new Fake()
  const input = { github: fake.github, repo, prNumber: 7, policy }
  const snapshot = await captureAuthorization(input)
  const { promise: bothPosted, resolve: release } = Promise.withResolvers<void>()
  let writes = 0
  const writer = {
    rest: {
      issues: {
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
          if (++writes === 2) release()
          await bothPosted
          const comment = fake.addComment(issue_number, body)
          return { data: comment }
        },
      },
    },
  }
  await Promise.allSettled(
    ['concurrent-one', 'concurrent-two'].map((operationId) =>
      issueAuthorization({
        ...input,
        writer,
        snapshot,
        lane: 'reviewed',
        source: 'manual',
        evidence: 'review',
        operationId,
      }),
    ),
  )
  assert.equal((await readAuthorization(input)).allowed, false)
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  const fresh = await captureAuthorization(input)
  await issueAuthorization({
    ...input,
    writer: fake.writer,
    snapshot: fresh,
    lane: 'reviewed',
    source: 'manual',
    evidence: 'new admission',
    operationId: 'explicit-reissue',
  })
  const selected = await evaluateFake(fake)
  assert.equal(selected.toMerge.length, 1)
  await landFake(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [{ number: 7, sha: HEAD }])
})

test('incomplete and inconsistent GraphQL proof cannot authorize', async () => {
  for (const variant of ['missing', 'repository', 'pull request', 'number', 'node'] as const) {
    const fake = new Fake()
    const original = fake.github.graphql
    fake.github.graphql = async (query, variables) => {
      const result = await original(query, variables)
      const node = result.nodes[0]
      if (variant === 'missing') {
        result.nodes[0] = null
        return result
      }
      assert.ok(node)
      switch (variant) {
        case 'repository':
          node.repository.fullDatabaseId = '999'
          break
        case 'pull request':
          node.pullRequest.fullDatabaseId = '999'
          break
        case 'number':
          node.pullRequest.number = 99
          break
        case 'node':
          node.id = 'other'
          break
      }
      return result
    }
    const result = await evaluateFake(fake)
    assert.deepEqual(result.toMerge, [], variant)
    assert.equal(result.unreadable.length, 1, variant)
  }
})

test('ambiguous comment ordering and forged machine issuer fail closed', async () => {
  for (const variant of [
    'duplicate id',
    'unsafe id',
    'wrong app',
    'wrong bot',
    'wrong author',
  ] as const) {
    const fake = new Fake()
    fake.comments[7] = []
    fake.prs[7].user = { login: 'dependabot[bot]', id: 49699333 }
    fake.writerIdentity = 'machine'
    const input = { github: fake.github, repo, prNumber: 7, policy }
    const snapshot = await captureAuthorization(input)
    await issueAuthorization({
      ...input,
      writer: fake.writer,
      snapshot,
      lane: 'dependabot',
      source: 'dependabot',
      evidence: 'guard',
      operationId: 'machine-identity',
    })
    const comment = fake.comments[7][0]
    if (variant === 'duplicate id') fake.comments[7].push({ ...comment })
    if (variant === 'unsafe id') comment.id = Number.MAX_SAFE_INTEGER + 1
    if (variant === 'wrong app') comment.performed_via_github_app = { id: 999 }
    if (variant === 'wrong bot') comment.user.id = 999
    if (variant === 'wrong author') fake.prs[7].user.id = 999
    assert.deepEqual((await evaluateFake(fake)).toMerge, [], variant)
  }
})

test('replayed operation IDs hold grants and withdrawals until a fresh issuance', async () => {
  for (const kind of ['grant', 'withdraw'] as const) {
    const fake = new Fake()
    const input = { github: fake.github, repo, prNumber: 7, policy }
    const first = fake.comments[7][0]
    const record = JSON.parse(first.body.slice(PREFIX.length))
    const withdrawal = await withdrawAuthorization({
      ...input,
      writer: fake.writer,
      operationId: 'intervening-withdrawal',
      reason: 'stop',
    })
    assert.ok(withdrawal)
    if (kind === 'withdraw') {
      record.kind = 'withdraw'
      record.lane = 'all'
      record.source = 'revoke'
    }
    record.previous = withdrawal.id
    fake.addComment(7, render(record))
    const state = await readAuthorization(input)
    assert.equal(state.allowed, false, kind)
    const held = await evaluateFake(fake)
    assert.deepEqual(held.toMerge, [], kind)
    await landFake(fake, held.toMerge)
    assert.deepEqual(fake.merges, [], kind)
    const snapshot = await captureAuthorization(input)
    await issueAuthorization({
      ...input,
      writer: fake.writer,
      snapshot,
      lane: 'reviewed',
      source: 'manual',
      operationId: `fresh-${kind}`,
      evidence: 'new admission',
    })
    const selected = await evaluateFake(fake)
    assert.equal(selected.toMerge.length, 1, kind)
    await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [{ number: 7, sha: HEAD }], kind)
  }
})

const DEPS_WORKFLOW = join(ROOT, '.github/workflows/dependabot-automerge.yml')
const EMPTY_AUTH = {
  CI_APP_ID: '',
  HEAD_AUTH_REPOSITORY_ID: '',
  HEAD_AUTH_OPERATOR_IDS: '',
  HEAD_AUTH_APP_ID: '',
  HEAD_AUTH_BOT_USER_ID: '',
}
const VALID_POLICY = {
  CI_APP_ID: '',
  HEAD_AUTH_REPOSITORY_ID: '1',
  HEAD_AUTH_OPERATOR_IDS: '[10]',
  HEAD_AUTH_APP_ID: '20',
  HEAD_AUTH_BOT_USER_ID: '21',
}
type GateStep = Step & { if?: string; uses?: string }
type ExprNode = string | { [key: string]: ExprNode }

function workflowJobs(file: string) {
  return (
    Bun.YAML.parse(readFileSync(file, 'utf8')) as {
      jobs: Record<string, { if?: string; steps: GateStep[] }>
    }
  ).jobs
}
function exprDictionary(value: { [key: string]: ExprNode }): data.Dictionary {
  return new data.Dictionary(
    ...Object.entries(value).map(([key, item]): { key: string; value: data.ExpressionData } => ({
      key,
      value: typeof item === 'string' ? new data.StringData(item) : exprDictionary(item),
    })),
  )
}
function guardOpen(expression: string | undefined, context: { [key: string]: ExprNode }) {
  if (!expression?.trim()) return true
  const body = expression
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
  const names = ['cancelled', 'success', 'always']
  const parsed = new Parser(
    new Lexer(body).lex().tokens,
    ['github', 'needs', 'steps', 'vars'],
    names.map((name) => ({ name, minArgs: 0, maxArgs: 0 })),
  ).parse()
  const evaluated = new Evaluator(
    parsed,
    exprDictionary(context),
    new Map(
      names.map((name) => [
        name,
        { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(name !== 'cancelled') },
      ]),
    ),
  ).evaluate()
  return evaluated.coerceString() === 'true'
}
function prComment() {
  const fake = new Fake()
  const comment = {
    ...fake.comments[7][0],
    issue_url: 'https://api.github.com/repos/kit/fixture/issues/7',
  }
  const reads: string[] = []
  return {
    reads,
    payload: {
      issue: { number: 7, url: comment.issue_url, pull_request: { url: 'pr' } },
      comment: { id: comment.id },
    },
    github: {
      rest: {
        issues: {
          getComment: async () => {
            reads.push('getComment')
            return { data: comment }
          },
        },
        pulls: {
          get: async () => {
            reads.push('pulls.get')
            return { data: structuredClone(fake.prs[7]) }
          },
        },
      },
    },
  }
}
async function runShipped(
  source: string,
  env: Record<string, string>,
  input: {
    eventName: string
    payload: Record<string, unknown>
    github?: unknown
    load?: (id: string) => unknown
  },
) {
  const outputs: Record<string, string> = {}
  const execute = new AsyncFunction(
    'github',
    'context',
    'core',
    'require',
    'getOctokit',
    'process',
    source,
  )
  await execute(
    input.github ?? {
      rest: {
        issues: {
          getComment: async () => {
            throw new Error('unprivileged read')
          },
        },
        pulls: {
          get: async () => {
            throw new Error('unprivileged read')
          },
        },
      },
    },
    { eventName: input.eventName, repo, runId: 99, payload: input.payload },
    {
      ...core(),
      setOutput: (name: string, value: string) => {
        outputs[name] = value
      },
      setFailed: (message: string) => {
        throw new Error(message)
      },
    },
    input.load ?? ((id: string) => require(join(ROOT, id))),
    () => {
      throw new Error('token mint')
    },
    { env },
  )
  return { outputs }
}

test('unprivileged pull_request preflight does not require the default-branch adapter', async () => {
  const source = workflowJobs(WORKFLOW).preflight.steps.find((step) => step.id === 'validate')?.with
    ?.script
  assert.ok(source)
  const result = await runShipped(
    source,
    { ...VALID_POLICY, CI_APP_ID: '12345' },
    {
      eventName: 'pull_request',
      payload: {},
      load: () => {
        throw new Error('default-branch adapter required')
      },
    },
  )
  assert.equal(result.outputs.eligible, undefined)
})

test('inactive workflow_run, revoke, comments, and Dependabot capture do not mint or write', async () => {
  const merge = workflowJobs(WORKFLOW)
  const validate = merge.preflight.steps.find((step) => step.id === 'validate')?.with?.script
  assert.ok(validate)
  const workflowRun = await runShipped(validate, EMPTY_AUTH, {
    eventName: 'workflow_run',
    payload: {},
  })
  assert.equal(workflowRun.outputs.eligible, 'true')
  assert.equal(workflowRun.outputs.enabled, 'false')
  const mergeJob = merge['merge-on-green']
  const skipped = {
    github: { event_name: 'workflow_run' },
    needs: { preflight: { outputs: workflowRun.outputs } },
    steps: {
      app: { outcome: 'skipped' },
      evaluate: { outputs: { to_merge: '', unreadable: '' } },
      merge: { outputs: { unreadable: '' } },
    },
  }
  assert.equal(guardOpen(mergeJob.steps.find((step) => step.id === 'evaluate')?.if, skipped), false)
  assert.equal(
    guardOpen(
      mergeJob.steps.find((step) => step.uses?.includes('create-github-app-token'))?.if,
      skipped,
    ),
    false,
  )
  assert.equal(guardOpen(mergeJob.steps.find((step) => step.id === 'merge')?.if, skipped), false)
  assert.equal(
    guardOpen(
      mergeJob.steps.find((step) => step.name === 'Fail on unreadable merge gate')?.if,
      skipped,
    ),
    false,
  )
  const revoke = await runShipped(validate, EMPTY_AUTH, {
    eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: { number: 7, user: { id: 10 } } },
  })
  for (const step of merge['revoke-reviewed-on-push'].steps) {
    if (step.uses?.includes('create-github-app-token') || step.with?.script) {
      assert.equal(guardOpen(step.if, { needs: { preflight: { outputs: revoke.outputs } } }), false)
    }
  }
  const wake = prComment()
  const commented = await runShipped(validate, EMPTY_AUTH, {
    eventName: 'issue_comment',
    payload: wake.payload,
    github: wake.github,
  })
  assert.notEqual(commented.outputs.eligible, 'true')
  assert.deepEqual(wake.reads, [])
  const deps = workflowJobs(DEPS_WORKFLOW)
  const captureSource = deps.capture.steps.find((step) => step.id === 'cfg')?.with?.script
  assert.ok(captureSource)
  const capture = await runShipped(captureSource, EMPTY_AUTH, {
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 7, user: { id: 49699333 } } },
  })
  const depsContext = {
    needs: {
      capture: { result: 'success', outputs: capture.outputs },
      evaluate: { result: 'skipped' },
    },
    steps: { cfg: { outputs: capture.outputs } },
  }
  assert.equal(
    guardOpen(deps.capture.steps.find((step) => step.id === 'app')?.if, depsContext),
    false,
  )
  assert.equal(
    guardOpen(deps.capture.steps.find((step) => step.id === 'capture')?.if, depsContext),
    false,
  )
  assert.equal(guardOpen(deps.evaluate.if, depsContext), false)
  assert.equal(guardOpen(deps.publish.if, depsContext), false)
})

test('valid policy with the App disabled queues a receipt and stays red when Evaluate is unreadable', async () => {
  const merge = workflowJobs(WORKFLOW)
  const validate = merge.preflight.steps.find((step) => step.id === 'validate')?.with?.script
  const evaluateStep = merge['merge-on-green'].steps.find((step) => step.id === 'evaluate')
  const evaluateScript = evaluateStep?.with?.script
  const failStep = merge['merge-on-green'].steps.find(
    (step) => step.name === 'Fail on unreadable merge gate',
  )
  assert.ok(validate)
  assert.ok(evaluateScript)
  assert.ok(failStep?.if)
  const classified = await runShipped(validate, VALID_POLICY, {
    eventName: 'workflow_run',
    payload: {},
  })
  assert.equal(classified.outputs.eligible, 'true')
  assert.equal(
    guardOpen(evaluateStep.if, { needs: { preflight: { outputs: classified.outputs } } }),
    true,
  )
  const fake = new Fake()
  const selected = await runShipped(evaluateScript, VALID_POLICY, {
    eventName: 'workflow_run',
    payload: { inputs: { pr: '7' } },
    github: fake.github,
  })
  const queue = JSON.parse(selected.outputs.to_merge) as Queue[]
  assert.equal(queue.length, 1)
  assert.equal(queue[0].number, 7)
  assert.equal(queue[0].sha, HEAD)
  assert.equal(queue[0].receipt.id, fake.comments[7][0].id)
  assert.equal(queue[0].receipt.body, fake.comments[7][0].body)
  assert.deepEqual(JSON.parse(selected.outputs.unreadable), [])
  assert.equal(classified.outputs.enabled, 'false')
  const held = {
    needs: { preflight: { outputs: classified.outputs } },
    github: { event_name: 'workflow_run' },
    steps: {
      app: { outcome: 'skipped' },
      evaluate: {
        outputs: { to_merge: selected.outputs.to_merge, unreadable: selected.outputs.unreadable },
      },
      merge: { outputs: { unreadable: '' } },
    },
  }
  assert.equal(
    guardOpen(
      merge['merge-on-green'].steps.find((step) => step.uses?.includes('create-github-app-token'))
        ?.if,
      held,
    ),
    false,
  )
  assert.equal(
    guardOpen(merge['merge-on-green'].steps.find((step) => step.id === 'merge')?.if, held),
    false,
  )
  assert.equal(guardOpen(failStep.if, held), false)
  const blocked = new Fake()
  blocked.errors['pulls.get:7'] = 502
  const unreadable = await runShipped(evaluateScript, VALID_POLICY, {
    eventName: 'workflow_run',
    payload: { inputs: { pr: '7' } },
    github: blocked.github,
  })
  const heldOpen = JSON.parse(unreadable.outputs.unreadable) as string[]
  assert.equal(
    guardOpen(failStep.if, {
      steps: {
        evaluate: { outputs: { unreadable: unreadable.outputs.unreadable } },
        merge: { outputs: { unreadable: '' } },
      },
    }),
    true,
  )
  assert.notEqual(runFinalStep(heldOpen, '[]').exitCode, 0)
  for (const step of merge['revoke-reviewed-on-push'].steps) {
    if (step.uses?.includes('create-github-app-token') || step.with?.script) {
      assert.equal(
        guardOpen(step.if, { needs: { preflight: { outputs: classified.outputs } } }),
        false,
      )
    }
  }
  const wake = prComment()
  const admitted = await runShipped(validate, VALID_POLICY, {
    eventName: 'issue_comment',
    payload: wake.payload,
    github: wake.github,
  })
  assert.equal(admitted.outputs.eligible, 'true')
  const deps = workflowJobs(DEPS_WORKFLOW)
  const captureSource = deps.capture.steps.find((step) => step.id === 'cfg')?.with?.script
  assert.ok(captureSource)
  const capture = await runShipped(captureSource, VALID_POLICY, {
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 7 } },
  })
  const depsContext = {
    needs: {
      capture: { result: 'success', outputs: capture.outputs },
      evaluate: { result: 'skipped' },
    },
    steps: { cfg: { outputs: capture.outputs } },
  }
  assert.equal(
    guardOpen(deps.capture.steps.find((step) => step.id === 'app')?.if, depsContext),
    false,
  )
  assert.equal(
    guardOpen(deps.capture.steps.find((step) => step.id === 'capture')?.if, depsContext),
    false,
  )
  assert.equal(guardOpen(deps.evaluate.if, depsContext), false)
  assert.equal(guardOpen(deps.publish.if, depsContext), false)
})

test('partial, malformed, and App-without-policy reject while an active App still schedules mint', async () => {
  const validate = workflowJobs(WORKFLOW).preflight.steps.find((step) => step.id === 'validate')
    ?.with?.script
  const capture = workflowJobs(DEPS_WORKFLOW).capture.steps.find((step) => step.id === 'cfg')?.with
    ?.script
  assert.ok(validate)
  assert.ok(capture)
  const wake = prComment()
  await assert.rejects(() =>
    runShipped(
      validate,
      { ...EMPTY_AUTH, HEAD_AUTH_OPERATOR_IDS: '[10]' },
      {
        eventName: 'workflow_run',
        payload: {},
      },
    ),
  )
  await assert.rejects(() =>
    runShipped(
      validate,
      { ...EMPTY_AUTH, HEAD_AUTH_OPERATOR_IDS: 'not-json' },
      {
        eventName: 'pull_request_target',
        payload: {},
      },
    ),
  )
  await assert.rejects(() =>
    runShipped(
      validate,
      { ...EMPTY_AUTH, CI_APP_ID: '12345' },
      {
        eventName: 'issue_comment',
        payload: wake.payload,
        github: wake.github,
      },
    ),
  )
  await assert.rejects(() =>
    runShipped(
      capture,
      { ...EMPTY_AUTH, HEAD_AUTH_APP_ID: '20' },
      {
        eventName: 'pull_request_target',
        payload: { pull_request: { number: 7 } },
      },
    ),
  )
  await assert.rejects(() =>
    runShipped(
      capture,
      { ...EMPTY_AUTH, CI_APP_ID: '12345' },
      {
        eventName: 'pull_request_target',
        payload: { pull_request: { number: 7 } },
      },
    ),
  )
  const active = await runShipped(
    validate,
    { ...VALID_POLICY, CI_APP_ID: '12345' },
    {
      eventName: 'workflow_run',
      payload: {},
    },
  )
  assert.equal(
    guardOpen(
      workflowJobs(WORKFLOW)['merge-on-green'].steps.find((step) =>
        step.uses?.includes('create-github-app-token'),
      )?.if,
      {
        github: { event_name: 'workflow_dispatch' },
        needs: { preflight: { outputs: active.outputs } },
        steps: { evaluate: { outputs: { to_merge: '[]' } } },
      },
    ),
    true,
  )
  assert.equal(active.outputs.enabled, 'true')
  const mint = workflowJobs(WORKFLOW)['merge-on-green'].steps.find((step) => step.id === 'app')?.if
  for (const [queue, expected] of [
    ['[]', false],
    ['', false],
    ['[{"number":7}]', true],
  ] as const) {
    assert.equal(
      guardOpen(mint, {
        github: { event_name: 'workflow_run' },
        needs: { preflight: { outputs: active.outputs } },
        steps: { evaluate: { outputs: { to_merge: queue } } },
      }),
      expected,
    )
  }
  assert.equal(
    guardOpen(
      workflowJobs(WORKFLOW)['revoke-reviewed-on-push'].steps.find((step) =>
        step.uses?.includes('create-github-app-token'),
      )?.if,
      { needs: { preflight: { outputs: active.outputs } } },
    ),
    true,
  )
  const depsReady = await runShipped(
    capture,
    { ...VALID_POLICY, CI_APP_ID: '12345' },
    {
      eventName: 'pull_request_target',
      payload: { pull_request: { number: 7 } },
    },
  )
  assert.equal(
    guardOpen(workflowJobs(DEPS_WORKFLOW).capture.steps.find((step) => step.id === 'app')?.if, {
      steps: { cfg: { outputs: depsReady.outputs } },
    }),
    true,
  )
})

const actionsCheck = (
  name: string,
  suite: number,
  conclusion: string | null = 'success',
): Check => ({
  id: suite * 1000,
  name,
  status: 'completed',
  conclusion,
  app: { slug: 'github-actions' },
  check_suite: { id: suite },
})
const actionsRun = (id: number, workflow: number, suite: number, attempt = 1): Workflow => ({
  ...run(
    id,
    workflow === 10 ? CI : `.github/workflows/fixture-${workflow}.yml`,
    'completed',
    'success',
    attempt,
  ),
  workflow_id: workflow,
  check_suite_id: suite,
  event: 'pull_request',
  head_branch: 'feature',
  head_repository: { id: 1 },
  pull_requests: [
    {
      id: 1007,
      number: 7,
      head: { ref: 'feature', sha: HEAD, repo: { id: 1 } },
      base: { ref: 'main', sha: BASE_A, repo: { id: 1 } },
    },
  ],
})
const actionsJob = (id: number, name: string, conclusion: string | null = 'success'): Job => ({
  id,
  name,
  status: 'completed',
  conclusion,
})

const freshnessFixture = () => {
  const fake = new Fake()
  fake.checks[HEAD] = [actionsCheck('CI', 11, 'skipped'), ...fake.greenChecks().slice(1)]
  fake.runs[HEAD] = [actionsRun(1, 10, 11), actionsRun(2, 10, 12)]
  fake.jobs[1] = { 1: [actionsJob(11000, 'CI', 'skipped')] }
  fake.jobs[2] = { 1: [actionsJob(12000, 'CI')] }
  return fake
}

test('distinct Actions execution contexts cannot supersede a PR run', async () => {
  for (const variant of [
    'push',
    'pull_request_target',
    'workflow_dispatch',
    'schedule',
    'unknown',
    'branch',
    'repo',
  ]) {
    const fake = freshnessFixture()
    const latest = fake.runs[HEAD][1]
    if (
      ['push', 'pull_request_target', 'workflow_dispatch', 'schedule', 'unknown'].includes(variant)
    )
      latest.event = variant
    if (variant === 'branch') latest.head_branch = 'other'
    if (variant === 'repo') latest.head_repository!.id = 2
    fake.checks[HEAD].push(actionsCheck('CI', 12))
    for (const reverse of [false, true]) {
      if (reverse) {
        fake.checks[HEAD][0].conclusion = 'success'
        fake.checks[HEAD][2].conclusion = 'skipped'
        fake.jobs[1][1] = [actionsJob(11000, 'CI')]
        fake.jobs[2][1] = [actionsJob(12000, 'CI', 'skipped')]
      }
      const result = await evaluateFake(fake)
      assert.deepEqual(result.toMerge, [], `${variant}/${reverse}`)
      assert.deepEqual(result.unreadable, [], `${variant}/${reverse}`)
    }
  }
})

test('association snapshots are ignored and unique head with unchanged base permits refresh', async () => {
  const fake = freshnessFixture()
  fake.runs[HEAD][0].pull_requests = []
  fake.runs[HEAD][1].pull_requests = []
  assert.equal((await evaluateFake(fake)).toMerge.length, 1)
})

test('another historical PR or a base retarget prevents cross-run replacement', async () => {
  for (const variant of [
    'another-pr',
    'BaseRefChangedEvent',
    'BaseRefDeletedEvent',
    'AutomaticBaseChangeSucceededEvent',
  ]) {
    const fake = freshnessFixture()
    if (variant !== 'another-pr') {
      fake.baseEvents = 1
      fake.baseEventType = variant
    } else {
      fake.prs[8] = fake.pr(8, HEAD)
      fake.prs[8].state = 'closed'
    }
    const result = await evaluateFake(fake)
    assert.deepEqual(result.toMerge, [], variant)
    assert.deepEqual(result.unreadable, [], variant)
  }
})

test('unreadable base history does not fall back to coalescing', async () => {
  const fake = freshnessFixture()
  fake.errors['timeline:7'] = 403
  const result = await evaluateFake(fake)
  assert.deepEqual(result.toMerge, [])
  assert.equal(result.unreadable.length, 1)
})

test('ordinary Actions holds remain readable on evaluation and landing', async () => {
  for (const variant of ['pending', 'red', 'changed']) {
    const fake = freshnessFixture()
    const selected = await evaluateFake(fake)
    if (variant === 'pending') {
      fake.runs[HEAD][1].status = 'queued'
      fake.runs[HEAD][1].conclusion = null
    }
    if (variant === 'red') fake.runs[HEAD][1].conclusion = 'failure'
    if (variant === 'changed')
      fake.afterJobs = () => {
        fake.runs[HEAD][1].run_attempt = 2
      }
    const evaluated = await evaluateFake(fake)
    assert.deepEqual(evaluated.toMerge, [], variant)
    assert.deepEqual(evaluated.unreadable, [], variant)
    if (variant === 'changed') {
      fake.runs[HEAD][1].run_attempt = 1
    }
    const landed = await landFake(fake, selected.toMerge)
    assert.deepEqual(fake.merges, [], variant)
    assert.deepEqual(landed.unreadable, [], variant)
  }
})

test('Actions freshness replaces old suite evidence only with the latest exact attempt', async () => {
  const green = freshnessFixture()
  const selected = await evaluateFake(green)
  assert.equal(selected.toMerge.length, 1)
  await landFake(green, selected.toMerge)
  assert.equal(green.merges.length, 1)
  for (const conclusion of ['skipped', 'neutral', 'failure']) {
    const fake = freshnessFixture()
    fake.checks[HEAD][0].conclusion = 'success'
    fake.jobs[2][1] = [actionsJob(12000, 'CI', conclusion)]
    assert.deepEqual((await evaluateFake(fake)).toMerge, [], conclusion)
  }
  const attempt = freshnessFixture()
  attempt.runs[HEAD][1].run_attempt = 2
  attempt.jobs[2] = { 1: [actionsJob(12000, 'CI')], 2: [actionsJob(12001, 'CI', 'failure')] }
  assert.deepEqual((await evaluateFake(attempt)).toMerge, [])
  attempt.jobs[2][2] = [actionsJob(12001, 'CI')]
  assert.equal((await evaluateFake(attempt)).toMerge.length, 1)
  attempt.afterJobs = () => {
    attempt.runs[HEAD][1].run_attempt = 3
  }
  assert.deepEqual((await evaluateFake(attempt)).toMerge, [])
})

test('Actions incomplete or conflicting freshness proof holds rather than using old green', async () => {
  for (const mutate of [
    (f: Fake) => {
      f.runs[HEAD][1].status = 'queued'
      f.runs[HEAD][1].conclusion = null
    },
    (f: Fake) => {
      f.jobs[2][1] = []
    },
    (f: Fake) => {
      f.jobs[2][1] = [actionsJob(12000, 'other')]
    },
    (f: Fake) => {
      f.checks[HEAD][0].check_suite = undefined
    },
    (f: Fake) => {
      f.checks[HEAD][0].check_suite = { id: 99 }
    },
    (f: Fake) => {
      f.runs[HEAD][1].workflow_id = undefined
    },
    (f: Fake) => {
      f.errors[`runs:${HEAD}`] = 403
    },
  ]) {
    const fake = freshnessFixture()
    fake.checks[HEAD][0].conclusion = 'success'
    mutate(fake)
    assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  }
  const duplicate = freshnessFixture()
  duplicate.checks[HEAD].push(actionsCheck('CI', 21))
  duplicate.runs[HEAD].push(actionsRun(3, 20, 21))
  duplicate.jobs[3] = { 1: [actionsJob(21000, 'CI', 'skipped')] }
  assert.deepEqual((await evaluateFake(duplicate)).toMerge, [])
  const foreign = freshnessFixture()
  foreign.checks[HEAD].push({
    name: 'CI',
    status: 'completed',
    conclusion: 'neutral',
    app: { slug: 'external' },
  })
  assert.deepEqual((await evaluateFake(foreign)).toMerge, [])
})

test('each required alias succeeds while optional neutral and skipped checks remain allowed', async () => {
  for (const name of [
    'CI',
    'validate-full',
    'lint-typecheck-test',
    'Secret scan',
    'TruffleHog (nightly)',
  ]) {
    for (const conclusion of ['skipped', 'neutral']) {
      const fake = new Fake()
      const selected = await evaluateFake(fake)
      fake.checks[HEAD].push({ name, status: 'completed', conclusion })
      assert.deepEqual((await evaluateFake(fake)).toMerge, [])
      await landFake(fake, selected.toMerge)
      assert.deepEqual(fake.merges, [])
    }
  }
  const fake = new Fake()
  fake.checks[HEAD].push({ name: 'optional', status: 'completed', conclusion: 'skipped' })
  assert.equal((await evaluateFake(fake)).toMerge.length, 1)
})

test('last check and corrected title recover using current evidence', async () => {
  for (const name of ['CI', 'Secret scan', 'PR Title', 'Product CI']) {
    const fake = new Fake()
    let check = fake.checks[HEAD].find((item) => item.name === name)
    if (!check) {
      check = job(name)
      fake.checks[HEAD].push(check)
    }
    check.conclusion = 'failure'
    assert.deepEqual((await evaluateFake(fake)).toMerge, [])
    check.status = 'in_progress'
    check.conclusion = null
    assert.deepEqual((await evaluateFake(fake)).toMerge, [])
    check.status = 'completed'
    check.conclusion = 'success'
    await landFake(fake, (await evaluateFake(fake)).toMerge)
    assert.equal(fake.merges.length, 1, name)
  }
})

test('additional declared Product workflow finishing last permits landing', async () => {
  const fake = new Fake({ trees: { [BASE_A]: tree([E2E]), [HEAD]: tree([E2E]) } })
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  fake.runs[HEAD] = [run(1, E2E)]
  fake.jobs[1] = { 1: [job()] }
  await landFake(fake, (await evaluateFake(fake)).toMerge)
  assert.equal(fake.merges.length, 1)
})

test('active gate job is ignored without losing any self-workflow revocation checks', async () => {
  const fake = freshnessFixture()
  const self = {
    ...actionsRun(3, 30, 31),
    path: '.github/workflows/merge-on-green.yml',
    status: 'in_progress',
    conclusion: null,
  }
  fake.runs[HEAD].push(self)
  const active = actionsCheck('merge-on-green', 31, null)
  active.status = 'in_progress'
  fake.afterJobs = () => {
    fake.runs[HEAD][2].status = 'queued'
  }
  fake.checks[HEAD].push(actionsCheck('preflight', 31), active)
  assert.equal((await evaluateFake(fake)).toMerge.length, 1)
  const old = { ...actionsRun(4, 30, 32), path: self.path }
  fake.runs[HEAD].push(old)
  fake.checks[HEAD].push(actionsCheck('revoke-reviewed-on-push', 32, 'failure'))
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
  fake.checks[HEAD].pop()
  fake.checks[HEAD].push({
    ...actionsCheck('preflight', 32),
    status: 'in_progress',
    conclusion: null,
  })
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
})

test('a new run during jobs invalidates both evaluation and landing', async () => {
  for (const landing of [false, true]) {
    const fake = freshnessFixture()
    const selected = await evaluateFake(fake)
    fake.afterJobs = () => {
      fake.afterJobs = undefined
      fake.runs[HEAD].push(actionsRun(3, 10, 13))
    }
    if (landing) {
      await landFake(fake, selected.toMerge)
      assert.deepEqual(fake.merges, [])
    } else {
      assert.deepEqual((await evaluateFake(fake)).toMerge, [])
    }
  }
})

test('landing rereads Actions evidence after a new run appears', async () => {
  const fake = freshnessFixture()
  const selected = await evaluateFake(fake)
  assert.equal(selected.toMerge.length, 1)
  fake.runs[HEAD].push(actionsRun(3, 10, 13))
  fake.jobs[3] = { 1: [actionsJob(13000, 'CI', 'failure')] }
  await landFake(fake, selected.toMerge)
  assert.deepEqual(fake.merges, [])
})

test('freshness reads later run and job pages before deciding', async () => {
  const fake = freshnessFixture()
  fake.runs[HEAD] = Array.from({ length: 101 }, (_, index) => actionsRun(index + 1, 10, index + 11))
  fake.jobs[101] = {
    1: Array.from({ length: 100 }, (_, index) =>
      actionsJob(111000 + index, `optional ${index}`),
    ).concat(actionsJob(111100, 'CI')),
  }
  assert.equal((await evaluateFake(fake)).toMerge.length, 1)
  fake.jobs[101][1][100].conclusion = 'failure'
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
})
test('unmatched checks in old and latest Actions suites remain authoritative', async () => {
  for (const suite of [11, 12]) {
    for (const app of ['github-actions', 'external']) {
      for (const [name, conclusion] of [
        ['custom', 'failure'],
        ['CI', 'skipped'],
      ]) {
        const fake = freshnessFixture()
        fake.checks[HEAD].push({
          id: suite * 1000 + 999,
          name,
          status: 'completed',
          conclusion,
          app: { slug: app },
          check_suite: { id: suite },
        })
        assert.deepEqual((await evaluateFake(fake)).toMerge, [], `${suite}/${app}/${name}`)
      }
    }
  }
})

test('latest title run replaces failure without masking other producers or external checks', async () => {
  const fake = freshnessFixture()
  fake.checks[HEAD].push(actionsCheck('PR Title', 31, 'failure'))
  fake.runs[HEAD].push(actionsRun(3, 30, 31), actionsRun(4, 30, 32))
  fake.jobs[3] = { 1: [actionsJob(31000, 'PR Title', 'failure')] }
  fake.jobs[4] = { 1: [actionsJob(32000, 'PR Title')] }
  assert.equal((await evaluateFake(fake)).toMerge.length, 1)
  fake.jobs[4][1][0].conclusion = 'failure'
  assert.deepEqual((await evaluateFake(fake)).toMerge, [])
})

test('freshness rejects truncated check, run and exact-attempt job pages', async () => {
  for (const kind of ['checks', 'runs', 'jobs'] as const) {
    const fake = freshnessFixture()
    if (kind === 'checks') {
      const original = fake.github.rest.checks.listForRef
      fake.github.rest.checks.listForRef = async (params) => {
        const response = await original(params)
        response.data.total_count++
        return response
      }
    } else if (kind === 'runs') {
      const original = fake.github.rest.actions.listWorkflowRunsForRepo
      fake.github.rest.actions.listWorkflowRunsForRepo = async (params) => {
        const response = await original(params)
        response.data.total_count++
        return response
      }
    } else {
      const original = fake.github.rest.actions.listJobsForWorkflowRunAttempt
      fake.github.rest.actions.listJobsForWorkflowRunAttempt = async (params) => {
        const response = await original(params)
        response.data.total_count++
        return response
      }
    }
    const result = await evaluateFake(fake)
    assert.deepEqual(result.toMerge, [], kind)
    assert.equal(result.unreadable.length, 1, kind)
  }
})

test('capped check listing is unreadable without blocking another candidate', async () => {
  const fake = pair()
  fake.checks[HEAD] = Array.from({ length: 1000 }, (_, index) => ({
    name: `optional ${index}`,
    status: 'completed',
    conclusion: 'success',
    app: null,
  }))
  const result = await evaluateFake(fake)
  assert.deepEqual(
    result.toMerge.map((candidate) => candidate.number),
    [8],
  )
  assert.equal(result.unreadable.length, 1)
  await landFake(fake, result.toMerge)
  assert.deepEqual(fake.merges, [{ number: 8, sha: OTHER }])
})

test('unknown app evidence is retained and required checks still must succeed', async () => {
  const fake = freshnessFixture()
  fake.checks[HEAD].push({ name: 'CI', status: 'completed', conclusion: 'skipped', app: null })
  const held = await evaluateFake(fake)
  assert.deepEqual(held.toMerge, [])
  assert.deepEqual(held.unreadable, [])
})

let failed = 0
for (const [name, runCase] of cases) {
  try {
    await runCase()
    console.log(`PASS: ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL: ${name}\n${error instanceof Error ? error.stack : String(error)}`)
  }
}
console.log(
  failed === 0
    ? `test-merge-gate: OK (${cases.length} cases)`
    : `test-merge-gate: ${failed}/${cases.length} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
