// Copyright (c) UnkillableCompanies
// SPDX-License-Identifier: MIT
'use strict'
/** @typedef {{repositoryId:number, operatorIds:number[], appId:number, botUserId:number}} Policy */
/** @typedef {{repositoryId:number, pullRequestId:number, pullRequest:number, headSha:string, baseRef:string, baseSha:string, authorId:number}} Scope */
/** @typedef {{version:number, kind:string, operationId:string, repositoryId:number, pullRequestId:number, pullRequest:number, headSha:string, baseRef:string, baseSha:string, lane:string, source:string, previous:number|null, evidence:string}} AuthorizationRecord */
/** @typedef {{id:number, node_id:string, body:string, created_at?:string, user:{id:number,type:string}, performed_via_github_app:{id:number}|null}} Comment */
/** @typedef {{comment:Comment, issuer:'operator'|'machine'}} StreamEntry */
/** @typedef {{id:number, nodeId:string, repositoryId:number, pullRequestId:number, lastEditedAt:string|null}} Proof */
/** @typedef {{id:number, operationId:string|null, body:string, record:AuthorizationRecord|null}} Receipt */
/** @typedef {{allowed:true, receipt:Receipt & {record:AuthorizationRecord}, reason:null, previous:number} | {allowed:false, receipt:Receipt|null, reason:string, previous:number|null}} Projection */

const PREFIX = '<!-- kit-head-authorization:v1 -->\n'
const keys = [
  'version',
  'kind',
  'operationId',
  'repositoryId',
  'pullRequestId',
  'pullRequest',
  'headSha',
  'baseRef',
  'baseSha',
  'lane',
  'source',
  'previous',
  'evidence',
]
/** @param {unknown} n @returns {n is number} */
const positive = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
/** @param {unknown} s @returns {s is string} */
const bounded = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024
/** @param {unknown} s @returns {s is string} */
const sha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
/** @param {unknown} value @returns {value is AuthorizationRecord} */
function valid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = /** @type {Record<string, unknown>} */ (value)
  return (
    Object.keys(r).length === keys.length &&
    keys.every((k, i) => Object.keys(r)[i] === k) &&
    r.version === 1 &&
    bounded(r.operationId) &&
    positive(r.repositoryId) &&
    positive(r.pullRequestId) &&
    positive(r.pullRequest) &&
    sha(r.headSha) &&
    bounded(r.baseRef) &&
    sha(r.baseSha) &&
    (r.previous === null || positive(r.previous)) &&
    bounded(r.evidence) &&
    ((r.kind === 'withdraw' && r.lane === 'all' && r.source === 'revoke') ||
      (r.kind === 'grant' &&
        ((r.lane === 'reviewed' && (r.source === 'native' || r.source === 'manual')) ||
          (r.lane === 'dependabot' && r.source === 'dependabot'))))
  )
}
/** @param {AuthorizationRecord} record */
function render(record) {
  if (!valid(record)) throw new Error('invalid authorization record')
  return PREFIX + JSON.stringify(record)
}
/** @param {string} body @returns {AuthorizationRecord|null} */
function decode(body) {
  if (typeof body !== 'string' || !body.startsWith(PREFIX)) return null
  try {
    /** @type {unknown} */
    const record = JSON.parse(body.slice(PREFIX.length))
    return valid(record) && render(record) === body ? record : null
  } catch {
    return null
  }
}
/** @param {Comment} comment @param {Policy} policy @returns {'operator'|'machine'|null} */
function classifyIssuer(comment, policy) {
  const id = comment?.user?.id
  const app = comment?.performed_via_github_app?.id
  if (
    positive(id) &&
    policy.operatorIds.includes(id) &&
    comment.performed_via_github_app === null &&
    comment.user.type === 'User'
  )
    return 'operator'
  if (id === policy.botUserId && app === policy.appId && comment.user.type === 'Bot')
    return 'machine'
  return null
}
/** @param {Comment} comment */
function validateIssuerIdentity(comment) {
  if (
    typeof comment.body === 'string' &&
    comment.body.startsWith(PREFIX) &&
    (!positive(comment.user?.id) ||
      typeof comment.user?.type !== 'string' ||
      !Object.hasOwn(comment, 'performed_via_github_app') ||
      (comment.performed_via_github_app !== null &&
        !positive(comment.performed_via_github_app?.id)))
  ) {
    throw new Error('incomplete protocol issuer identity')
  }
}
/** @param {Comment[]} comments @param {Policy} policy */
function authenticatedStream(comments, policy) {
  if (!Array.isArray(comments)) throw new Error('incomplete authorization stream')
  let last = 0
  const stream = []
  for (const comment of comments) {
    if (!positive(comment.id) || comment.id <= last) throw new Error('invalid comment ordering')
    last = comment.id
    validateIssuerIdentity(comment)
    const issuer = classifyIssuer(comment, policy)
    if (issuer && typeof comment.body !== 'string') throw new Error('unreadable trusted comment')
    if (issuer && comment.body.startsWith(PREFIX)) stream.push({ comment, issuer })
  }
  return stream
}

// Only the new CI App records are conditional. Historical and explicit stops
// keep their original semantics, including for readers of protocol v1.
/** @param {AuthorizationRecord|null} record @param {StreamEntry['issuer']} issuer */
function eventWithdrawal(record, issuer) {
  return (
    issuer === 'machine' &&
    record?.kind === 'withdraw' &&
    /^merge-revoke:event:[1-9][0-9]*$/.test(record.operationId)
  )
}
/** @param {StreamEntry[]} stream */
function eventWithdrawalStart(stream) {
  let start = stream.length
  while (start > 0) {
    const { comment, issuer } = stream[start - 1]
    if (!eventWithdrawal(decode(comment.body), issuer)) break
    start--
  }
  return start
}
/** @param {Comment[]} comments @param {Policy} policy */
function authorizationProofTargets(comments, policy) {
  const stream = authenticatedStream(comments, policy)
  return stream.slice(Math.max(0, eventWithdrawalStart(stream) - 2)).map(({ comment }) => comment)
}
/** @param {Comment} comment @param {AuthorizationRecord|null} record */
function toReceipt(comment, record) {
  return { id: comment.id, operationId: record?.operationId ?? null, body: comment.body, record }
}
/** @param {StreamEntry[]} stream @param {number} index @param {string} operationId */
function duplicateOperation(stream, index, operationId) {
  for (let i = 0; i < index; i++) {
    if (decode(stream[i].comment.body)?.operationId === operationId) return true
  }
  return false
}
/** @param {AuthorizationRecord} record @param {Scope} scope */
function wrongPullRequest(record, scope) {
  return (
    record.repositoryId !== scope.repositoryId ||
    record.pullRequestId !== scope.pullRequestId ||
    record.pullRequest !== scope.pullRequest
  )
}
/** @param {Policy} policy @param {Scope} scope */
function validateContext(policy, scope) {
  if (
    !(
      policy &&
      positive(policy.repositoryId) &&
      positive(policy.appId) &&
      positive(policy.botUserId) &&
      Array.isArray(policy.operatorIds) &&
      policy.operatorIds.length &&
      policy.operatorIds.every(positive)
    ) ||
    new Set(policy.operatorIds).size !== policy.operatorIds.length
  )
    throw new Error('invalid authorization policy')
  if (
    !scope ||
    scope.repositoryId !== policy.repositoryId ||
    !positive(scope.pullRequestId) ||
    !positive(scope.pullRequest) ||
    !positive(scope.authorId) ||
    !sha(scope.headSha) ||
    !sha(scope.baseSha) ||
    !bounded(scope.baseRef)
  )
    throw new Error('invalid authorization scope')
}
/** @param {AuthorizationRecord} record @param {Scope} scope */
function scopeMismatch(record, scope) {
  return (
    wrongPullRequest(record, scope) ||
    record.headSha !== scope.headSha ||
    record.baseRef !== scope.baseRef
  )
}
/** @param {AuthorizationRecord} record @param {'operator'|'machine'} issuer @param {Scope} scope */
function issuerMismatch(record, issuer, scope) {
  return (
    (record.lane === 'reviewed' && issuer !== 'operator') ||
    (record.lane === 'dependabot' &&
      (issuer !== 'machine' || scope.authorId !== 49699333 || record.baseSha !== scope.baseSha))
  )
}
/** @param {StreamEntry[]} stream @param {Scope} scope @param {(c:Comment,requireUnedited:boolean)=>unknown} proof */
function selectAuthorization(stream, scope, proof) {
  const start = eventWithdrawalStart(stream)
  let index = start - 1
  for (let i = start; i < stream.length; i++) {
    const { comment } = stream[i]
    const record = decode(comment.body)
    if (!record) return { index: i, reason: 'malformed authorization' }
    if (duplicateOperation(stream, i, record.operationId))
      return { index: i, reason: 'duplicate operation ID' }
    if (!proof(comment, true))
      return { index: i, reason: 'unproven authorization association or edit' }
    if (wrongPullRequest(record, scope)) return { index: i, reason: 'authorization scope mismatch' }
    if (record.previous === (stream[index]?.comment.id ?? null)) index = i
    else if (
      !stream.some(({ comment: prior }) => prior.id < comment.id && prior.id === record.previous)
    )
      return { index: i, reason: 'predecessor conflict' }
  }
  return { index, reason: null }
}

/** @param {{comments:Comment[], policy:Policy, scope:Scope, proofs:Record<number,Proof>}} input @returns {Projection} */
function project({ comments, policy, scope, proofs }) {
  validateContext(policy, scope)
  const stream = authenticatedStream(comments, policy)
  const previous = stream.at(-1)?.comment.id ?? null
  if (previous === null)
    return { allowed: false, receipt: null, reason: 'no authorization', previous }
  /** @param {Comment} c @param {boolean} requireUnedited */
  const proof = (c, requireUnedited) => {
    const p = proofs?.[c.id]
    return (
      p &&
      typeof c.node_id === 'string' &&
      c.node_id.length > 0 &&
      p.id === c.id &&
      p.nodeId === c.node_id &&
      p.repositoryId === scope.repositoryId &&
      p.pullRequestId === scope.pullRequestId &&
      (p.lastEditedAt === null || typeof p.lastEditedAt === 'string') &&
      (!requireUnedited || p.lastEditedAt === null)
    )
  }
  const { index, reason } = selectAuthorization(stream, scope, proof)
  if (index < 0) return { allowed: false, receipt: null, reason: 'no authorization', previous }
  const { comment, issuer } = stream[index]
  const record = decode(comment.body)
  const receipt = toReceipt(comment, record)
  /** @param {string} reason @returns {Projection} */
  const hold = (reason) => ({ allowed: false, receipt, reason, previous })
  if (reason) return hold(reason)
  if (!record) return hold('malformed authorization')
  if (duplicateOperation(stream, index, record.operationId)) return hold('duplicate operation ID')
  if (!proof(comment, true)) return hold('unproven authorization association or edit')
  if (scopeMismatch(record, scope)) return hold('authorization scope mismatch')
  if (record.kind === 'withdraw') return hold('withdrawn')
  if (issuerMismatch(record, issuer, scope)) return hold('issuer or baseline mismatch')
  // Grant publication still compares against the physical stream tip, even if
  // a later conditional withdrawal does not replace the selected grant.
  const predecessor = stream[index - 1]
  if (record.previous !== (predecessor?.comment.id ?? null)) return hold('predecessor conflict')
  if (predecessor && !proof(predecessor.comment, false)) return hold('predecessor unproven')
  return { allowed: true, receipt: { ...receipt, record }, reason: null, previous }
}
module.exports = { PREFIX, render, decode, classifyIssuer, authorizationProofTargets, project }
