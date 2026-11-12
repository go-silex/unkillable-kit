'use strict'

const {
  INHERITANCE_MARKER,
  PRODUCT_CONFIG,
  parseDeclaration,
} = require('./product-declaration.cjs')

const { selectLatestRun } = require('./latest-run.cjs')
const { readAuthorization } = require('./head-authorization.cjs')

/** @typedef {{ owner: string, repo: string }} Repo */
/** @typedef {{ repositoryId: number, operatorIds: number[], appId: number, botUserId: number }} AuthorizationPolicy */
/** @typedef {{ id: number, body: string }} AuthorizationReceipt */
/**
 * @typedef {object} Core
 * @property {(message: string) => void} info
 * @property {(message: string, properties?: { title?: string }) => void} notice
 * @property {(message: string) => void} warning
 * @property {(message: string) => void} error
 */
/** @typedef {{ id?: number, name: string, status: string, conclusion: string | null, app?: { slug: string } | null, check_suite?: { id: number } | null }} CheckRun */
/** @typedef {{ id?: number, name: string, status: string, conclusion: string | null }} Job */
/** @typedef {{ id: number, workflow_id?: number, check_suite_id?: number, path: string, head_sha: string, status: string | null, conclusion: string | null, run_attempt?: number }} WorkflowRun */
/** @typedef {{ number: number, state: string, draft?: boolean, merged?: boolean, base: { ref: string }, labels?: Array<{ name: string }> | null, user?: { login: string } | null }} PullSummary */
/** @typedef {PullSummary & { mergeable: boolean | null, head: { sha: string } }} PullRequest */
/** @typedef {{ inheritance: boolean, gate: string | null }} Side */
/**
 * A list endpoint's raw page body: rows themselves, or one wrapped rows array beside total_count.
 * github.paginate unwraps wrapped bodies and resolves to rows; the gate never reads a raw list body.
 * @template R
 * @typedef {R[] | { total_count: number, workflow_runs: R[] } | { total_count: number, jobs: R[] } | { total_count: number, check_runs: R[] }} ListBody
 */
/**
 * @typedef {object} GitHubPort
 * @property {<P, R>(endpoint: (params: P) => Promise<{ data: ListBody<R> }>, params: P) => Promise<R[]>} paginate
 * @property {{
 *   pulls: {
 *     list: (params: Repo & { state: string, per_page: number }) => Promise<{ data: PullSummary[] }>,
 *     get: (params: Repo & { pull_number: number }) => Promise<{ data: PullRequest }>,
 *   },
 *   checks: {
 *     listForRef: (params: Repo & { ref: string, per_page: number }) => Promise<{ data: { total_count: number, check_runs: CheckRun[] } }>,
 *   },
 *   repos: {
 *     getCommit: (params: Repo & { ref: string, mediaType: { format: string } }) => Promise<{ data: unknown }>,
 *     getContent: (params: Repo & { path: string, ref: string, mediaType: { format: string } }) => Promise<{ data: unknown }>,
 *     getCombinedStatusForRef: (params: Repo & { ref: string }) => Promise<{ data: { total_count: number, state: string } }>,
 *   },
 *   actions: {
 *     listWorkflowRunsForRepo: (params: Repo & { head_sha: string, per_page: number }) => Promise<{ data: { total_count: number, workflow_runs: WorkflowRun[] } }>,
 *     listJobsForWorkflowRunAttempt: (params: Repo & { run_id: number, attempt_number: number, per_page: number }) => Promise<{ data: { total_count: number, jobs: Job[] } }>,
 *     getWorkflowRun: (params: Repo & { run_id: number }) => Promise<{ data: WorkflowRun }>,
 *   },
 * }} rest
 */
/** @typedef {{ rest: { pulls: { merge: (params: Repo & { pull_number: number, merge_method: string, sha: string }) => Promise<unknown> } } }} MergerPort */
/**
 * @typedef {object} GateApi
 * @property {(ref: string) => Promise<string>} resolveCommit
 * @property {(ref: string, paths: string[]) => Promise<Array<string | null>>} readFiles
 * @property {(sha: string) => Promise<WorkflowRun[]>} listWorkflowRuns
 * @property {(runId: number, attempt: number) => Promise<Job[]>} listJobs
 * @property {(runId: number) => Promise<WorkflowRun>} getWorkflowRun
 */
/** @typedef {{ inputs?: { pr?: string }, pull_request?: { number: number }, workflow_run?: { pull_requests?: Array<{ number: number }> } }} EventPayload */

const SELF_JOB = 'merge-on-green'
const MERGE_BASES = new Set(['main', 'staging'])
const PASSING = new Set(['success', 'neutral', 'skipped'])
const OPEN_PR_LIST = 'open PR list'
const MERGEABLE_READS = 6
const MERGEABLE_WAIT_MS = 3000
const SHA = /^[0-9a-f]{40}$/i

/** @param {unknown} error */
const errorText = (error) => (error instanceof Error ? error.message : String(error))
/** @param {unknown} error */
const httpStatus = (error) =>
  error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined
/** @param {Core} core @returns {Core} */
const lineSafe = (core) => ({
  ...core,
  info: (message) => core.info(message.replace(/\r/g, '\\r').replace(/\n/g, '\\n')),
})

/** @param {PullSummary} pr */
function ineligible(pr) {
  if (pr.state !== 'open') return `not open (${pr.state})`
  if (pr.draft) return 'draft'
  if (pr.merged) return 'already merged'
  if (!MERGE_BASES.has(pr.base.ref)) return `base '${pr.base.ref}' is not main|staging`
  return null
}

/** @param {unknown} value @param {string} name */
function validSha(value, name) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${name} did not resolve to an immutable 40-hex SHA`)
  }
  return value.toLowerCase()
}
/** @param {unknown} value @returns {value is number} */
const positive = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** @param {any} body @param {string} key @param {number | undefined} total */
function pageTotal(body, key, total) {
  if (
    !(body && Number.isSafeInteger(body.total_count)) ||
    body.total_count < 0 ||
    !Array.isArray(body[key])
  )
    throw new Error(`invalid ${key} page`)
  if (total !== undefined && total !== body.total_count)
    throw new Error(`${key} changed during pagination`)
  return body.total_count
}

// A missing total, truncated page, or GitHub's result cap cannot prove freshness.
/** @param {any} endpoint @param {any} params @param {string} key @returns {Promise<any[]>} */
async function complete(endpoint, params, key) {
  const rows = []
  let total
  for (let page = 1; ; page++) {
    const response = await endpoint({ ...params, per_page: 100, page })
    const body = response.data
    total = pageTotal(body, key, total)
    rows.push(...body[key])
    const next = /rel="next"/.test(response.headers?.link || '')
    if (!next) break
    if (!body[key].length || rows.length >= total) throw new Error(`invalid ${key} pagination`)
  }
  if (rows.length !== total || rows.length >= 1000) throw new Error(`incomplete ${key} pagination`)
  return rows
}

class CheckHold extends Error {}

/** @param {any} run @param {any} context */
function producerKey(run, context) {
  if (
    context &&
    run.event === 'pull_request' &&
    run.head_sha === context.sha &&
    run.head_branch === context.branch &&
    run.head_repository?.id === context.repoId
  )
    return `pr:${run.workflow_id}`
  return `run:${run.id}`
}

/** @param {any[]} runs @param {string} head @param {any} context */
function indexActionRuns(runs, head, context) {
  const bySuite = new Map()
  const latest = new Map()
  const paths = new Map()
  const pathOwners = new Map()
  const ids = new Map()
  for (const run of runs) {
    if (
      !(positive(run.id) && positive(run.workflow_id) && positive(run.check_suite_id)) ||
      run.head_sha !== head ||
      typeof run.path !== 'string' ||
      !run.path ||
      ids.has(run.id) ||
      bySuite.has(run.check_suite_id)
    )
      throw new Error('invalid Actions run identity')
    ids.set(run.id, run)
    if (
      (paths.has(run.workflow_id) && paths.get(run.workflow_id) !== run.path) ||
      (pathOwners.has(run.path) && pathOwners.get(run.path) !== run.workflow_id)
    )
      throw new Error('ambiguous Actions workflow path')
    paths.set(run.workflow_id, run.path)
    pathOwners.set(run.path, run.workflow_id)
    bySuite.set(run.check_suite_id, run)
    const key = producerKey(run, context)
    if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, run)
  }
  return { bySuite, latest, paths, ids, context }
}

const SELF_WORKFLOW = '.github/workflows/merge-on-green.yml'
const REQUIRED_CHECK = /^(ci|validate-full|lint-typecheck-test)$|TruffleHog|Secret scan/i

/** @param {any[]} checks */
function actionSuites(checks) {
  const suites = new Set()
  for (const check of checks) {
    if (check.app === null || check.app === undefined) continue // Unknown providers remain conservative.
    if (typeof check.app.slug !== 'string' || !check.app.slug)
      throw new Error('invalid check provider')
    if (check.app.slug !== 'github-actions') continue
    if (!positive(check.check_suite?.id)) throw new Error('invalid Actions check suite')
    suites.add(check.check_suite.id)
  }
  return suites
}

/** @param {Set<any>} suites @param {any} index */
function actionProducers(suites, index) {
  const workflows = new Set()
  const producers = new Set()
  for (const suite of suites) {
    const run = index.bySuite.get(suite)
    if (run === undefined) throw new Error('unmatched Actions suite')
    workflows.add(run.workflow_id)
    producers.add(producerKey(run, index.context))
  }
  for (const [key, run] of index.latest) {
    if (key.startsWith('pr:') && workflows.has(run.workflow_id)) producers.add(key)
  }
  return producers
}

/** @param {GitHubPort} github @param {Repo} repo @param {any} run */
async function attemptJobs(github, repo, run) {
  if (!positive(run.run_attempt)) throw new Error('Actions run has no valid attempt')
  return complete(
    github.rest.actions.listJobsForWorkflowRunAttempt,
    {
      ...repo,
      run_id: run.id,
      attempt_number: run.run_attempt,
    },
    'jobs',
  )
}

/** @param {GitHubPort} github @param {Repo} repo @param {Set<any>} producers @param {any} index */
async function latestProducerJobs(github, repo, producers, index) {
  const proven = new Map()
  const jobs = []
  for (const producer of producers) {
    const run = index.latest.get(producer)
    if (run.path === SELF_WORKFLOW) continue
    if (!positive(run.run_attempt)) throw new Error('Actions run has no valid attempt')
    if (run.status !== 'completed' || !PASSING.has(run.conclusion))
      throw new CheckHold(`Actions run ${run.status === 'completed' ? run.conclusion : run.status}`)
    const current = await attemptJobs(github, repo, run)
    if (!current.length) throw new CheckHold('Actions run has no jobs')
    if (
      current.some(
        (job) =>
          !positive(job.id) ||
          typeof job.name !== 'string' ||
          !job.name ||
          typeof job.status !== 'string',
      )
    )
      throw new Error('invalid Actions jobs')
    proven.set(run.check_suite_id, new Set(current.map((job) => job.id)))
    jobs.push(...current)
  }
  return { proven, jobs }
}

/** @param {GitHubPort} github @param {Repo} repo @param {Set<any>} suites @param {any} index @param {Map<any, any>} proven */
async function proveOlderJobs(github, repo, suites, index, proven) {
  for (const suite of suites) {
    const run = index.bySuite.get(suite)
    if (index.paths.get(run.workflow_id) === SELF_WORKFLOW || proven.has(suite)) continue
    const jobs = await attemptJobs(github, repo, run)
    if (jobs.some((job) => !positive(job.id))) throw new Error('invalid old Actions job identity')
    proven.set(suite, new Set(jobs.map((job) => job.id)))
  }
}

/** @param {any[]} checks @param {any} index @param {Map<any, any>} proven @param {any[]} jobs */
function pruneProvenChecks(checks, index, proven, jobs) {
  const result = checks.filter(
    (check) =>
      check.app?.slug !== 'github-actions' ||
      index.bySuite.get(check.check_suite.id).path === SELF_WORKFLOW,
  )
  result.push(...jobs)
  for (const check of checks) {
    if (check.app?.slug !== 'github-actions') continue
    const run = index.bySuite.get(check.check_suite.id)
    if (!proven.get(check.check_suite.id)?.has(check.id)) {
      if (run.path !== SELF_WORKFLOW) result.push(check)
      continue
    }
    const latest = index.latest.get(producerKey(run, index.context))
    if (
      REQUIRED_CHECK.test(check.name || '') &&
      !jobs.some((job) => job.name === check.name && proven.get(latest.check_suite_id)?.has(job.id))
    )
      throw new CheckHold('required Actions check missing from latest attempt')
  }
  return result
}

/** @param {any} run */
const runIdentity = (run) =>
  run &&
  JSON.stringify([
    run.id,
    run.workflow_id,
    run.path,
    run.head_sha,
    run.check_suite_id,
    run.run_attempt,
    run.status,
    run.conclusion,
    run.event,
    run.head_branch,
    run.head_repository?.id,
  ])

/** @param {any} before @param {any} after */
function verifyRunIdentities(before, after) {
  for (const runId of new Set([...before.ids.keys(), ...after.ids.keys()])) {
    const previous = before.ids.get(runId)
    const current = after.ids.get(runId)
    if (
      (!previous || previous.path === SELF_WORKFLOW) &&
      (!current || current.path === SELF_WORKFLOW)
    )
      continue
    if (runIdentity(previous) !== runIdentity(current))
      throw new CheckHold('Actions run changed after jobs')
  }
}

/** @param {any[]} runs @param {any} pr @param {string} sha */
function possibleContext(runs, pr, sha) {
  const branch = pr.head?.ref
  const repoId = pr.head?.repo?.id
  const owner = pr.head?.repo?.owner?.login
  if (
    typeof branch !== 'string' ||
    !branch ||
    !positive(repoId) ||
    typeof owner !== 'string' ||
    !owner
  )
    return null
  const counts = new Map()
  for (const run of runs) {
    if (
      run.event !== 'pull_request' ||
      run.head_sha !== sha ||
      run.head_branch !== branch ||
      run.head_repository?.id !== repoId
    )
      continue
    counts.set(run.workflow_id, (counts.get(run.workflow_id) ?? 0) + 1)
  }
  if (![...counts.values()].some((count) => count >= 2)) return null
  return { branch, repoId, owner, sha }
}

/** @param {any} github @param {Repo} repo @param {any} pr @param {any} context */
async function proveUniqueHead(github, repo, pr, context) {
  const response = await github.rest.pulls.list({
    ...repo,
    state: 'all',
    head: `${context.owner}:${context.branch}`,
    per_page: 100,
    page: 1,
  })
  if (!Array.isArray(response.data)) throw new Error('invalid head PR listing')
  if (response.data.length >= 100 || /rel="next"/.test(response.headers?.link || '')) return false
  if (response.data.length !== 1) return false
  const only = response.data[0]
  return (
    only.number === pr.number &&
    only.head?.ref === context.branch &&
    only.head?.repo?.id === context.repoId &&
    only.head?.sha === context.sha
  )
}

/** @param {any} github @param {Repo} repo @param {any} assessed @param {any} context */
async function unchangedBase(github, repo, assessed, context) {
  const query = `query MergeGateBaseHistory($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number baseRefName headRefName headRefOid headRepository { databaseId }
        timelineItems(first: 1, itemTypes: [BASE_REF_CHANGED_EVENT, BASE_REF_DELETED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]) {
          nodes { __typename } pageInfo { hasNextPage }
        }
      }
    }
  }`
  const response = await github.graphql(query, { ...repo, number: assessed.number })
  const pr = response?.repository?.pullRequest
  const timeline = pr?.timelineItems
  if (
    pr?.number !== assessed.number ||
    pr.baseRefName !== assessed.base.ref ||
    pr.headRefName !== context.branch ||
    pr.headRefOid !== context.sha ||
    pr.headRepository?.databaseId !== context.repoId ||
    !timeline ||
    !Array.isArray(timeline.nodes) ||
    typeof timeline.pageInfo?.hasNextPage !== 'boolean' ||
    timeline.nodes.length > 1
  )
    throw new Error('invalid base history proof')
  if (timeline.nodes.length === 0 && !timeline.pageInfo.hasNextPage) return true
  if (
    timeline.nodes.length === 1 &&
    ['BaseRefChangedEvent', 'BaseRefDeletedEvent', 'AutomaticBaseChangeSucceededEvent'].includes(
      timeline.nodes[0]?.__typename,
    )
  )
    return false
  throw new Error('incomplete base history proof')
}

/** @param {GitHubPort} github @param {Repo} repo @param {string} head @param {PullRequest} pr @returns {Promise<CheckRun[]>} */
async function currentChecks(github, repo, head, pr) {
  const checks = await complete(
    github.rest.checks.listForRef,
    { ...repo, ref: head, filter: 'latest' },
    'check_runs',
  )
  const suites = actionSuites(checks)
  if (!suites.size) return checks
  const listRuns = () =>
    complete(
      github.rest.actions.listWorkflowRunsForRepo,
      { ...repo, head_sha: head },
      'workflow_runs',
    )
  const runs = await listRuns()
  const candidate = possibleContext(runs, pr, head)
  const context =
    candidate &&
    (await proveUniqueHead(github, repo, pr, candidate)) &&
    (await unchangedBase(github, repo, pr, candidate))
      ? candidate
      : null
  const index = indexActionRuns(runs, head, context)
  const producers = actionProducers(suites, index)
  const { proven, jobs } = await latestProducerJobs(github, repo, producers, index)
  await proveOlderJobs(github, repo, suites, index, proven)
  const result = pruneProvenChecks(checks, index, proven, jobs)
  verifyRunIdentities(index, indexActionRuns(await listRuns(), head, context))
  return result
}

/** @param {GitHubPort} github @param {Repo} repo @param {string} head @param {PullRequest} pr
 * @returns {Promise<{checks: CheckRun[], reason: null} | {checks: null, reason: string}>} */
async function currentChecksResult(github, repo, head, pr) {
  try {
    return { checks: await currentChecks(github, repo, head, pr), reason: null }
  } catch (error) {
    if (error instanceof CheckHold) return { checks: null, reason: error.message }
    throw error
  }
}

/**
 * @param {GitHubPort} github
 * @param {Repo} repo
 * @returns {GateApi}
 */
function fromGitHub(github, repo) {
  /** @param {string} ref @returns {Promise<string>} */
  const resolveCommit = async (ref) => {
    const { data } = await github.rest.repos.getCommit({
      ...repo,
      ref,
      mediaType: { format: 'sha' },
    })
    const sha =
      typeof data === 'string'
        ? data
        : data !== null && typeof data === 'object' && 'sha' in data
          ? data.sha
          : undefined
    return validSha(sha, ref)
  }
  /** @param {string} ref @param {string} path @returns {Promise<string | null>} */
  const readFile = async (ref, path) => {
    try {
      const { data } = await github.rest.repos.getContent({
        ...repo,
        path,
        ref,
        mediaType: { format: 'raw' },
      })
      if (typeof data !== 'string') throw new Error(`${path} at ${ref} is not a file`)
      return data
    } catch (error) {
      if (httpStatus(error) === 404) return null
      throw error
    }
  }
  /** @param {string} ref @param {string[]} paths @returns {Promise<Array<string | null>>} */
  const readFiles = async (ref, paths) => Promise.all(paths.map((path) => readFile(ref, path)))
  /** @param {string} sha @returns {Promise<WorkflowRun[]>} */
  const listWorkflowRuns = (sha) =>
    github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      ...repo,
      head_sha: sha,
      per_page: 100,
    })
  /** @param {number} runId @param {number} attempt @returns {Promise<Job[]>} */
  const listJobs = (runId, attempt) =>
    github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
      ...repo,
      run_id: runId,
      attempt_number: attempt,
      per_page: 100,
    })
  /** @param {number} runId @returns {Promise<WorkflowRun>} */
  const getWorkflowRun = async (runId) =>
    (await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).data
  return { resolveCommit, readFiles, listWorkflowRuns, listJobs, getWorkflowRun }
}

/** @param {GateApi} api @param {string} ref @returns {Promise<Side>} */
async function readSide(api, ref) {
  const [inheritance, gate] = await api.readFiles(ref, [INHERITANCE_MARKER, PRODUCT_CONFIG])
  return { inheritance: inheritance !== null, gate }
}

/**
 * @param {Side} base
 * @param {Side} head
 * @returns {{ paths: string[], problems: string[] }}
 */
function declaredWorkflows(base, head) {
  const productMode =
    base.inheritance || head.inheritance || base.gate !== null || head.gate !== null
  if (!productMode) return { paths: [], problems: [] }
  /** @type {string[]} */
  const paths = []
  /** @type {string[]} */
  const problems = []
  /** @type {Array<['base' | 'head', Side]>} */
  const sides = [
    ['base', base],
    ['head', head],
  ]
  for (const [name, side] of sides) {
    if (name === 'base' && side.gate === null) continue
    const parsed = parseDeclaration(side.gate, true)
    for (const finding of parsed.findings) problems.push(`${name}: ${finding.refusal}`)
    for (const path of parsed.product) if (!paths.includes(path)) paths.push(path)
  }
  return { paths, problems }
}

/**
 * @param {GateApi} api
 * @param {string} path
 * @param {string} head
 * @param {WorkflowRun[]} runs
 * @returns {Promise<string[]>}
 */
async function workflowHolds(api, path, head, runs) {
  const name = path.replace(/^\.github\/workflows\//, '')
  const run = selectLatestRun(runs, path)
  if (!run) return [`${name}=missing`]
  if (run.head_sha !== head) return [`${name}=wrong head`]
  if (run.status !== 'completed') return [`${name}=${run.status}`]
  if (run.conclusion !== 'success') return [`${name}=${run.conclusion}`]
  const attempt = run.run_attempt
  if (attempt === undefined || !Number.isSafeInteger(attempt) || attempt < 1)
    return [`${name}=no valid run attempt`]
  const jobs = await api.listJobs(run.id, attempt)
  const current = await api.getWorkflowRun(run.id)
  if (current.id !== run.id || current.path !== run.path || current.head_sha !== head) {
    return [`${name}=run changed`]
  }
  if (current.run_attempt !== attempt) return [`${name}=attempt changed`]
  if (current.status !== 'completed') return [`${name}=${current.status}`]
  if (current.conclusion !== 'success') return [`${name}=${current.conclusion}`]
  if (!jobs.length) return [`${name}=no jobs`]
  return jobs
    .filter((job) => job.status !== 'completed' || job.conclusion !== 'success')
    .map(
      (job) => `${name}: ${job.name}=${job.status === 'completed' ? job.conclusion : job.status}`,
    )
}

/**
 * @param {GateApi} api
 * @param {{ base: string, head: string }} refs
 * @returns {Promise<string[]>}
 */
async function productHold(api, { base, head }) {
  const [baseSha, headSha] = await Promise.all([
    api.resolveCommit(base),
    api.resolveCommit(validSha(head, 'head')),
  ])
  if (headSha !== validSha(head, 'head')) throw new Error('head resolved to a different commit')
  const [baseSide, headSide] = await Promise.all([readSide(api, baseSha), readSide(api, headSha)])
  const declared = declaredWorkflows(baseSide, headSide)
  if (declared.problems.length || !declared.paths.length) return declared.problems
  const runs = await api.listWorkflowRuns(headSha)
  /** @type {string[]} */
  const holds = []
  for (const path of declared.paths) holds.push(...(await workflowHolds(api, path, headSha, runs)))
  return holds
}

const DISPATCH_PR = /^[1-9][0-9]*$/

/**
 * @param {EventPayload} payload
 * @returns {{ numbers: number[], rejected: string | null }}
 */
function eventPrs(payload) {
  const requested = payload.inputs?.pr
  if (requested) {
    const number = Number(requested)
    return DISPATCH_PR.test(requested) && Number.isSafeInteger(number)
      ? { numbers: [number], rejected: null }
      : { numbers: [], rejected: requested }
  }
  if (payload.pull_request) return { numbers: [payload.pull_request.number], rejected: null }
  return {
    numbers: (payload.workflow_run?.pull_requests || []).map((pr) => pr.number),
    rejected: null,
  }
}

/** @param {GitHubPort} github @param {Repo} repo @param {number} number */
async function currentPull(github, repo, number) {
  for (let read = 1; ; read++) {
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number })
    if (pr.mergeable !== null || pr.state !== 'open' || read === MERGEABLE_READS) return pr
    await new Promise((resolve) => setTimeout(resolve, MERGEABLE_WAIT_MS))
  }
}

/**
 * @param {GitHubPort} github
 * @param {Repo} repo
 * @param {GateApi} gate
 * @param {number} number
 * @param {Core} core
 * @param {string} [expectedSha]
 */
async function assess(github, repo, gate, number, core, expectedSha) {
  const tag = `PR #${number}`
  const pr = await currentPull(github, repo, number)
  const reason = ineligible(pr)
  if (reason) return { sha: null, reason }
  if (pr.mergeable === false) return { sha: null, reason: 'conflict' }
  if (pr.mergeable === null) return { sha: null, reason: 'mergeability computing' }
  const reportedSha = validSha(pr.head.sha, `${tag} head`)
  const sha = await gate.resolveCommit(reportedSha)
  if (sha !== reportedSha) throw new Error(`${tag} head resolved to a different commit`)
  if (expectedSha && sha !== validSha(expectedSha, `${tag} queued head`))
    return { sha: null, stale: true }
  const checkResult = await currentChecksResult(github, repo, sha, pr)
  if (!checkResult.checks) return { sha: null, reason: checkResult.reason }
  // Keep revocation in the required set: otherwise a workflow_run could merge a pushed head
  // while a stale reviewed label has not yet been removed.
  const others = checkResult.checks.filter((check) => check.name !== SELF_JOB)
  if (!others.length) return { sha: null, reason: 'no check runs on head (fail-closed)' }
  /** @param {RegExp} pattern */
  const has = (pattern) => others.some((check) => pattern.test(check.name || ''))
  const secretPattern = /TruffleHog|Secret scan/i
  const ciPattern = /^(ci|validate-full|lint-typecheck-test)$/i
  const secret = has(secretPattern)
  const ci = has(ciPattern)
  if (!(secret && ci))
    return { sha: null, reason: `missing required checks (secret=${secret}, ci=${ci})` }
  const pending = others.filter((check) => check.status !== 'completed')
  if (pending.length)
    return { sha: null, reason: `pending ${pending.map((check) => check.name).join(', ')}` }
  const failed = others.filter((check) =>
    secretPattern.test(check.name || '') || ciPattern.test(check.name || '')
      ? check.conclusion !== 'success'
      : !PASSING.has(check.conclusion ?? ''),
  )
  if (failed.length)
    return {
      sha: null,
      reason: `failed ${failed.map((check) => `${check.name}=${check.conclusion}`).join(', ')}`,
    }
  const { data: combined } = await github.rest.repos.getCombinedStatusForRef({ ...repo, ref: sha })
  if (combined.total_count > 0 && combined.state !== 'success')
    return { sha: null, reason: `combined status = ${combined.state}` }
  const holds = await productHold(gate, { base: `refs/heads/${pr.base.ref}`, head: sha })
  if (holds.length) {
    core.notice(`${tag}: held by product workflows on ${sha} — ${holds.join('; ')}`, {
      title: 'Product workflows hold',
    })
    return { sha: null }
  }
  return { sha, baseRef: pr.base.ref }
}

/** @param {GitHubPort & import('./head-authorization.cjs').Reader} github @param {Repo} repo @param {GateApi} gate @param {number} number @param {Core} core @param {AuthorizationPolicy} policy */
async function evaluateCandidate(github, repo, gate, number, core, policy) {
  const result = await assess(github, repo, gate, number, core)
  if (!result.sha) {
    if (result.reason) core.info(`PR #${number}: ${result.reason} — skip.`)
    return null
  }
  const authority = await readAuthorization({ github, repo, prNumber: number, policy })
  if (
    !authority.allowed ||
    authority.scope.headSha !== result.sha ||
    authority.scope.baseRef !== result.baseRef
  ) {
    core.info(`PR #${number}: authorization held (${authority.reason || 'head changed'}) — skip.`)
    return null
  }
  core.info(`PR #${number}: authorization + checks green on ${result.sha} → queue merge.`)
  return { number, sha: result.sha, receipt: authority.receipt }
}

/**
 * @param {{ github: GitHubPort & import('./head-authorization.cjs').Reader, repo: Repo, payload: EventPayload, core: Core, policy: AuthorizationPolicy }} input
 */
async function evaluate({ github, repo, payload, core: log, policy }) {
  const core = lineSafe(log)
  /** @type {string[]} */
  const unreadable = []
  const priority = eventPrs(payload)
  if (priority.rejected !== null) {
    core.warning(
      `workflow_dispatch pr=${JSON.stringify(priority.rejected)} is not a PR number — no PR prioritized; scanning eligible PRs.`,
    )
  }
  const candidates = new Set(priority.numbers.filter(Number.isSafeInteger))
  try {
    const open = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: 'open',
      per_page: 100,
    })
    for (const pr of open) if (!ineligible(pr)) candidates.add(pr.number)
  } catch (error) {
    unreadable.push(OPEN_PR_LIST)
    core.error(`${OPEN_PR_LIST} unreadable — only the event's PRs are judged: ${errorText(error)}`)
  }
  const gate = fromGitHub(github, repo)
  /** @type {Array<{ number: number, sha: string, receipt: { id: number, body: string } }>} */
  const toMerge = []
  for (const number of candidates) {
    try {
      const candidate = await evaluateCandidate(github, repo, gate, number, core, policy)
      if (candidate) toMerge.push(candidate)
    } catch (error) {
      unreadable.push(`PR #${number}`)
      core.error(`PR #${number}: held, merge gate unreadable: ${errorText(error)}`)
    }
  }
  if (!toMerge.length) core.info('No PRs ready to merge.')
  return { toMerge, unreadable }
}

/**
 * @param {GitHubPort & import('./head-authorization.cjs').Reader} github @param {MergerPort} merger @param {Repo} repo
 * @param {GateApi} gate @param {{ number: number, sha?: string, receipt?: AuthorizationReceipt }} candidate
 * @param {Core} core @param {AuthorizationPolicy} policy @param {string[]} stale
 */
async function landCandidate(
  github,
  merger,
  repo,
  gate,
  { number, sha, receipt },
  core,
  policy,
  stale,
) {
  const tag = `PR #${number}`
  const expectedSha = validSha(sha, `${tag} queued head`)
  const result = await assess(github, repo, gate, number, core, expectedSha)
  if (!result.sha) {
    if (result.stale) {
      stale.push(`${tag} (evaluated ${sha})`)
      core.warning(`${tag}: head moved after evaluation of ${sha} — merge refused.`)
    } else if (result.reason) core.info(`${tag}: no longer green (${result.reason}) — skip.`)
    return
  }
  const authority = await readAuthorization({ github, repo, prNumber: number, policy })
  if (
    !authority.allowed ||
    authority.scope.headSha !== result.sha ||
    authority.scope.baseRef !== result.baseRef ||
    !receipt ||
    authority.receipt.id !== receipt.id ||
    authority.receipt.body !== receipt.body
  ) {
    core.info(`${tag}: authorization changed — skip.`)
    return
  }
  await merger.rest.pulls.merge({
    ...repo,
    pull_number: number,
    merge_method: 'merge',
    sha: result.sha,
  })
  core.notice(
    `${tag}: merged ${result.sha} (merge commit) — authorization + checks green (kit-ci).`,
  )
}

/**
 * @param {{ github: GitHubPort & import('./head-authorization.cjs').Reader, merger: MergerPort, repo: Repo, queue: Array<{ number: number, sha?: string, receipt?: AuthorizationReceipt }>, core: Core, policy: AuthorizationPolicy }} input
 */
async function land({ github, merger, repo, queue, core: log, policy }) {
  const core = lineSafe(log)
  const gate = fromGitHub(github, repo)
  /** @type {string[]} */
  const stale = []
  /** @type {string[]} */
  const unreadable = []
  for (const candidate of queue) {
    const { number, sha } = candidate
    const tag = `PR #${number}`
    try {
      await landCandidate(github, merger, repo, gate, candidate, core, policy, stale)
    } catch (error) {
      if (httpStatus(error) === 409) {
        stale.push(`${tag} (evaluated ${sha})`)
        core.warning(`${tag}: head moved after evaluation of ${sha} — merge refused (409).`)
      } else {
        unreadable.push(tag)
        core.error(`${tag}: held, fresh merge gate unreadable: ${errorText(error)}`)
      }
    }
  }
  return { stale, unreadable }
}

module.exports = { evaluate, land, productHold }
