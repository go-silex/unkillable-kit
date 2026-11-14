import { escapeHtml } from '../escape-html'
import { assertSafeTokenHref, type TokenHrefPolicy } from '../safe-token-href'
import { copy, type EmailTemplateOptions, templateValue } from './copy'

export function MagicLinkEmail(
  props: { to: string; magicUrl: string; expiresHint?: string } & TokenHrefPolicy &
    EmailTemplateOptions,
) {
  const c = copy[props.locale]
  const product = templateValue(props.productName)
  const href = assertSafeTokenHref(props.magicUrl, props)
  const intro = c.magicIntro(product)
  const expiry = c.expiresIn(templateValue(props.expiresHint ?? c.fiveMinutes))
  return {
    to: props.to,
    subject: c.magicSubject(product),
    text: [intro, `${c.magicLinkLabel}: ${href}`, expiry, c.ignoreRequest].join('\n'),
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(c.magicAction)}</a></p><p>${escapeHtml(expiry)}</p><p>${escapeHtml(c.ignoreRequest)}</p>`,
  }
}
