import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { DEMO_EMAIL, DEMO_PASSWORD } from './seed/demo-data'
import { isAllowedMcpResumeUrl, resetIdentityTickets } from './services/mcp-identity-ticket'
import { loginCookie, seedDemoEnv } from './test/api-fixture'
import { createMemoryEnv } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'
const RESUME = 'http://127.0.0.1:8788/authorize?client_id=c1&state=s1'

async function loginAs(app: ReturnType<typeof createApp>, env: ReturnType<typeof createMemoryEnv>) {
  await seedDemoEnv(env, { notes: false, environment: 'test' })
  return loginCookie(app, env, DEMO_EMAIL, DEMO_PASSWORD, ORIGIN)
}

describe('MCP identity ticket', () => {
  afterEach(() => {
    resetIdentityTickets()
  })

  it('allowlists only loopback /authorize resumes', () => {
    expect(isAllowedMcpResumeUrl(RESUME)?.pathname).toBe('/authorize')
    expect(isAllowedMcpResumeUrl('https://evil.example/authorize')).toBeNull()
    expect(isAllowedMcpResumeUrl('http://127.0.0.1:8788/mcp')).toBeNull()
  })

  it('logged-out GET redirects to login and does not mint', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      `/api/mcp-identity/ticket?resume=${encodeURIComponent(RESUME)}`,
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe(
      `/mcp-oauth/resume?r=${encodeURIComponent(RESUME)}`,
    )
  })

  it('session mints a one-time ticket; redeem returns userId; second redeem fails', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env)
    const start = await app.request(
      `/api/mcp-identity/ticket?resume=${encodeURIComponent(RESUME)}`,
      { headers: { cookie } },
      env,
    )
    expect(start.status).toBe(302)
    const location = start.headers.get('location') ?? ''
    expect(location.startsWith('http://127.0.0.1:8788/authorize')).toBe(true)
    const ticket = new URL(location).searchParams.get('mcp_identity_ticket')
    expect(ticket).toBeTruthy()
    expect(ticket).toMatch(/^mct_/)

    const redeemed = await app.request(
      '/api/mcp-identity/ticket/redeem',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      },
      env,
    )
    expect(redeemed.status).toBe(200)
    const body = (await redeemed.json()) as { userId: string; email?: string }
    expect(body.userId).toBeTruthy()
    expect(body.email).toBe(DEMO_EMAIL)
    expect(JSON.stringify(body)).not.toMatch(/sk_/)
    expect(JSON.stringify(body)).not.toMatch(/access_token/)

    const again = await app.request(
      '/api/mcp-identity/ticket/redeem',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      },
      env,
    )
    expect(again.status).toBe(401)
  })

  it('Bearer sk_ is not a session and cannot mint a ticket', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request(
      `/api/mcp-identity/ticket?resume=${encodeURIComponent(RESUME)}`,
      { headers: { authorization: 'Bearer sk_not_a_session' } },
      env,
    )
    expect(res.status).toBe(401)
  })
})
