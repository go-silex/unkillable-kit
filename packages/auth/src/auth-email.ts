/**
 * BA plugin email wiring — Kit templates or Product rendering, sent via EmailPort.
 */
import {
  assertSafeTokenHref,
  buildMagicLinkEmailText,
  buildResetPasswordEmailText,
  type EmailLocale,
  type EmailPort,
  type TokenHrefPolicy,
} from '@kit/email'

/** Same type as `@kit/email` EmailPort — do not fork the shape. */
export type AuthEmailPort = EmailPort

export const MAGIC_LINK_EXPIRES_IN_SEC = 300
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC = 3600

type AuthEmailRenderInput = {
  kind: 'magic-link' | 'reset-password'
  to: string
  url: string
  locale: EmailLocale
  productName: string
  expiresInSec: number
}

type AuthEmailContent = { subject: string; text: string; html: string }

/** Email language is resolved per recipient; unsupported preferences use the configured fallback. */
export type AuthEmailConfig = {
  productName: string
  fallbackLocale: EmailLocale
  resolveRecipientLocale: (
    email: string,
  ) => string | null | undefined | Promise<string | null | undefined>
  render?: (input: AuthEmailRenderInput) => AuthEmailContent | Promise<AuthEmailContent>
}

export type AuthEmailOptions =
  | { emailPort: AuthEmailPort; emailConfig: AuthEmailConfig }
  | { emailPort?: never; emailConfig?: never }

export function assertEmailConfig(emailPort?: AuthEmailPort, emailConfig?: AuthEmailConfig): void {
  if (emailPort && !emailConfig)
    throw new Error('emailConfig is required when emailPort is configured')
  if (emailConfig && !emailPort)
    throw new Error('emailPort is required when emailConfig is configured')
  if (emailConfig?.render !== undefined && typeof emailConfig.render !== 'function')
    throw new Error('emailConfig.render must be a function when configured')
}

type AuthEmailInput = {
  email: string
  url: string
  emailConfig: AuthEmailConfig
  expiresInSec?: number
} & TokenHrefPolicy

export async function resolveRecipientEmailLocale(
  config: AuthEmailConfig,
  email: string,
): Promise<EmailLocale> {
  const locale = await config.resolveRecipientLocale(email)
  return locale === 'en' || locale === 'fr' ? locale : config.fallbackLocale
}

async function sendAuthEmail(
  emailPort: AuthEmailPort,
  input: AuthEmailInput,
  kind: AuthEmailRenderInput['kind'],
  defaultExpiresInSec: number,
): Promise<void> {
  const { email, emailConfig } = input
  const locale = await resolveRecipientEmailLocale(emailConfig, email)
  const { productName, render } = emailConfig
  let message: AuthEmailContent & { to: string }
  if (render !== undefined) {
    const url = assertSafeTokenHref(input.url, input)
    try {
      const { subject, text, html } = await render({
        kind,
        to: email,
        url,
        locale,
        productName,
        expiresInSec: input.expiresInSec ?? defaultExpiresInSec,
      })
      if (typeof subject !== 'string' || typeof text !== 'string' || typeof html !== 'string')
        throw new TypeError('Expected string fields from renderer')
      message = { to: email, subject, text, html }
    } catch {
      // Renderer errors may contain the token URL. Do not forward the error or its cause.
      throw new Error('AUTH_EMAIL_RENDER_FAILED')
    }
  } else {
    const params = {
      to: email,
      magicUrl: input.url,
      resetUrl: input.url,
      productName,
      locale,
      allowedOrigins: input.allowedOrigins,
      allowLoopbackHttp: input.allowLoopbackHttp,
    }
    message =
      kind === 'magic-link' ? buildMagicLinkEmailText(params) : buildResetPasswordEmailText(params)
  }
  const sent = await emailPort.send(message)
  if (!sent.ok) throw new Error('email send returned not ok')
}

export function sendMagicLinkMail(emailPort: AuthEmailPort, input: AuthEmailInput): Promise<void> {
  return sendAuthEmail(emailPort, input, 'magic-link', MAGIC_LINK_EXPIRES_IN_SEC)
}

export function sendResetPasswordMail(
  emailPort: AuthEmailPort,
  input: AuthEmailInput,
): Promise<void> {
  return sendAuthEmail(emailPort, input, 'reset-password', RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC)
}
