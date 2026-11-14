import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, createAppRouter } from './app'

const identity = {
  subject: 'user-1',
  email: 'person@example.test',
  authMethod: 'session',
  platformRole: null,
  orgs: [],
  impersonation: null,
  impersonationPermissions: { read: false, write: false },
  requestId: 'request-1',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mount(path: string) {
  window.history.replaceState(null, '', path)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<App router={createAppRouter()} queryClient={queryClient} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('starter web session', () => {
  it('redirects an anonymous visitor and signs in and out with cookies', async () => {
    let signedIn = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      expect(init?.credentials).toBe('include')
      if (path === '/api/me') return signedIn ? response(identity) : response({}, 401)
      if (path === '/api/auth/sign-in/email') {
        expect(JSON.parse(String(init?.body)).email).toBe(identity.email)
        signedIn = true
        return response({})
      }
      if (path === '/api/auth/sign-out') {
        signedIn = false
        return response({})
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    mount('/app')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), identity.email)
    await user.type(screen.getByLabelText('Password'), 'test')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Signed in as person@example.test')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/sign-out')).toBe(true)
  })

  it('keeps the login form on a rejected sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({}, 401)),
    )
    mount('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), identity.email)
    await user.type(screen.getByLabelText('Password'), 'test')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed. Please try again.')
  })

  it('exposes session errors and retries without treating them as anonymous', async () => {
    let available = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (available ? response(identity) : response({}, 503))),
    )
    mount('/app')
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load your session.')
    available = true
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Signed in as person@example.test')).toBeTruthy()
  })

  it('keeps the shell when sign-out fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/me' ? response(identity) : response({}, 503),
      ),
    )
    mount('/app')
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sign-out failed. Please try again.',
    )
    expect(screen.getByText('Signed in as person@example.test')).toBeTruthy()
  })
})
