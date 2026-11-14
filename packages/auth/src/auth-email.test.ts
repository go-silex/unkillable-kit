import type { EmailPort } from '@kit/email'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { type AuthEmailPort, sendMagicLinkMail, sendResetPasswordMail } from './auth-email'

const LOOPBACK = 'http://localhost:8787/api/auth/magic-link/verify?token=abc'
const RESET = 'http://localhost:8787/api/auth/reset-password/token'
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
