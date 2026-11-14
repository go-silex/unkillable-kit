import { escapeHtml } from '../escape-html'
import { assertSafeTokenHref, type TokenHrefPolicy } from '../safe-token-href'
import { copy, type EmailTemplateOptions, templateValue } from './copy'

export function ResetPasswordEmail(
  props: { to: string; resetUrl: string; expiresHint?: string } & TokenHrefPolicy &
    EmailTemplateOptions,
) {
  const c = copy[props.locale]
  const product = templateValue(props.productName)
  const href = assertSafeTokenHref(props.resetUrl, props)
  const intro = c.resetIntro(product)
  const expiry = c.expiresIn(templateValue(props.expiresHint ?? c.oneHour))
  return {
    to: props.to,
    subject: c.resetSubject(product),
    text: [intro, `${c.resetLinkLabel}: ${href}`, expiry, c.ignoreRequest].join('\n'),
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(c.resetAction)}</a></p><p>${escapeHtml(expiry)}</p><p>${escapeHtml(c.ignoreRequest)}</p>`,
  }
}
