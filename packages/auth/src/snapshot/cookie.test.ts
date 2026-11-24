import { createHmac, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySessionCookie } from './cookie'

const secret = randomUUID()
const name = ['__Secure-', 'product.session'].join('')
const token = ['product', randomUUID(), 'session'].join('.')
const signature = createHmac('sha256', secret).update(token).digest('base64')
const encoded = encodeURIComponent(`${token}.${signature}`)

describe('Better Auth session cookie verification', () => {
  it('verifies a percent-encoded padded Base64 signature at the final dot', async () => {
    await expect(verifySessionCookie({ header: `${name}=${encoded}`, name, secret })).resolves.toBe(
      token,
    )
    await expect(
      verifySessionCookie({ header: `${name}="${encoded}"; dont_remember=true`, name, secret }),
    ).resolves.toBe(token)
  })

  it('matches only the exact wire name and keeps the first duplicate even if malformed', async () => {
    await expect(
      verifySessionCookie({ header: `product.session=${encoded}`, name, secret }),
    ).resolves.toBeNull()
    await expect(
      verifySessionCookie({ header: `${name}=invalid; ${name}=${encoded}`, name, secret }),
    ).resolves.toBeNull()
    await expect(
      verifySessionCookie({ header: `other; ${name}=${encoded}; ${name}=invalid`, name, secret }),
    ).resolves.toBe(token)
  })

  it('refuses malformed cookies and invalid signatures without exposing a token', async () => {
    const headers = [
      null,
      `${name}=%GG`,
      `${name}=${token}`,
      `${name}=other.${signature}`,
      `${name}=${token}.${signature.slice(0, -1)}`,
      `${name}=${token}.${signature.slice(0, -2)}-=`,
    ]
    for (const header of headers)
      await expect(verifySessionCookie({ header, name, secret })).resolves.toBeNull()
    await expect(
      verifySessionCookie({ header: `${name}=${encoded}`, name, secret: randomUUID() }),
    ).resolves.toBeNull()
  })
})
