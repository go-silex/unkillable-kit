import { describe, expect, it, vi } from 'vitest'
import {
  assertEmailTransportAllowed,
  assertStagingEmailPolicy,
  buildDemoEmailText,
  buildInviteEmailText,
  buildMagicLinkEmailText,
  createEmailPort,
  createLogEmailPort,
  isRecipientDomainAllowed,
  isValidMailboxAddress,
  parseAllowDomains,
  prefixStagingSubject,
  redactEmailAddress,
  redactEmailBody,
  resolveEmailTransport,
  type SendEmailBinding,
  STAGING_SUBJECT_PREFIX,
  scrubHeaderLine,
} from './index'

/** Typed binding double: `send.mock.calls[0][0]` must carry the scrubbed message. */
type CfSendMessage = Parameters<SendEmailBinding['send']>[0]

function cfSendMock() {
  return vi.fn(async (_msg: CfSendMessage) => ({ messageId: 'mid_1' }))
}

describe('scrubHeaderLine', () => {
  it('collapses CR/LF/NEL/LS/PS to space and collapses runs', () => {
    expect(scrubHeaderLine('hi\r\nX-Injected: yes')).toBe('hi X-Injected: yes')
    expect(scrubHeaderLine('Acme\u2028Bcc: evil@x')).toBe('Acme Bcc: evil@x')
    expect(scrubHeaderLine('a\u0085b\u2029c')).toBe('a b c')
    expect(scrubHeaderLine('a  \r\n  b')).toBe('a b')
    expect(scrubHeaderLine('clean')).toBe('clean')
  })
})

describe('buildDemoEmailText', () => {
  it('builds subject and text', () => {
    const m = buildDemoEmailText({ to: 'a@b.c', subjectId: 'u1' })
    expect(m.to).toBe('a@b.c')
    expect(m.subject).toContain('u1')
    expect(m.text.length).toBeGreaterThan(0)
  })
})

describe('buildInviteEmailText', () => {
  it('builds subject with org name (header scrub is EmailPort responsibility)', () => {
    const m = buildInviteEmailText({
      to: 'a@b.c',
      locale: 'en',
      productName: 'Example',
      orgName: 'Acme',
      acceptUrl: 'http://localhost:5173/invite/accept?invitationId=inv_x',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      allowedOrigins: [],
      allowLoopbackHttp: true,
    })
    expect(m.subject).toContain('Acme')
    expect(m.html).toContain('Accept invitation')
  })
})

describe('buildMagicLinkEmailText', () => {
  it('builds subject and text with magic URL', () => {
    const m = buildMagicLinkEmailText({
      to: 'a@b.c',
      locale: 'en',
      productName: 'Example',
      magicUrl: 'http://localhost:8787/api/auth/magic-link/verify?token=abc',
      expiresHint: 'about 5 minutes',
      allowedOrigins: [],
      allowLoopbackHttp: true,
    })
    expect(m.to).toBe('a@b.c')
    expect(m.subject).toMatch(/sign in/i)
    expect(m.text).toContain('magic-link/verify')
    expect(m.html).toContain('href=')
  })

  it('rejects javascript href', () => {
    expect(() =>
      buildMagicLinkEmailText({
        to: 'a@b.c',
        locale: 'en',
        productName: 'Example',
        magicUrl: 'javascript:alert(1)',
        allowedOrigins: [],
      }),
    ).toThrow(/EMAIL_TOKEN_HREF_INVALID/)
  })
})

describe('redactEmailAddress', () => {
  it('masks local-part and keeps domain', () => {
    expect(redactEmailAddress('jane.doe@example.com')).toBe('j***@example.com')
    expect(redactEmailAddress('a@b.c')).toBe('*@b.c')
    expect(redactEmailAddress('not-an-email')).toBe('[redacted]')
  })
})

describe('redactEmailBody', () => {
  it('redacts token query and reset path', () => {
    const raw = [
      'Reset link: http://localhost:8787/api/auth/reset-password/UA3JP8XeqcwaIYm2RoiUZZLH?callbackURL=x',
      'Accept: http://localhost:5173/invite/accept?invitationId=inv_abc123def456ghi789jkl',
      'token=supersecrettokenvalue12345',
    ].join('\n')
    const red = redactEmailBody(raw)
    expect(red).not.toContain('UA3JP8XeqcwaIYm2RoiUZZLH')
    expect(red).not.toContain('inv_abc123def456ghi789jkl')
    expect(red).not.toContain('supersecrettokenvalue12345')
    expect(red).toContain('[REDACTED]')
  })
})

describe('createLogEmailPort (public product path — leaf redacts body)', () => {
  it('returns ok log transport and redacts body in console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = createLogEmailPort()
    const r = await port.send({
      to: 'a@b.c',
      subject: 'hi',
      text: 'token=supersecrettokenvalue12345',
    })
    expect(r).toEqual({ ok: true, transport: 'log' })
    const logged = String(spy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('[REDACTED]')
    expect(logged).not.toContain('supersecrettokenvalue12345')
    spy.mockRestore()
  })
})

describe('assertEmailTransportAllowed / resolveEmailTransport', () => {
  it('rejects log on production', () => {
    expect(() => assertEmailTransportAllowed('log', 'production')).toThrow(/forbidden/i)
    expect(() => assertEmailTransportAllowed('log', 'staging')).toThrow(/forbidden/i)
  })

  it('allows log on development|test', () => {
    expect(() => assertEmailTransportAllowed('log', 'development')).not.toThrow()
    expect(() => assertEmailTransportAllowed('log', 'test')).not.toThrow()
  })

  it('rejects smtp on Workers factory path', () => {
    expect(() => assertEmailTransportAllowed('smtp', 'development')).toThrow(/Node-only/i)
  })

  it('defaults transport by environment', () => {
    expect(resolveEmailTransport(undefined, 'test')).toBe('log')
    expect(resolveEmailTransport(undefined, 'development')).toBe('log')
    expect(() => resolveEmailTransport(undefined, 'production')).toThrow(/required/i)
    expect(resolveEmailTransport('cf', 'production')).toBe('cf')
    expect(() => resolveEmailTransport(undefined, undefined)).toThrow(/required/i)
    expect(() => resolveEmailTransport(undefined, '')).toThrow(/required/i)
    expect(() => assertEmailTransportAllowed('log', undefined)).toThrow(/forbidden/i)
  })
})

describe('parseAllowDomains / isRecipientDomainAllowed / isValidMailboxAddress', () => {
  it('parses comma list', () => {
    expect(parseAllowDomains('example.com, Client.example ,')).toEqual([
      'example.com',
      'client.example',
    ])
    expect(parseAllowDomains('')).toEqual([])
  })

  it('exact domain match only on a single valid mailbox', () => {
    expect(isRecipientDomainAllowed('a@example.com', ['example.com'])).toBe(true)
    expect(isRecipientDomainAllowed('a@evil-example.com', ['example.com'])).toBe(false)
    expect(isRecipientDomainAllowed('a@mail.example.com', ['example.com'])).toBe(false)
    expect(isRecipientDomainAllowed('a@client.io', ['example.com', 'client.io'])).toBe(true)
  })

  it('rejects multi-token / multi-@ / spaced tails (no last-@ spoof)', () => {
    expect(isValidMailboxAddress('a@example.com')).toBe(true)
    expect(isValidMailboxAddress('leak@evil.com @example.com')).toBe(false)
    expect(isValidMailboxAddress('a@evil.com,b@example.com')).toBe(false)
    expect(isValidMailboxAddress('a@b@example.com')).toBe(false)
    expect(isValidMailboxAddress('not-an-email')).toBe(false)
    expect(isRecipientDomainAllowed('leak@evil.com @example.com', ['example.com'])).toBe(false)
    expect(isRecipientDomainAllowed('a@evil.com,b@example.com', ['example.com'])).toBe(false)
  })
})

describe('assertStagingEmailPolicy', () => {
  it('requires allowlist + @example.com from on staging cf', () => {
    expect(() =>
      assertStagingEmailPolicy({
        transport: 'cf',
        environment: 'staging',
        from: 'noreply@example.com',
        allowDomains: [],
      }),
    ).toThrow(/EMAIL_ALLOW_DOMAINS/i)

    expect(() =>
      assertStagingEmailPolicy({
        transport: 'cf',
        environment: 'staging',
        from: 'noreply@other.com',
        allowDomains: ['example.com'],
      }),
    ).toThrow(/EMAIL_FROM must be @example.com/i)

    expect(() =>
      assertStagingEmailPolicy({
        transport: 'cf',
        environment: 'staging',
        from: 'noreply@example.com',
        allowDomains: ['example.com', 'client.test'],
      }),
    ).not.toThrow()
  })

  it('no-ops outside staging', () => {
    expect(() =>
      assertStagingEmailPolicy({
        transport: 'cf',
        environment: 'production',
        from: 'noreply@product.com',
        allowDomains: [],
      }),
    ).not.toThrow()
  })
})

describe('createEmailPort (product path — leaves not public)', () => {
  it('log port scrubs subject Unicode line terminators before console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = createLogEmailPort()
    await port.send({
      to: 'a@b.c',
      subject: 'Hi\u2028Bcc: evil@x',
      text: 'body',
    })
    const logged = JSON.parse(String(spy.mock.calls[0]?.[0] ?? '{}')) as {
      subject: string
      to: string
    }
    expect(logged.subject).toBe('Hi Bcc: evil@x')
    expect(logged.subject).not.toMatch(/\u2028/)
    // Recipient local-part redacted in log drain
    expect(logged.to).toBe('*@b.c')
    expect(logged.to).not.toBe('a@b.c')
    spy.mockRestore()
  })

  it('log port redacts full mailbox local-part (PII)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = createLogEmailPort()
    await port.send({
      to: 'jane.doe@example.com',
      subject: 'Hi',
      text: 'body',
    })
    const logged = JSON.parse(String(spy.mock.calls[0]?.[0] ?? '{}')) as { to: string }
    expect(logged.to).toBe('j***@example.com')
    expect(logged.to).not.toContain('jane.doe')
    spy.mockRestore()
  })

  it('cf port scrubs subject CR/LF and LS before binding.send', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'production',
      email: { send },
      from: 'noreply@example.com',
    })
    await port.send({
      to: 'user@example.com',
      subject: 'Invite\r\nX-Injected: yes\u2028more',
      text: 'hello',
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Invite X-Injected: yes more',
      }),
    )
    const arg = send.mock.calls[0]?.[0] as { subject: string }
    expect(arg.subject).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
  })

  it('cf port fails closed on multi-token to after scrub (no last-@ spoof to binding)', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'production',
      email: { send },
      from: 'noreply@example.com',
    })
    await expect(
      port.send({
        to: 'user@example.com\r\nBcc: evil@x',
        subject: 'Hi',
        text: 'hello',
      }),
    ).rejects.toThrow(/EMAIL_ADDRESS_INVALID/i)
    expect(send).not.toHaveBeenCalled()
  })

  it('cf port scrubs display name and keeps valid mailbox from/to', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'production',
      email: { send },
      from: { email: 'noreply@example.com', name: 'Kit\u2028Bcc' },
    })
    await port.send({
      to: 'user@example.com',
      subject: 'Hi\r\nX:1',
      text: 'hello',
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        from: { email: 'noreply@example.com', name: 'Kit Bcc' },
        subject: 'Hi X:1',
      }),
    )
  })

  it('cf port calls binding with from.email shape', async () => {
    const send = cfSendMock()
    const binding: SendEmailBinding = { send }
    const port = createEmailPort({
      transport: 'cf',
      environment: 'production',
      email: binding,
      from: { email: 'noreply@example.com', name: 'Kit' },
    })
    const r = await port.send({
      to: 'user@example.com',
      subject: 'Hi',
      text: 'hello',
      html: '<p>hello</p>',
    })
    expect(r.ok).toBe(true)
    expect(r.transport).toBe('cf')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        from: { email: 'noreply@example.com', name: 'Kit' },
        subject: 'Hi',
      }),
    )
  })

  it('staging cf enforces allowlist at send', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'staging',
      email: { send },
      from: 'noreply@example.com',
      allowDomains: ['example.com', 'acme-client.test'],
    })
    await expect(port.send({ to: 'leak@random.org', subject: 'x', text: 'y' })).rejects.toThrow(
      /EMAIL_RECIPIENT_DOMAIN_NOT_ALLOWED/i,
    )
    expect(send).not.toHaveBeenCalled()

    await port.send({ to: 'qa@example.com', subject: 'x', text: 'y' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('allowlist runs on scrubbed to (trailing LS still matches allowlist domain)', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'staging',
      email: { send },
      from: 'noreply@example.com',
      allowDomains: ['example.com'],
    })
    // Without scrub-before-allowlist, domain would be "example.com\u2028" → denied.
    // Scrub collapses LS → trim → domain example.com → allowed; leaf sends clean to.
    await port.send({ to: 'qa@example.com\u2028', subject: 'x', text: 'y' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ to: 'qa@example.com' }))

    await expect(port.send({ to: 'leak@random.org', subject: 'x', text: 'y' })).rejects.toThrow(
      /EMAIL_RECIPIENT_DOMAIN_NOT_ALLOWED/i,
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('allowlist fails closed on multi-@ / spoof tails (binding never called)', async () => {
    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'staging',
      email: { send },
      from: 'noreply@example.com',
      allowDomains: ['example.com'],
    })
    // Spoof / invalid shapes must hit the mailbox gate (not only domain mismatch).
    const spoofs = [
      'leak@evil.com @example.com',
      'leak@evil.com\r\n@example.com',
      'a@evil.com,b@example.com',
      'a@b@example.com',
      'not-an-email',
    ]
    for (const to of spoofs) {
      await expect(port.send({ to, subject: 'x', text: 'y' })).rejects.toThrow(
        /EMAIL_RECIPIENT_ADDRESS_INVALID/i,
      )
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('resend errors are code-only (no provider body)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('PROVIDER_SECRET_BODY', { status: 502 }))
    try {
      const port = createEmailPort({
        transport: 'resend',
        environment: 'production',
        from: 'noreply@example.com',
        resendApiKey: 're_test_key',
      })
      await expect(
        port.send({ to: 'user@example.com', subject: 'Hi', text: 'body' }),
      ).rejects.toThrow(/Resend send failed: 502/)
      await expect(
        port.send({ to: 'user@example.com', subject: 'Hi', text: 'body' }),
      ).rejects.not.toThrow(/PROVIDER_SECRET_BODY/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('resend factory fails closed without API key', () => {
    expect(() =>
      createEmailPort({
        transport: 'resend',
        environment: 'production',
        from: 'noreply@example.com',
      }),
    ).toThrow(/RESEND_API_KEY/i)
  })

  it('resend port scrubs headers and fails closed on multi-token to (fetch never called)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 're_1' }), { status: 200 }))
    try {
      const port = createEmailPort({
        transport: 'resend',
        environment: 'production',
        from: { email: 'noreply@example.com', name: 'Kit\u2028Bcc' },
        resendApiKey: 're_test_key',
      })

      await expect(
        port.send({
          to: 'leak@evil.com @example.com',
          subject: 'Hi\r\nX-Injected: yes',
          text: 'body',
        }),
      ).rejects.toThrow(/EMAIL_ADDRESS_INVALID/i)
      expect(fetchSpy).not.toHaveBeenCalled()

      await port.send({
        to: 'user@example.com',
        subject: 'Hi\r\nX-Injected: yes\u2028more',
        text: 'body',
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(String(init.body)) as {
        to: string[]
        subject: string
        from: string
      }
      expect(body.to).toEqual(['user@example.com'])
      expect(body.subject).toBe('Hi X-Injected: yes more')
      expect(body.subject).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
      // From display name must go through scrubEmailAddress (fails if Resend drops scrub)
      expect(body.from).toBe('Kit Bcc <noreply@example.com>')
      expect(body.from).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('staging prefixes subject with [TEST STAGING]', async () => {
    expect(prefixStagingSubject('Reset password')).toBe(`${STAGING_SUBJECT_PREFIX} Reset password`)
    expect(prefixStagingSubject('[TEST STAGING] already')).toBe('[TEST STAGING] already')

    const send = cfSendMock()
    const port = createEmailPort({
      transport: 'cf',
      environment: 'staging',
      email: { send },
      from: 'noreply@example.com',
      allowDomains: ['example.com'],
    })
    await port.send({ to: 'qa@example.com', subject: 'Invite to org', text: 'y' })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: `${STAGING_SUBJECT_PREFIX} Invite to org`,
      }),
    )
  })

  it('cf without binding fails closed', () => {
    expect(() =>
      createEmailPort({
        transport: 'cf',
        environment: 'production',
        from: 'noreply@example.com',
      }),
    ).toThrow(/binding/i)
  })
})
