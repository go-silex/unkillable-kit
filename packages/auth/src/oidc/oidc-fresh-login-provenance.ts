import type { SecretConfig } from '@better-auth/core'
import { defineRequestState } from '@better-auth/core/context'

export const capsuleField = 'kit_authn_v1'
export const authorizePath = '/oauth2/authorize'
const bindingFields = [
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'nonce',
] as const
const freshnessFields = ['prompt', 'max_age', capsuleField, ...bindingFields]
const lifetime = 600_000
const encoder = new TextEncoder()

type Query = Record<string, unknown>
export type Freshness = { sinceStart: boolean; maxAge: number | null }
export type Authorization = {
  startedAt: number
  expiresAt: number | null
  freshness: Freshness | null
}

function exactBinding(baseURL: string, query: Query) {
  const values = bindingFields.map((name) => query[name] ?? null)
  if (values.some((value) => value !== null && typeof value !== 'string')) return
  return JSON.stringify([baseURL, ...values])
}

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/[=]+$/, '')
}

function bytes(encoded: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid encoding')
  return Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
}

export function freshnessFrom(query: Query): Freshness | null | undefined {
  if (query.prompt !== undefined && typeof query.prompt !== 'string') return
  const login =
    typeof query.prompt === 'string' &&
    query.prompt.split(' ').some((word) => word.trim() === 'login')
  const raw = query.max_age
  if (raw === undefined) return login ? { sinceStart: true, maxAge: null } : null
  if ((typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) && typeof raw !== 'number') return
  const age = Number(raw)
  if (!Number.isSafeInteger(age) || age < 0) return
  return { sinceStart: login || age === 0, maxAge: age === 0 ? null : age }
}

function tighten(freshness: Freshness | null, previous: Freshness | null | undefined) {
  if (!previous) return freshness
  if (!freshness) return previous
  const maxAge =
    freshness.maxAge === null
      ? previous.maxAge
      : previous.maxAge === null
        ? freshness.maxAge
        : Math.min(freshness.maxAge, previous.maxAge)
  return { sinceStart: freshness.sinceStart || previous.sinceStart, maxAge }
}

export function signedQuery(raw: string): Query | undefined {
  const params = new URLSearchParams(raw)
  if (freshnessFields.some((name) => params.getAll(name).length > 1)) return
  return Object.fromEntries(params)
}

async function keyFor(secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const derived = await crypto.subtle.sign('HMAC', key, encoder.encode('kit/oidc/authn/v1'))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function decodeCapsule(payload: string): Authorization | undefined {
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes(payload)))
  if (!Array.isArray(data) || data.length !== 4) return
  const [id, startedAt, sinceStart, maxAge]: unknown[] = data
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) return
  if (!isPositiveSafeInteger(startedAt)) return
  if (sinceStart === null && maxAge === null) return { startedAt, expiresAt: null, freshness: null }
  if (typeof sinceStart !== 'boolean') return
  if (maxAge !== null && !isPositiveSafeInteger(maxAge)) return
  if (!sinceStart && maxAge === null) return
  return { startedAt, expiresAt: startedAt + lifetime, freshness: { sinceStart, maxAge } }
}

export function createOidcProvenance() {
  const rawStarts = new WeakMap<Request, number>()
  const pinned = defineRequestState<string | undefined>(() => undefined)
  const keys = new Map<string, Promise<CryptoKey>>()
  function signingKey(secret: string) {
    let key = keys.get(secret)
    if (!key) {
      key = keyFor(secret)
      keys.set(secret, key)
    }
    return key
  }

  async function verifyRetainedMac(
    retained: SecretConfig,
    secret: string,
    signature: Uint8Array<ArrayBuffer>,
    message: BufferSource,
  ) {
    for (const candidate of retained.keys.values()) {
      if (candidate === secret) continue
      if (await crypto.subtle.verify('HMAC', await signingKey(candidate), signature, message))
        return true
    }
    const legacy = retained.legacySecret
    if (legacy === undefined || legacy === secret) return false
    return crypto.subtle.verify('HMAC', await signingKey(legacy), signature, message)
  }

  async function verifyMac(
    payload: string,
    mac: string,
    binding: string,
    secret: string,
    retained?: SecretConfig,
  ): Promise<boolean> {
    const signature = bytes(mac)
    if (base64(signature) !== mac) return false
    const message = encoder.encode(`${payload}.${binding}`)
    if (await crypto.subtle.verify('HMAC', await signingKey(secret), signature, message))
      return true
    return retained ? verifyRetainedMac(retained, secret, signature, message) : false
  }

  async function authenticate(
    capsule: unknown,
    binding: string | undefined,
    secret: string,
    retained?: SecretConfig,
  ): Promise<Authorization | undefined> {
    if (typeof capsule !== 'string' || capsule.length > 256 || !binding) return
    const [payload, mac, extra] = capsule.split('.')
    if (!(payload && mac) || extra !== undefined) return
    try {
      if (!(await verifyMac(payload, mac, binding, secret, retained))) return
      return decodeCapsule(payload)
    } catch {}
  }

  return {
    async capture(request: Request, baseURL: string) {
      const url = new URL(request.url)
      if (url.pathname !== `${new URL(baseURL).pathname.replace(/\/$/, '')}${authorizePath}`) return
      const startedAt = Date.now()
      let params: URLSearchParams | FormData
      if (request.method === 'GET') params = url.searchParams
      else if (
        request.method === 'POST' &&
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
          'application/x-www-form-urlencoded'
      ) {
        const form = await request
          .clone()
          .formData()
          .catch(() => undefined)
        if (!form) return
        params = form
      } else return
      const duplicate = freshnessFields.find((name) => params.getAll(name).length > 1)
      if (duplicate) {
        return {
          response: Response.json(
            { error: 'invalid_request', error_description: `${duplicate} must not be repeated` },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          ),
        }
      }
      rawStarts.set(request, startedAt)
    },
    takeStart(request: Request | undefined) {
      if (!request) return
      const start = rawStarts.get(request)
      rawStarts.delete(request)
      return start
    },
    async issue(
      query: Query,
      baseURL: string,
      secret: string,
      start: number,
      freshness: Freshness | null,
      secretConfig: string | SecretConfig = secret,
    ) {
      const binding = exactBinding(baseURL, query)
      if (!binding) return
      // Direct entry starts a new attempt, but a signed capsule can preserve
      // constraints removed from the provider's consent query.
      const incoming = query[capsuleField]
      // Retained keys can only preserve constraints, never resume a continuation.
      const retained = typeof secretConfig === 'string' ? undefined : secretConfig
      const previous =
        incoming === undefined ? undefined : await authenticate(incoming, binding, secret, retained)
      const policy = tighten(freshness, previous?.freshness)
      const id = base64(crypto.getRandomValues(new Uint8Array(16)))
      const payload = base64(
        encoder.encode(
          JSON.stringify([id, start, policy?.sinceStart ?? null, policy?.maxAge ?? null]),
        ),
      )
      const mac = await crypto.subtle.sign(
        'HMAC',
        await signingKey(secret),
        encoder.encode(`${payload}.${binding}`),
      )
      return `${payload}.${base64(new Uint8Array(mac))}`
    },
    async read(query: Query, baseURL: string, secret: string) {
      const authorization = await authenticate(
        query[capsuleField],
        exactBinding(baseURL, query),
        secret,
      )
      if (authorization?.expiresAt != null) {
        const now = Date.now()
        if (now < authorization.startedAt || now >= authorization.expiresAt) return
      }
      return authorization
    },
    pinned,
  }
}
