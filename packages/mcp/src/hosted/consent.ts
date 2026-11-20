import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import type { McpIdentity } from '../identity'
import { CONSENT_STYLE } from './consent-style'
import { AUTHORIZE_PATH, isLoopbackHostname } from './host-policy'
import { normalizeIdentity } from './identity-props'
import { CONSENT_LABELS, type ResolvedConsentPresentation } from './presentation'

const CONSENT_KV_PREFIX = 'mcp_consent:'
const CONSENT_TTL_SECONDS = 600
/** `randomToken()` output: 16 bytes as hex. Anything else never reaches KV. */
const CONSENT_ID = /^[0-9a-f]{32}$/

/**
 * What the user was shown. The POST completes `request` with `scope`; it never
 * reads its own query, so consent stays bound to the client, redirect URI and
 * PKCE challenge on the page.
 */
export type ConsentRecord = {
  identity: McpIdentity
  csrf: string
  request: AuthRequest
  scope: string[]
}

type ConsentCookie = { name: string; attributes: string }

/** Loopback dev is plain http, so no `Secure`. Elsewhere `__Host-`: Secure, Path=/, no Domain. */
function consentCookie(requestUrl: URL): ConsentCookie {
  return isLoopbackHostname(requestUrl.hostname)
    ? { name: 'mcp_consent_id', attributes: `Path=${AUTHORIZE_PATH}; HttpOnly; SameSite=Lax` }
    : { name: '__Host-mcp_consent_id', attributes: 'Path=/; Secure; HttpOnly; SameSite=Lax' }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function consentKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${CONSENT_KV_PREFIX}${hex}`
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseAuthRequest(raw: unknown): AuthRequest | null {
  if (!raw || typeof raw !== 'object') return null
  if (!('clientId' in raw) || typeof raw.clientId !== 'string') return null
  if (!('redirectUri' in raw) || typeof raw.redirectUri !== 'string') return null
  return raw as AuthRequest
}

function parseConsent(raw: string): ConsentRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (!('csrf' in parsed) || typeof parsed.csrf !== 'string' || !parsed.csrf) return null
  if (!('scope' in parsed && isStringArray(parsed.scope))) return null
  const identity = normalizeIdentity('identity' in parsed ? parsed.identity : null)
  const request = parseAuthRequest('request' in parsed ? parsed.request : null)
  if (!(identity && request)) return null
  return { identity, csrf: parsed.csrf, request, scope: parsed.scope }
}

/** Constant-time comparison for the form csrf. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function putConsent(
  kv: KVNamespace,
  requestUrl: URL,
  record: Omit<ConsentRecord, 'csrf'>,
): Promise<{ csrf: string; cookie: string }> {
  const id = randomToken()
  const csrf = randomToken()
  await kv.put(await consentKey(id), JSON.stringify({ ...record, csrf }), {
    expirationTtl: CONSENT_TTL_SECONDS,
  })
  const { name, attributes } = consentCookie(requestUrl)
  return { csrf, cookie: `${name}=${id}; ${attributes}; Max-Age=${CONSENT_TTL_SECONDS}` }
}

export function clearConsentCookie(requestUrl: URL): string {
  const { name, attributes } = consentCookie(requestUrl)
  return `${name}=; ${attributes}; Max-Age=0`
}

/** Lookup is the consent-id cookie only. The form csrf is never a key. */
export async function readConsent(
  kv: KVNamespace,
  request: Request,
): Promise<(ConsentRecord & { key: string }) | null> {
  const { name } = consentCookie(new URL(request.url))
  const id = parseCookie(request.headers.get('Cookie'), name)
  if (!(id && CONSENT_ID.test(id))) return null
  const key = await consentKey(id)
  const raw = await kv.get(key)
  if (!raw) return null
  const record = parseConsent(raw)
  return record ? { ...record, key } : null
}

function consentPageHeaders(cookie: string, nonce: string, hasImages: boolean): Headers {
  const images = hasImages ? "; img-src 'self'" : ''
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'nonce-${nonce}'${images}`,
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': cookie,
  })
}

/** Hosts that only reach this machine: dotted 127/8 (as the provider matches it), IPv6 forms. */
const LOOPBACK_IP =
  /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/

/**
 * One truthful line per redirect class; a remote https redirect needs none. The
 * provider refuses remote http before a page is rendered, so it has no class here.
 */
function redirectWarning(redirect: URL, labels: (typeof CONSENT_LABELS)['en']): string {
  const host = redirect.hostname.toLowerCase().replace(/\.$/, '')
  if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') {
    return `<p class="warning"><strong>${labels.customSchemeBefore}${escapeHtml(redirect.protocol)}${labels.customSchemeAfter}</strong> ${labels.warningAdvice}</p>`
  }
  if (LOOPBACK_IP.test(host) || host === 'localhost' || host.endsWith('.localhost')) {
    return `<p class="warning"><strong>${labels.loopbackWarning}</strong> ${labels.warningAdvice}</p>`
  }
  return ''
}

/**
 * Names the client by its own label and by its id, and where the code goes.
 * Loopback and custom-scheme redirects each get their own warning.
 */
export function consentResponse(opts: {
  clientName: string
  clientId: string
  redirectUri: string
  email: string
  csrf: string
  cookie: string
  presentation?: ResolvedConsentPresentation
}): Response {
  const redirect = new URL(opts.redirectUri)
  const destination = redirect.host ? `${redirect.protocol}//${redirect.host}` : redirect.protocol
  const locale = opts.presentation?.locale === 'fr' ? 'fr' : 'en'
  const labels = CONSENT_LABELS[locale]
  const { serviceName, brand } = opts.presentation ?? {}
  const nonce = randomToken()
  const brandStyle = brand?.accentColor
    ? `\n:root { --accent: ${brand.accentColor}; --button-ink: ${brand.buttonInk}; }\n`
    : ''
  const logo = brand?.logoPath ? `<img class="logo" src="${brand.logoPath}" alt=""/>` : ''
  const backdrop = brand?.backdropPath
    ? `<img class="backdrop" src="${brand.backdropPath}" alt=""/>`
    : ''
  const classes = brand ? ` class="branded${brand.serifHeading ? ' serif' : ''}"` : ''
  const disclosures =
    opts.presentation?.disclosures
      ?.map(
        ({ label, text }) =>
          `    <p><strong>${escapeHtml(label)}</strong> ${escapeHtml(text)}</p>\n`,
      )
      .join('') ?? ''
  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${labels.title}</title>
    <style nonce="${nonce}">${CONSENT_STYLE}${brandStyle}</style>
  </head>
  <body>
    ${backdrop}
    <main${classes}>
      <header>
        ${logo}
        <h1>${labels.title}</h1>
        ${serviceName ? `<p class="service">${escapeHtml(serviceName)}</p>` : ''}
      </header>
      <div class="details">
        <p>${labels.signedInAs} ${escapeHtml(opts.email || labels.noEmail)}.</p>
        <p>${labels.client}: ${escapeHtml(opts.clientName || opts.clientId)}</p>
        <p>${labels.clientId}: <code>${escapeHtml(opts.clientId)}</code></p>
        <p>${labels.destination}: <strong>${escapeHtml(destination)}</strong></p>
        ${redirectWarning(redirect, labels)}
        ${disclosures}
      </div>
      <form method="post" action="${AUTHORIZE_PATH}">
        <input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}"/>
        <button type="submit" name="consent" value="yes">${labels.allow}</button>
        <button type="submit" name="consent" value="no">${labels.deny}</button>
      </form>
    </main>
  </body>
</html>`
  return new Response(html, {
    headers: consentPageHeaders(opts.cookie, nonce, !!(logo || backdrop)),
  })
}
