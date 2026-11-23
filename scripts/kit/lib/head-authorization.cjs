'use strict'
const {
  PREFIX,
  render,
  decode,
  classifyIssuer,
  authorizationProofTargets,
  project,
} = require('./head-authorization-core.cjs')
/** @typedef {import('./head-authorization-core.cjs').Policy} Policy */
/** @typedef {import('./head-authorization-core.cjs').Scope} Scope */
/** @typedef {import('./head-authorization-core.cjs').AuthorizationRecord} AuthorizationRecord */
/** @typedef {import('./head-authorization-core.cjs').Comment} Comment */
/** @typedef {import('./head-authorization-core.cjs').Proof} Proof */
/** @typedef {{owner:string, repo:string}} Repo */
/** @typedef {Scope & {previous:number|null}} Snapshot */
/** @typedef {{__typename:string, id:string, fullDatabaseId:unknown, lastEditedAt:string|null, repository:{fullDatabaseId:unknown}|null, pullRequest:{fullDatabaseId:unknown,number:number}|null}} CommentNode */
/** @typedef {{rest:{repos:{get:(p:Repo)=>Promise<{data:{id:number}}>,getCommit:(p:Repo & {ref:string,mediaType:{format:string}})=>Promise<{data:string|{sha?:string}}>},pulls:{get:(p:Repo & {pull_number:number})=>Promise<{data:{id:number,number:number,head:{sha:string},base:{ref:string},user:{id:number}|null}}>},issues:{listComments:(p:Repo & {issue_number:number,per_page:number,page:number})=>Promise<{data:Comment[],headers?:{link?:string}}>}},graphql:(query:string, variables:{ids:string[]})=>Promise<{nodes:(CommentNode|null)[]}>}} Reader */
/** @typedef {{rest:{issues:{createComment:(p:Repo & {issue_number:number,body:string})=>Promise<unknown>}}}} Writer */
/** @typedef {{github:Reader,repo:Repo,prNumber:number,policy:Policy}} Input */
/** @param {unknown} n @returns {n is number} */
const positive = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
/** @param {unknown} value @param {number} expected */
const matchesId = (value, expected) =>
  positive(expected) &&
  (typeof value === 'string' ? value === String(expected) : value === expected)
/** @param {Record<string,string|undefined>} env @returns {Policy} */
function policyFromEnv(env) {
  /** @param {unknown} s */
  const numeric = (s) =>
    typeof s === 'string' && /^[1-9][0-9]*$/.test(s) && positive(Number(s)) ? Number(s) : null
  /** @type {unknown} */
  let operatorIds
  try {
    operatorIds = JSON.parse(env.HEAD_AUTH_OPERATOR_IDS ?? '')
  } catch {
    throw new Error('invalid HEAD_AUTH_OPERATOR_IDS')
  }
  const repositoryId = numeric(env.HEAD_AUTH_REPOSITORY_ID)
  const appId = numeric(env.HEAD_AUTH_APP_ID)
  const botUserId = numeric(env.HEAD_AUTH_BOT_USER_ID)
  if (
    !(
      repositoryId &&
      appId &&
      botUserId &&
      Array.isArray(operatorIds) &&
      operatorIds.length &&
      operatorIds.every(positive)
    ) ||
    new Set(operatorIds).size !== operatorIds.length
  )
    throw new Error('invalid head authorization policy')
  return { repositoryId, operatorIds, appId, botUserId }
}
/** @param {unknown} link @param {number} page @param {number} count */
function nextCommentPage(link, page, count) {
  if (link === undefined || link === '') return count === 100 ? page + 1 : null
  if (typeof link !== 'string') throw new Error('invalid pagination link')
  const links = link.split(',').map((part) => {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part)
    if (!match) throw new Error('invalid pagination link')
    return { url: match[1], rel: match[2] }
  })
  const next = links.filter((entry) => entry.rel === 'next')
  if (next.length > 1) throw new Error('ambiguous pagination link')
  if (!next.length) return count === 100 ? page + 1 : null
  const nextPage = Number(new URL(next[0].url).searchParams.get('page'))
  if (!Number.isSafeInteger(nextPage) || nextPage !== page + 1 || count === 0)
    throw new Error('invalid pagination sequence')
  return nextPage
}
/** @param {Reader} github @param {Repo} repo @param {number} prNumber */
async function listComments(github, repo, prNumber) {
  const comments = []
  let page = 1
  let last = 0
  while (true) {
    const response = await github.rest.issues.listComments({
      ...repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    })
    if (!Array.isArray(response.data)) throw new Error('incomplete authorization comments')
    for (const c of response.data) {
      if (!positive(c.id) || c.id <= last || typeof c.node_id !== 'string' || !c.node_id)
        throw new Error('invalid comment enumeration')
      last = c.id
      comments.push(c)
    }
    const next = nextCommentPage(response.headers?.link, page, response.data.length)
    if (next === null) break
    page = next
  }
  return comments
}
/** @param {Input} input */
async function observe({ github, repo, prNumber, policy }) {
  const [{ data: repository }, { data: pr }] = await Promise.all([
    github.rest.repos.get(repo),
    github.rest.pulls.get({ ...repo, pull_number: prNumber }),
  ])
  const { data: baseCommit } = await github.rest.repos.getCommit({
    ...repo,
    ref: `refs/heads/${pr.base.ref}`,
    mediaType: { format: 'sha' },
  })
  const baseSha = typeof baseCommit === 'string' ? baseCommit : baseCommit?.sha
  const authorId = pr.user?.id
  if (typeof baseSha !== 'string' || !positive(authorId))
    throw new Error('invalid authorization scope')
  const scope = {
    repositoryId: repository.id,
    pullRequestId: pr.id,
    pullRequest: pr.number,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseSha,
    authorId,
  }
  if (
    scope.repositoryId !== policy.repositoryId ||
    !positive(scope.pullRequestId) ||
    scope.pullRequest !== prNumber ||
    !positive(scope.authorId) ||
    !/^[0-9a-f]{40}$/.test(scope.headSha) ||
    !/^[0-9a-f]{40}$/.test(scope.baseSha) ||
    typeof scope.baseRef !== 'string' ||
    !scope.baseRef
  )
    throw new Error('invalid authorization scope')
  const comments = await listComments(github, repo, prNumber)
  const stream = comments.filter(
    (c) => classifyIssuer(c, policy) && typeof c.body === 'string' && c.body.startsWith(PREFIX),
  )
  const targets = authorizationProofTargets(comments, policy)
  /** @type {Record<number,Proof>} */
  const proofs = {}
  // A raced withdrawal can leave the active grant farther back than the last two comments.
  for (let offset = 0; offset < targets.length; offset += 100) {
    const batch = targets.slice(offset, offset + 100)
    const result = await github.graphql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on IssueComment { id fullDatabaseId lastEditedAt repository { fullDatabaseId } pullRequest { fullDatabaseId number } } } }`,
      { ids: batch.map((c) => c.node_id) },
    )
    if (!Array.isArray(result?.nodes) || result.nodes.length !== batch.length)
      throw new Error('incomplete authorization proof')
    for (let i = 0; i < batch.length; i++) {
      const n = result.nodes[i],
        c = batch[i]
      if (
        n?.__typename !== 'IssueComment' ||
        n.id !== c.node_id ||
        !matchesId(n.fullDatabaseId, c.id) ||
        !Object.hasOwn(n, 'lastEditedAt') ||
        !matchesId(n.repository?.fullDatabaseId, scope.repositoryId) ||
        !matchesId(n.pullRequest?.fullDatabaseId, scope.pullRequestId) ||
        n.pullRequest?.number !== prNumber
      )
        throw new Error('inconsistent authorization proof')
      proofs[c.id] = {
        id: c.id,
        nodeId: n.id,
        repositoryId: scope.repositoryId,
        pullRequestId: scope.pullRequestId,
        lastEditedAt: n.lastEditedAt,
      }
    }
  }
  return { scope, ...project({ comments, policy, scope, proofs }), comments: stream }
}
/** @param {Input} input */
async function readAuthorization(input) {
  const { comments, ...result } = await observe(input)
  return result
}
/** @param {Input} input @returns {Promise<Snapshot>} */
async function captureAuthorization(input) {
  const state = await readAuthorization(input)
  return { ...state.scope, previous: state.previous }
}
/** @param {Scope} a @param {Scope} b @param {string} lane */
const sameScope = (a, b, lane) =>
  a.repositoryId === b.repositoryId &&
  a.pullRequestId === b.pullRequestId &&
  a.pullRequest === b.pullRequest &&
  a.headSha === b.headSha &&
  a.baseRef === b.baseRef &&
  a.authorId === b.authorId &&
  (lane !== 'dependabot' || a.baseSha === b.baseSha)
/** @param {Awaited<ReturnType<typeof observe>>} after @param {AuthorizationRecord} record @param {string} body @param {boolean|undefined} conditional */
function confirmPublication(after, record, body, conditional) {
  const matches = after.comments.filter((c) => decode(c.body)?.operationId === record.operationId)
  if (matches.length !== 1 || matches[0].body !== body || !after.receipt) return
  if (after.receipt.id !== matches[0].id) {
    // No comment CAS: our write did not become the selected withdrawal.
    // In particular, do not remove a surviving grant's hint.
    return conditional ? null : undefined
  }
  if (record.kind === 'grant' ? after.allowed : after.reason === 'withdrawn') return after.receipt
}
/** @typedef {{github:Reader,writer:Writer,repo:Repo,policy:Policy,snapshot:Snapshot,record:AuthorizationRecord,requirePrevious:boolean}} Publication */
/** @overload @param {Publication & {conditional:true}} input @returns {Promise<import('./head-authorization-core.cjs').Receipt|null>} */
/** @overload @param {Publication & {conditional?:false}} input @returns {Promise<import('./head-authorization-core.cjs').Receipt>} */
/** @param {Publication & {conditional?:boolean}} input */
async function publish({
  github,
  writer,
  repo,
  policy,
  snapshot,
  record,
  requirePrevious,
  conditional,
}) {
  const input = { github, repo, prNumber: snapshot.pullRequest, policy }
  const before = await observe(input)
  if (conditional && before.receipt?.id !== record.previous) return null
  if (
    !sameScope(before.scope, snapshot, record.lane) ||
    (requirePrevious && before.previous !== snapshot.previous)
  )
    throw new Error('authorization snapshot or predecessor changed')
  const body = render(record)
  if (before.comments.some((c) => decode(c.body)?.operationId === record.operationId))
    throw new Error('authorization operation already exists')
  let writeError
  try {
    await writer.rest.issues.createComment({ ...repo, issue_number: snapshot.pullRequest, body })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof error.status === 'number' &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status < 500
    )
      throw error
    writeError = error
  }
  const receipt = confirmPublication(await observe(input), record, body, conditional)
  if (receipt === undefined)
    throw new Error(writeError ? 'ambiguous authorization write' : 'authorization write not active')
  return receipt
}
/** @param {{github:Reader,writer:Writer,repo:Repo,snapshot:Snapshot,policy:Policy,lane:string,source:string,evidence:string,operationId:string}} input @returns {Promise<import('./head-authorization-core.cjs').Receipt>} */
async function issueAuthorization({
  github,
  writer,
  repo,
  snapshot,
  policy,
  lane,
  source,
  evidence,
  operationId,
}) {
  const record = {
    version: 1,
    kind: 'grant',
    operationId,
    repositoryId: snapshot.repositoryId,
    pullRequestId: snapshot.pullRequestId,
    pullRequest: snapshot.pullRequest,
    headSha: snapshot.headSha,
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    lane,
    source,
    previous: snapshot.previous,
    evidence,
  }
  return publish({ github, writer, repo, snapshot, policy, record, requirePrevious: true })
}
/** @param {Snapshot} snapshot @param {string} operationId @param {string} reason @returns {AuthorizationRecord} */
function withdrawal(snapshot, operationId, reason) {
  return {
    version: 1,
    kind: 'withdraw',
    operationId,
    repositoryId: snapshot.repositoryId,
    pullRequestId: snapshot.pullRequestId,
    pullRequest: snapshot.pullRequest,
    headSha: snapshot.headSha,
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    lane: 'all',
    source: 'revoke',
    previous: snapshot.previous,
    evidence: reason,
  }
}
/** @param {Input & {writer:Writer,operationId:string,reason:string}} input */
async function withdrawAuthorization({
  github,
  writer,
  repo,
  prNumber,
  policy,
  operationId,
  reason,
}) {
  const snapshot = await captureAuthorization({ github, repo, prNumber, policy })
  return publish({
    github,
    writer,
    repo,
    snapshot,
    policy,
    record: withdrawal(snapshot, operationId, reason),
    requirePrevious: false,
  })
}
/** @param {unknown} value @param {string} field */
function timestamp(value, field) {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) {
    const time = Date.parse(value)
    if (Number.isFinite(time) && new Date(time).toISOString() === `${value.slice(0, -1)}.000Z`)
      return time
  }
  throw new Error(`invalid ${field} timestamp for event withdrawal`)
}
/** @param {Input & {writer:Writer,runId:number,action:'synchronize'|'reopened',runCreatedAt:unknown}} input */
async function withdrawAuthorizationForPrEvent({
  github,
  writer,
  repo,
  prNumber,
  policy,
  runId,
  action,
  runCreatedAt,
}) {
  if (!positive(runId) || (action !== 'synchronize' && action !== 'reopened'))
    throw new Error('invalid PR event for withdrawal')
  const cutoff = timestamp(runCreatedAt, 'workflow run creation')
  const state = await observe({ github, repo, prNumber, policy })
  if (state.receipt?.record?.kind !== 'grant') return null
  const target = state.comments.find(({ id }) => id === state.receipt?.id)
  if (timestamp(target?.created_at, 'comment creation') > cutoff) return null
  const snapshot = { ...state.scope, previous: state.receipt.id }
  const record = withdrawal(snapshot, `merge-revoke:event:${runId}`, `pull_request_${action}`)
  return publish({
    github,
    writer,
    repo,
    snapshot,
    policy,
    record,
    requirePrevious: false,
    conditional: true,
  })
}
module.exports = {
  policyFromEnv,
  captureAuthorization,
  readAuthorization,
  issueAuthorization,
  withdrawAuthorization,
  withdrawAuthorizationForPrEvent,
}
