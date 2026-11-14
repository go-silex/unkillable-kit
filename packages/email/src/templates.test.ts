import { describe, expect, it } from 'vitest'
import {
  buildInviteEmailText,
  buildMagicLinkEmailText,
  buildResetPasswordEmailText,
  buildWelcomeSetPasswordEmailText,
  type EmailLocale,
} from './index'
import { copy, EmailTemplateLocaleError } from './templates/copy'

const href = 'https://example.com/action?token=abc&next=home'
const policy = { allowedOrigins: ['https://example.com'] }

function messages(locale: EmailLocale, value = 'Example') {
  const common = { to: 'person@example.com', locale, productName: value, ...policy }
  return [
    buildInviteEmailText({
      ...common,
      orgName: value,
      inviterLabel: value,
      acceptUrl: href,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    }),
    buildMagicLinkEmailText({ ...common, magicUrl: href, expiresHint: value }),
    buildResetPasswordEmailText({ ...common, resetUrl: href, expiresHint: value }),
    buildWelcomeSetPasswordEmailText({
      ...common,
      setPasswordUrl: href,
      name: value,
      expiresHint: value,
    }),
  ]
}

describe.each(['en', 'fr'] as const)('transactional templates: %s', (locale) => {
  it('renders each localized subject, text, and HTML with product and safe link', () => {
    const mails = messages(locale)
    const expected =
      locale === 'en'
        ? ['Invitation', 'Sign in', 'Reset your password', 'Welcome']
        : ['Invitation', 'Connexion', 'Réinitialiser votre mot de passe', 'Bienvenue']
    mails.forEach((mail, index) => {
      expect(mail.subject).toContain(expected[index])
      expect(mail.subject).toContain('Example')
      expect(mail.text).toContain(href)
      expect(mail.html).toContain('href="https://example.com/action?token=abc&amp;next=home"')
      expect(mail.html).toContain('Example')
    })
  })

  it('escapes interpolations and flattens injected line breaks', () => {
    for (const mail of messages(locale, '<img src="x">\r\nBcc: attacker@example.com')) {
      expect(mail.subject).not.toMatch(/[\r\n]/)
      expect(mail.text).not.toContain('\r')
      expect(mail.text).not.toContain('\nBcc:')
      expect(mail.html).not.toContain('<img')
      expect(mail.html).toContain('&lt;img src=&quot;x&quot;&gt;')
    }
  })

  it('rejects unsafe token links in every template', () => {
    const common = { to: 'person@example.com', locale, productName: 'Example', ...policy }
    const bad = 'javascript:alert(1)'
    const calls = [
      () =>
        buildInviteEmailText({
          ...common,
          orgName: 'Org',
          acceptUrl: bad,
          expiresAt: new Date('2030-01-01'),
        }),
      () => buildMagicLinkEmailText({ ...common, magicUrl: bad }),
      () => buildResetPasswordEmailText({ ...common, resetUrl: bad }),
      () => buildWelcomeSetPasswordEmailText({ ...common, setPasswordUrl: bad }),
    ]
    for (const call of calls) expect(call).toThrow('EMAIL_TOKEN_HREF_INVALID')
  })

  it('localizes default expiration and unnamed greeting', () => {
    const common = { to: 'person@example.com', locale, productName: 'Example', ...policy }
    const magic = buildMagicLinkEmailText({ ...common, magicUrl: href })
    const welcome = buildWelcomeSetPasswordEmailText({ ...common, setPasswordUrl: href })
    expect(magic.text).toContain(locale === 'fr' ? 'environ 5 minutes' : 'about 5 minutes')
    expect(welcome.text).toContain(locale === 'fr' ? 'environ 1 heure' : 'about 1 hour')
    expect(welcome.text).toContain(locale === 'fr' ? 'Bonjour' : 'Hi there')
  })
})

function assertCompleteCatalogs(
  catalogs: Record<'en' | 'fr', Record<string, string | ((...args: string[]) => string)>>,
) {
  const keys = Object.keys(catalogs.en).sort()
  expect(Object.keys(catalogs.fr).sort()).toEqual(keys)
  for (const key of keys) {
    expect(typeof catalogs.fr[key]).toBe(typeof catalogs.en[key])
    for (const locale of ['en', 'fr'] as const) {
      const value = catalogs[locale][key]
      expect(['string', 'function']).toContain(typeof value)
      const text = typeof value === 'function' ? value('example', 'example') : value
      expect(typeof text).toBe('string')
      expect(text.trim().length).toBeGreaterThan(0)
    }
  }
}

describe('locale catalog contract', () => {
  it('has matching keys and nonempty strings and function results', () => {
    assertCompleteCatalogs(copy)
  })

  it('detects missing keys and empty values in either catalog', () => {
    for (const locale of ['en', 'fr'] as const) {
      const missing = { ...copy[locale] } as Record<
        string,
        string | ((...args: string[]) => string)
      >
      delete missing.accept
      expect(() => assertCompleteCatalogs({ ...copy, [locale]: missing })).toThrow()
      expect(() =>
        assertCompleteCatalogs({ ...copy, [locale]: { ...copy[locale], accept: '  ' } }),
      ).toThrow()
      expect(() =>
        assertCompleteCatalogs({ ...copy, [locale]: { ...copy[locale], inviteSubject: () => '' } }),
      ).toThrow()
    }
  })
})

it('rejects invalid runtime locales with a named error in every template', () => {
  for (const locale of ['de', '__proto__', '', undefined] as unknown as EmailLocale[]) {
    const common = { to: 'person@example.com', locale, productName: 'Example', ...policy }
    const calls = [
      () =>
        buildInviteEmailText({
          ...common,
          orgName: 'Org',
          acceptUrl: href,
          expiresAt: new Date('2030-01-01'),
        }),
      () => buildMagicLinkEmailText({ ...common, magicUrl: href }),
      () => buildResetPasswordEmailText({ ...common, resetUrl: href }),
      () => buildWelcomeSetPasswordEmailText({ ...common, setPasswordUrl: href }),
    ]
    for (const call of calls) {
      expect(call).toThrow(EmailTemplateLocaleError)
      expect(call).toThrow('EMAIL_LOCALE_INVALID')
    }
  }
})

it('uses French spacing for each complete link line', () => {
  const lines = [
    'Accepter l’invitation',
    'Lien de connexion',
    'Lien de réinitialisation',
    'Créer votre mot de passe',
  ]
  messages('fr').forEach((mail, index) => {
    expect(mail.text.split('\n')).toContain(`${lines[index]} : ${href}`)
  })
})
