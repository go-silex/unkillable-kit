import { escapeHtml } from '../escape-html'
import { assertSafeTokenHref, type TokenHrefPolicy } from '../safe-token-href'
import { type EmailTemplateOptions, getTemplateCopy, templateValue } from './copy'

export function InviteEmail(
  props: {
    to: string
    orgName: string
    acceptUrl: string
    expiresAt: Date
    inviterLabel?: string
  } & TokenHrefPolicy &
    EmailTemplateOptions,
) {
  const c = getTemplateCopy(props.locale)
  const product = templateValue(props.productName)
  const org = templateValue(props.orgName)
  const inviter = props.inviterLabel ? templateValue(props.inviterLabel) : ''
  const href = assertSafeTokenHref(props.acceptUrl, props)
  const exp = props.expiresAt.toISOString()
  const intro = c.inviteIntro(org, product)
  const by = inviter ? c.invitedBy(inviter) : ''
  const expiry = c.expires(exp)
  return {
    to: props.to,
    subject: c.inviteSubject(org, product),
    text: [intro, by, c.acceptLink(href), expiry].filter(Boolean).join('\n'),
    html: `<p>${escapeHtml(intro)}</p>${by ? `<p>${escapeHtml(by)}</p>` : ''}<p><a href="${escapeHtml(href)}">${escapeHtml(c.accept)}</a></p><p>${escapeHtml(expiry)}</p>`,
  }
}
