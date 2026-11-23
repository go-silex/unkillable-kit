import type { EmailPort } from '@kit/email'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type AuthEmailConfig,
  type AuthEmailPort,
  sendMagicLinkMail,
  sendResetPasswordMail,
} from './auth-email'

const LOOPBACK = 'http://localhost:8787/api/auth/magic-link/verify?token=abc'
const RESET = 'http://localhost:8787/reset-password?token=token'
const emailConfig = {
  productName: 'Acme',
  fallbackLocale: 'en' as const,
  resolveRecipientLocale: () => undefined,
}

function recordingPort(): { port: AuthEmailPort; sent: Parameters<AuthEmailPort['send']>[0][] } {
  const sent: Parameters<AuthEmailPort['send']>[0][] = []
  return {
    sent,
    port: {
      async send(input) {
        sent.push(input)
        return { ok: true, transport: 'log' }
      },
    },
  }
}

describe('auth email wiring', () => {
  it('AuthEmailPort is EmailPort', () => {
    expectTypeOf<AuthEmailPort>().toEqualTypeOf<EmailPort>()
  })

  it('sends magic-link template through EmailPort', async () => {
    const { port, sent } = recordingPort()
    await sendMagicLinkMail(port, {
      email: 'a@b.c',
      emailConfig,
      url: LOOPBACK,
      allowedOrigins: [],
      allowLoopbackHttp: true,
    })
    expect(sent).toHaveLength(1)
    const msg = sent[0] as { to: string; subject: string; text: string; html?: string }
    expect(msg.to).toBe('a@b.c')
    expect(msg.subject).toMatch(/sign in/i)
    expect(msg.text).toContain('magic-link/verify')
    expect(msg.html).toContain('href=')
  })

  it('sends reset-password template through EmailPort', async () => {
    const { port, sent } = recordingPort()
    await sendResetPasswordMail(port, {
      email: 'a@b.c',
      emailConfig,
      url: RESET,
      allowedOrigins: [],
      allowLoopbackHttp: true,
    })
    const msg = sent[0] as { subject: string; text: string }
    expect(msg.subject.toLowerCase()).toMatch(/reset|password/)
    expect(msg.text).toContain('reset-password')
  })

  it('propagates port.send failure on magic-link and reset', async () => {
    const port: AuthEmailPort = {
      send: vi.fn(async () => {
        throw new Error('transport down')
      }),
    }
    await expect(
      sendMagicLinkMail(port, {
        email: 'a@b.c',
        emailConfig,
        url: LOOPBACK,
        allowedOrigins: [],
        allowLoopbackHttp: true,
      }),
    ).rejects.toThrow('transport down')
    await expect(
      sendResetPasswordMail(port, {
        email: 'a@b.c',
        emailConfig,
        url: RESET,
        allowedOrigins: [],
        allowLoopbackHttp: true,
      }),
    ).rejects.toThrow('transport down')
  })

  it('throws when EmailPort.ok is false', async () => {
    const port: AuthEmailPort = {
      send: vi.fn(async () => ({ ok: false, transport: 'log' })),
    }
    await expect(
      sendMagicLinkMail(port, {
        email: 'a@b.c',
        emailConfig,
        url: LOOPBACK,
        allowedOrigins: [],
        allowLoopbackHttp: true,
      }),
    ).rejects.toThrow(/not ok/)
  })

  it('rejects javascript and off-origin hrefs before send', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    const port: AuthEmailPort = { send }
    await expect(
      sendMagicLinkMail(port, {
        email: 'a@b.c',
        url: 'javascript:alert(1)',
        allowedOrigins: [],
        emailConfig,
      }),
    ).rejects.toThrow(/EMAIL_TOKEN_HREF_INVALID/)
    await expect(
      sendMagicLinkMail(port, {
        email: 'a@b.c',
        url: 'https://evil.test/x',
        allowedOrigins: [],
        emailConfig,
      }),
    ).rejects.toThrow(/EMAIL_TOKEN_HREF_INVALID/)
    expect(send).not.toHaveBeenCalled()
  })

  it('allows listed https origins', async () => {
    const { port, sent } = recordingPort()
    await sendMagicLinkMail(port, {
      email: 'a@b.c',
      emailConfig,
      url: 'https://api.example.com/api/auth/magic-link/verify?token=abc',
      allowedOrigins: ['https://api.example.com'],
      allowLoopbackHttp: false,
    })
    expect(sent).toHaveLength(1)
  })

  it('resolves each recipient locale, falling back only when no preference is returned', async () => {
    const { port, sent } = recordingPort()
    const resolveRecipientLocale = vi.fn(async (email: string) =>
      email === 'fr@example.com' ? ('fr' as const) : null,
    )
    const config = { productName: 'Acme', fallbackLocale: 'en' as const, resolveRecipientLocale }
    await sendMagicLinkMail(port, {
      email: 'fr@example.com',
      url: LOOPBACK,
      allowedOrigins: [],
      allowLoopbackHttp: true,
      emailConfig: config,
    })
    await sendResetPasswordMail(port, {
      email: 'en@example.com',
      url: RESET,
      allowedOrigins: [],
      allowLoopbackHttp: true,
      emailConfig: config,
    })
    expect(resolveRecipientLocale.mock.calls).toEqual([['fr@example.com'], ['en@example.com']])
    expect(sent[0]?.subject).toContain('Acme')
    expect(sent[0]?.subject).not.toMatch(/sign in/i)
    expect(sent[1]?.subject).toMatch(/reset|password/i)
    expect(sent[1]?.subject).toContain('Acme')
  })

  it.each(['FR', 'fr-FR', 'de', '', '__proto__', null, undefined])(
    'falls back for unsupported recipient locale %s in both emails',
    async (value) => {
      const { port, sent } = recordingPort()
      const config = { ...emailConfig, resolveRecipientLocale: () => value }
      await sendMagicLinkMail(port, {
        email: 'a@b.c',
        url: LOOPBACK,
        allowedOrigins: [],
        allowLoopbackHttp: true,
        emailConfig: config,
      })
      await sendResetPasswordMail(port, {
        email: 'a@b.c',
        url: RESET,
        allowedOrigins: [],
        allowLoopbackHttp: true,
        emailConfig: config,
      })
      expect(sent[0]?.subject).toMatch(/sign in/i)
      expect(sent[1]?.subject).toMatch(/reset|password/i)
    },
  )

  it('uses a French fallback for an unsupported recipient locale', async () => {
    const { port, sent } = recordingPort()
    await sendMagicLinkMail(port, {
      email: 'a@b.c',
      url: LOOPBACK,
      allowedOrigins: [],
      allowLoopbackHttp: true,
      emailConfig: { ...emailConfig, fallbackLocale: 'fr', resolveRecipientLocale: () => 'de' },
    })
    expect(sent[0]?.subject).not.toMatch(/sign in/i)
  })

  it('propagates locale resolver errors without sending', async () => {
    const send = vi.fn(async () => ({ ok: true, transport: 'log' }))
    await expect(
      sendMagicLinkMail(
        { send },
        {
          email: 'a@b.c',
          url: LOOPBACK,
          allowedOrigins: [],
          allowLoopbackHttp: true,
          emailConfig: {
            ...emailConfig,
            resolveRecipientLocale: () => {
              throw new Error('locale lookup failed')
            },
          },
        },
      ),
    ).rejects.toThrow('locale lookup failed')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('custom auth email rendering', () => {
  const cases = [
    { kind: 'magic-link', sendMail: sendMagicLinkMail, url: LOOPBACK, expiresInSec: 300 },
    { kind: 'reset-password', sendMail: sendResetPasswordMail, url: RESET, expiresInSec: 3600 },
  ] as const

  it.each(cases)(
    'sends the synchronous $kind result unchanged to the original recipient',
    async ({ kind, sendMail, url, expiresInSec }) => {
      const { port, sent } = recordingPort()
      const to = 'recipient@example.com'
      const message = {
        subject: ' Subject ',
        text: `See ${url}\n`,
        html: '<p>Custom &amp; HTML</p>',
      }
      const render = vi.fn(() => ({ ...message, to: 'other@example.com' }))

      await sendMail(port, {
        email: to,
        url,
        allowedOrigins: ['http://localhost:8787'],
        emailConfig: { ...emailConfig, render },
      })

      expect(render.mock.calls).toEqual([
        [{ kind, to, url, locale: 'en', productName: 'Acme', expiresInSec }],
      ])
      expect(sent).toEqual([{ to, ...message }])
    },
  )

  it.each(cases)(
    'does not render or send $kind when token-href policy rejects the URL',
    async ({ sendMail, url }) => {
      const { port, sent } = recordingPort()
      const render = vi.fn(() => ({ subject: 'Custom', text: '', html: '' }))
      const input = {
        email: 'recipient@example.com',
        emailConfig: { ...emailConfig, render },
        allowedOrigins: ['https://app.example.com'],
      }

      await expect(sendMail(port, { ...input, url })).rejects.toThrow('EMAIL_TOKEN_HREF_INVALID')
      await expect(
        sendMail(port, {
          ...input,
          url: 'https://other.example.com/token',
          allowLoopbackHttp: true,
        }),
      ).rejects.toThrow('EMAIL_TOKEN_HREF_INVALID')

      expect(render).not.toHaveBeenCalled()
      expect(sent).toEqual([])
    },
  )

  it.each([
    {
      ...cases[0],
      failure: 'throws',
      render: ({ url }) => {
        throw new Error(url)
      },
    },
    {
      ...cases[1],
      failure: 'rejects',
      render: ({ url }) => Promise.reject(new Error(url)),
    },
  ] satisfies ((typeof cases)[number] & {
    failure: string
    render: NonNullable<AuthEmailConfig['render']>
  })[])(
    'fails without sending or leaking the URL when the $kind renderer $failure',
    async ({ sendMail, url, render }) => {
      const { port, sent } = recordingPort()
      const sending = sendMail(port, {
        email: 'recipient@example.com',
        url,
        allowedOrigins: [],
        allowLoopbackHttp: true,
        emailConfig: { ...emailConfig, render },
      })
      await expect(sending).rejects.toHaveProperty('message', 'AUTH_EMAIL_RENDER_FAILED')
      await expect(sending).rejects.not.toHaveProperty('cause')
      expect(sent).toEqual([])
    },
  )
})
