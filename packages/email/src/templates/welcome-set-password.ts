import { escapeHtml } from '../escape-html'
import { assertSafeTokenHref, type TokenHrefPolicy } from '../safe-token-href'
import { copy, type EmailTemplateOptions, templateValue } from './copy'

export function WelcomeSetPasswordEmail(
  props: {
    to: string
    setPasswordUrl: string
    expiresHint?: string
    name?: string
  } & TokenHrefPolicy &
    EmailTemplateOptions,
) {
  const c = copy[props.locale]
  const product = templateValue(props.productName)
  const href = assertSafeTokenHref(props.setPasswordUrl, props)
  const name = templateValue(props.name ?? '').trim() || c.fallbackName
  const greeting = c.greeting(name)
  const intro = c.welcomeIntro(product)
  const expiry = c.expiresIn(templateValue(props.expiresHint ?? c.oneHour))
  return {
    to: props.to,
    subject: c.welcomeSubject(product),
    text: [greeting, intro, `${c.welcomeAction}: ${href}`, expiry, c.ignoreWelcome].join('\n'),
    html: `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(c.welcomeAction)}</a></p><p>${escapeHtml(expiry)}</p><p>${escapeHtml(c.ignoreWelcome)}</p>`,
  }
}
