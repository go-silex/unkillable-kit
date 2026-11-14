/**
 * BA plugin email wiring — templates from `@kit/email`, send via EmailPort.
 * Products inject the port; they do not copy sendMagicLink / sendResetPassword.
 */
import {
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
/** Email language is resolved per recipient; missing preferences use the configured fallback. */
export type AuthEmailConfig = {
  productName: string
  fallbackLocale: EmailLocale
  resolveRecipientLocale: (
    email: string,
  ) => EmailLocale | null | undefined | Promise<EmailLocale | null | undefined>
}

type AuthEmailInput = { email: string; url: string; emailConfig: AuthEmailConfig } & TokenHrefPolicy

async function sendOrThrow(
  emailPort: EmailPort,
  tmpl: {
    to: string
    subject: string
    text: string
    html: string
  },
): Promise<void> {
  const sent = await emailPort.send({
    to: tmpl.to,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
  })
  if (!sent.ok) throw new Error('email send returned not ok')
}

export async function sendMagicLinkMail(
  emailPort: AuthEmailPort,
  input: AuthEmailInput,
): Promise<void> {
  const locale =
    (await input.emailConfig.resolveRecipientLocale(input.email)) ??
    input.emailConfig.fallbackLocale
  const tmpl = buildMagicLinkEmailText({
    to: input.email,
    magicUrl: input.url,
    productName: input.emailConfig.productName,
    locale,
    allowedOrigins: input.allowedOrigins,
    allowLoopbackHttp: input.allowLoopbackHttp,
  })
  await sendOrThrow(emailPort, tmpl)
}

export async function sendResetPasswordMail(
  emailPort: AuthEmailPort,
  input: AuthEmailInput,
): Promise<void> {
  const locale =
    (await input.emailConfig.resolveRecipientLocale(input.email)) ??
    input.emailConfig.fallbackLocale
  const tmpl = buildResetPasswordEmailText({
    to: input.email,
    resetUrl: input.url,
    productName: input.emailConfig.productName,
    locale,
    allowedOrigins: input.allowedOrigins,
    allowLoopbackHttp: input.allowLoopbackHttp,
  })
  await sendOrThrow(emailPort, tmpl)
}
