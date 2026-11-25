import { AppError } from '@kit/core'
import type { Context, Env, MiddlewareHandler, Next } from 'hono'
import { accessAllows } from '../module-grants'
import {
  type AuthorizationProjection,
  isAuthorizationProjection,
  readAuthorizationProjection,
} from '../snapshot/facts'
import type { RequestSnapshot } from '../snapshot/load'
import {
  assertModule,
  type GuardState,
  MODULE_DENIAL,
  validateAdmittedFacts,
} from './authorization-admission'
import { type AuthorizationUse, authUnavailable, selectedOrganization } from './authorization-plan'

type AuthorityOptions = Readonly<{
  view: string
  projection: AuthorizationProjection
  header?: string
}>

const encoder = new TextEncoder()
const authorityDerivation = {
  name: 'HKDF',
  hash: 'SHA-256',
  salt: new Uint8Array(),
  info: encoder.encode('unkillable-kit/request-module-authority/v1'),
}
const hex = '0123456789abcdef'

async function authorityKey(secret: string, usage: 'sign' | 'verify') {
  const issuer = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    authorityDerivation,
    issuer,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [usage],
  )
}

function parseFingerprint(value: string | undefined) {
  if (value?.length !== 64 || /[^0-9a-f]/.test(value)) {
    throw AppError.validation('Invalid authority fingerprint')
  }
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index++) {
    const high = value.charCodeAt(index * 2)
    const low = value.charCodeAt(index * 2 + 1)
    bytes[index] = ((high > 57 ? high - 87 : high - 48) << 4) | (low > 57 ? low - 87 : low - 48)
  }
  return bytes
}

function admitAuthorityModule<E extends Env>(
  state: GuardState<E>,
  snapshot: RequestSnapshot,
  moduleId: string,
) {
  if (!(state.authenticated && state.fence)) throw AppError.unauthorized()
  const identity = snapshot.identity
  if (identity?.method !== 'session' || state.delegated || snapshot.delegation?.row) {
    throw AppError.forbidden('This route requires a session cookie')
  }
  const org = state.org
  if (!org) throw AppError.forbidden('Organization context required')
  const access = assertModule(
    state.plan.modules.get(moduleId),
    snapshot,
    org.bypass ? 'bypass' : 'normal',
    'read',
  )
  if (!(access && org.role) || org.bypass) {
    throw AppError.forbidden('Organization membership required')
  }
  return { subject: identity.subject, role: org.role, access }
}

function fingerprintPayload(
  snapshot: RequestSnapshot,
  projection: AuthorizationProjection,
  scope: readonly string[],
) {
  try {
    const canonicalProjection = readAuthorizationProjection(projection, snapshot.rows(projection))
    // JSON escapes newlines within the scope, so the separator uniquely frames the projection.
    return encoder.encode(`${JSON.stringify(scope)}\n${canonicalProjection}`)
  } catch {
    throw authUnavailable()
  }
}

async function authenticateFingerprint(
  secret: string,
  payload: Uint8Array<ArrayBuffer>,
  supplied?: Uint8Array<ArrayBuffer>,
) {
  try {
    const key = await authorityKey(secret, supplied ? 'verify' : 'sign')
    if (supplied) return await crypto.subtle.verify('HMAC', key, supplied, payload)
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload))
    let fingerprint = ''
    for (const byte of mac) fingerprint += hex[byte >>> 4]! + hex[byte & 15]!
    return fingerprint
  } catch {
    throw authUnavailable()
  }
}

function checkAuthorityPlacement<E extends Env>(
  c: Context<E>,
  state: GuardState<E>,
  middleware: MiddlewareHandler<E>,
) {
  const plan = state.plan.authority
  const authority = state.authority
  if (
    plan?.guard !== middleware ||
    plan.index !== c.req.routeIndex ||
    plan.pending.get(plan.index) !== middleware ||
    plan.pending.size !== 1 ||
    !authority
  ) {
    throw authUnavailable()
  }
  return { plan, authority }
}

async function admitFingerprint<E extends Env>(
  c: Context<E>,
  state: GuardState<E>,
  middleware: MiddlewareHandler<E>,
  op: 'read' | 'write',
  moduleId: string,
  view: string,
  projection: AuthorizationProjection,
  header: string,
) {
  const { plan, authority } = checkAuthorityPlacement(c, state, middleware)
  state.factsAdmitted = false
  const snapshot = await state.load
  const { subject, role, access } = admitAuthorityModule(state, snapshot, moduleId)
  if (!authority.secret) throw authUnavailable()
  const payload = fingerprintPayload(snapshot, projection, [
    subject,
    selectedOrganization(state.plan),
    moduleId,
    view,
    role,
    access,
  ])
  const supplied = op === 'write' ? parseFingerprint(c.req.header(header)) : undefined
  const result = await authenticateFingerprint(authority.secret, payload, supplied)
  if (result === false) throw AppError.conflict('Authority fingerprint changed')
  if (op === 'write' && !accessAllows(access, 'write')) {
    throw AppError.forbidden(MODULE_DENIAL.insufficientGrant)
  }
  plan.pending.delete(plan.index)
  state.plan.pending.delete(middleware)
  validateAdmittedFacts(state, snapshot)
  if (!state.factsAdmitted) throw authUnavailable()
  if (typeof result === 'string') authority.fingerprint = result
  return authority
}

export function bindModuleAuthority<E extends Env>(
  requests: WeakMap<Context<E>, GuardState<E>>,
  uses: WeakMap<MiddlewareHandler<E>, AuthorizationUse>,
  stateOf: (c: Context<E>) => GuardState<E>,
) {
  /** Replace a Module guard directly on each endpoint, after its other planned Kit guards. */
  return function moduleAuthority(
    moduleId: string,
    { view, projection, header = 'X-Authority-Fingerprint' }: AuthorityOptions,
  ) {
    if (
      typeof moduleId !== 'string' ||
      !moduleId.trim() ||
      typeof view !== 'string' ||
      !view.trim() ||
      typeof header !== 'string' ||
      !header ||
      /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(header) ||
      !isAuthorizationProjection(projection)
    ) {
      throw authUnavailable()
    }

    function guard(op: 'read' | 'write'): MiddlewareHandler<E> {
      const middleware = async (c: Context<E>, next: Next) => {
        const authority = await admitFingerprint(
          c,
          stateOf(c),
          middleware,
          op,
          moduleId,
          view,
          projection,
          header,
        )
        try {
          await next()
        } finally {
          delete authority.fingerprint
        }
      }
      uses.set(middleware, {
        org: true,
        module: moduleId,
        authority: projection,
        sessionOnly: true,
      })
      return middleware
    }

    const read = guard('read')
    const write = guard('write')
    function fingerprint(c: Context<E>): Promise<string> {
      const state = requests.get(c)
      const plan = state?.plan.authority
      const value = state?.authority?.fingerprint
      if (
        state?.factsAdmitted &&
        plan?.guard === read &&
        value &&
        !c.error &&
        c.req.routeIndex > plan.index &&
        c.req.routeIndex < state.plan.end
      ) {
        return Promise.resolve(value)
      }
      return Promise.reject(
        AppError.forbidden('Authority fingerprint is not admitted for this route'),
      )
    }

    return { read, write, fingerprint }
  }
}
