/**
 * @kit/email public surface (Workers-safe).
 *
 * Product path:
 * - `createEmailPort` / `createLogEmailPort` → EmailPort.send
 * - `build*EmailText` templates (one shape only; raw *Email not exported)
 *
 * Not exported here (by design):
 * - `sendCf` / `sendLog` leaves — use ports; Node may import sendLog via `@kit/email/server`
 * - raw template constructors — use build*EmailText
 */
import type { CfEmailAddress, SendEmailBinding } from './cf'
import { emailDomain } from './domain'
import { isLoopbackHost } from './loopback-host'
import {
  createCfEmailPort,
  createLogEmailPort,
  createResendEmailPort,
  withRecipientAllowlist,
  withStagingSubjectPrefix,
} from './ports'
import { assertSafeTokenHref, type TokenHrefPolicy } from './safe-token-href'
import { scrubHeaderLine } from './scrub'
import type { EmailTemplateOptions } from './templates/copy'
import { DemoEmail } from './templates/demo'
import { InviteEmail } from './templates/invite'
import { MagicLinkEmail } from './templates/magic-link'
import { ResetPasswordEmail } from './templates/reset-password'
import { WelcomeSetPasswordEmail } from './templates/welcome-set-password'
import type { EmailPort, EmailTransport } from './types'

export type { EmailLocale, EmailTemplateOptions } from './templates/copy'
export { EmailTemplateLocaleError } from './templates/copy'
export { EmailPolicyError } from './types'
export type { EmailPort, EmailTransport, TokenHrefPolicy }
export { assertSafeTokenHref, createLogEmailPort, isLoopbackHost }

/** Build a plain-text demo email body (React Email-style template). */
export function buildDemoEmailText(params: { to: string; subjectId: string }): {
  to: string
  subject: string
  text: string
  html: string
} {
  const mail = DemoEmail(params)
  return {
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  }
}

/** Org invite email (kit copy only). */
export function buildInviteEmailText(
  params: {
    to: string
    orgName: string
    acceptUrl: string
    expiresAt: Date
    inviterLabel?: string
  } & TokenHrefPolicy &
    EmailTemplateOptions,
): {
  to: string
  subject: string
  text: string
  html: string
} {
  const mail = InviteEmail(params)
  return {
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  }
}

/** Password reset email (kit copy only). */
export function buildResetPasswordEmailText(
  params: { to: string; resetUrl: string; expiresHint?: string } & TokenHrefPolicy &
    EmailTemplateOptions,
): {
  to: string
  subject: string
  text: string
  html: string
} {
  const mail = ResetPasswordEmail(params)
  return {
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  }
}

/** Welcome / first-login set-password email (kit copy only). */
export function buildWelcomeSetPasswordEmailText(
  params: {
    to: string
    setPasswordUrl: string
    expiresHint?: string
    name?: string
  } & TokenHrefPolicy &
    EmailTemplateOptions,
): {
  to: string
  subject: string
  text: string
  html: string
} {
  const mail = WelcomeSetPasswordEmail(params)
  return {
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  }
}

/** Magic-link sign-in email (kit copy only). */
export function buildMagicLinkEmailText(
  params: { to: string; magicUrl: string; expiresHint?: string } & TokenHrefPolicy &
    EmailTemplateOptions,
): {
  to: string
  subject: string
  text: string
  html: string
} {
  const mail = MagicLinkEmail(params)
  return {
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  }
}

/** Kit kit: staging From must be this domain (overridable via EMAIL_FROM_DOMAIN). */
export const DEFAULT_STAGING_FROM_DOMAIN = 'example.com'

/** Forced subject prefix on every staging send (real CF/resend). */
export const STAGING_SUBJECT_PREFIX = '[TEST STAGING]'

export type CreateEmailPortOpts = {
  transport: EmailTransport
  /** development | test | staging | production */
  environment?: string
  /** CF send_email binding (required when transport=cf). */
  email?: SendEmailBinding | null
  /** From address for cf/resend. */
  from?: CfEmailAddress
  /** Resend API key when transport=resend (Worker secret). */
  resendApiKey?: string
  /**
   * Recipient domain allowlist (exact match, lowercase).
   * Staging + cf|resend: **required** non-empty.
   * Production: optional; when set, enforced.
   */
  allowDomains?: string[] | null
  /**
   * Required domain for EMAIL_FROM (e.g. `example.com`).
   * Staging defaults to {@link DEFAULT_STAGING_FROM_DOMAIN} when unset.
   * Production: only enforced when explicitly set.
   */
  fromDomain?: string | null
}

function environmentName(environment?: string): string | undefined {
  const n = environment?.trim().toLowerCase()
  return n || undefined
}

/** Explicit env only — missing ENVIRONMENT is not development (parity with @kit/auth). */
function isDevLike(environment?: string): boolean {
  const e = environmentName(environment)
  return e === 'development' || e === 'test'
}

function isStaging(environment?: string): boolean {
  return environmentName(environment) === 'staging'
}

/** Parse `EMAIL_ALLOW_DOMAINS=a.com,b.com` → normalized unique list. */
export function parseAllowDomains(raw?: string | null): string[] {
  if (raw == null || raw.trim() === '') return []
  const out = new Set<string>()
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase().replace(/^\./, '')
    if (d.length > 0) out.add(d)
  }
  return [...out]
}

export { emailDomain, isRecipientDomainAllowed, isValidMailboxAddress } from './domain'

export function fromEmailString(from: CfEmailAddress): string {
  return typeof from === 'string' ? from : from.email
}

export function assertFromDomain(from: CfEmailAddress, fromDomain: string): void {
  const want = fromDomain.trim().toLowerCase().replace(/^\./, '')
  if (!want) return
  const got = emailDomain(fromEmailString(from))
  if (got !== want) {
    throw new Error(
      `EMAIL_FROM must be @${want} (got ${fromEmailString(from)}); set EMAIL_FROM or EMAIL_FROM_DOMAIN`,
    )
  }
}

/**
 * Fail closed: `log` is not allowed on staging/production.
 * `smtp` is never a Worker transport (Node `/server` only).
 */
export function assertEmailTransportAllowed(transport: EmailTransport, environment?: string): void {
  if (transport === 'smtp') {
    throw new Error(
      'EMAIL_TRANSPORT=smtp is Node-only (@kit/email/server) — not available on Workers',
    )
  }
  if (transport === 'log' && !isDevLike(environment)) {
    throw new Error(
      'EMAIL_TRANSPORT=log is forbidden when ENVIRONMENT is staging|production (ADR-0004)',
    )
  }
}

/**
 * Staging real-send policy (ADR-0004 D6):
 * - recipient allowlist required
 * - From domain = example.com (or EMAIL_FROM_DOMAIN)
 */
export function assertStagingEmailPolicy(opts: {
  transport: EmailTransport
  environment?: string
  from?: CfEmailAddress
  allowDomains?: string[] | null
  fromDomain?: string | null
}): void {
  if (!isStaging(opts.environment)) return
  if (opts.transport !== 'cf' && opts.transport !== 'resend') return

  const allow = opts.allowDomains ?? []
  if (allow.length === 0) {
    throw new Error(
      'EMAIL_ALLOW_DOMAINS is required when ENVIRONMENT=staging and EMAIL_TRANSPORT=cf|resend (comma-separated recipient domains)',
    )
  }

  if (opts.from == null) {
    throw new Error('EMAIL_FROM is required when ENVIRONMENT=staging and EMAIL_TRANSPORT=cf|resend')
  }

  const fromDomain = opts.fromDomain?.trim() || DEFAULT_STAGING_FROM_DOMAIN
  assertFromDomain(opts.from, fromDomain)
}

/**
 * Ensure subject starts with `[TEST STAGING]` (idempotent if already present).
 * Scrubs Unicode line terminators before concat so the prefix path cannot re-arm injection.
 */
export function prefixStagingSubject(subject: string): string {
  const s = scrubHeaderLine(subject).trimStart()
  const upper = s.toUpperCase()
  const prefixUpper = STAGING_SUBJECT_PREFIX.toUpperCase()
  if (upper.startsWith(prefixUpper)) return s
  return scrubHeaderLine(`${STAGING_SUBJECT_PREFIX} ${s}`)
}

/**
 * Worker-safe email port factory (ADR-0004).
 * - development|test: default callers usually pass transport=log
 * - staging|production: log rejected; cf requires binding; resend requires key
 * - staging + cf|resend: EMAIL_ALLOW_DOMAINS required; From @example.com; subject `[TEST STAGING]` (D6)
 */

function buildTransportPort(opts: CreateEmailPortOpts): EmailPort {
  if (opts.transport === 'log') {
    return createLogEmailPort()
  }
  if (opts.transport === 'cf') {
    if (!opts.email) {
      throw new Error('EMAIL_TRANSPORT=cf requires EMAIL send_email binding')
    }
    if (!opts.from) {
      throw new Error('EMAIL_TRANSPORT=cf requires EMAIL_FROM')
    }
    return createCfEmailPort(opts.email, opts.from)
  }
  if (opts.transport === 'resend') {
    if (!opts.resendApiKey?.trim()) {
      throw new Error('EMAIL_TRANSPORT=resend requires RESEND_API_KEY')
    }
    if (!opts.from) {
      throw new Error('EMAIL_TRANSPORT=resend requires EMAIL_FROM')
    }
    return createResendEmailPort(opts.resendApiKey.trim(), opts.from)
  }
  throw new Error(`Unsupported EMAIL_TRANSPORT: ${opts.transport}`)
}

export function createEmailPort(opts: CreateEmailPortOpts): EmailPort {
  assertEmailTransportAllowed(opts.transport, opts.environment)
  assertStagingEmailPolicy(opts)

  // Production optional From-domain pin (when EMAIL_FROM_DOMAIN set).
  if (
    environmentName(opts.environment) === 'production' &&
    opts.from != null &&
    opts.fromDomain?.trim()
  ) {
    assertFromDomain(opts.from, opts.fromDomain.trim())
  }

  const allow = (opts.allowDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)

  let port = buildTransportPort(opts)
  port = withRecipientAllowlist(port, allow)
  if (isStaging(opts.environment)) {
    port = withStagingSubjectPrefix(port, prefixStagingSubject)
  }
  return port
}

/**
 * Resolve transport string for an app environment.
 * development|test → default log; staging|production → require explicit cf|resend.
 */
export function resolveEmailTransport(
  raw: string | undefined,
  environment?: string,
): EmailTransport {
  const t = raw?.trim().toLowerCase()
  if (!t) {
    if (isDevLike(environment)) return 'log'
    throw new Error(
      'EMAIL_TRANSPORT is required when ENVIRONMENT is staging|production (use cf or resend)',
    )
  }
  if (t === 'log' || t === 'cf' || t === 'resend' || t === 'smtp') return t
  throw new Error(`Invalid EMAIL_TRANSPORT: ${raw}`)
}

export type { CfEmailAddress, SendEmailBinding } from './cf'
export { redactEmailAddress, redactEmailBody } from './redact'
export { scrubHeaderLine } from './scrub'
// Templates: build*EmailText only (raw *Email constructors stay package-private).
