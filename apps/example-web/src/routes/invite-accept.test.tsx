import { createRootRoute, createRoute, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import type { MeOrg } from '../lib/auth'
import { ensureMe, fetchMe, meQueryKey } from '../lib/auth'
import { configureImpersonation, refreshImpersonation } from '../lib/impersonation'
import { en } from '../messages/en'
import { createMe, createMeOrg } from '../test/factories'
import { createTestQueryClient } from '../test/query-client'
import { createTestRouter, renderWithAppProviders } from '../test/render'
import { InviteAcceptPage } from './invite-accept'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})
const api = vi.mocked(apiFetch)
const a = createMeOrg({ id: 'a', name: 'Alpha', slug: 'alpha' })
const b = createMeOrg({ id: 'b', name: 'Beta', slug: 'beta' })

beforeEach(() => localStorage.setItem('kit.locale', 'en'))
afterEach(() => {
  cleanup()
  api.mockReset()
})

function setup(orgs = [a]) {
  const qc = createTestQueryClient()
  qc.setQueryDefaults(meQueryKey, { staleTime: Infinity })
  qc.setQueryData(meQueryKey, createMe({ orgs }))
  const root = createRootRoute({ component: Outlet })
  const invite = createRoute({
    getParentRoute: () => root,
    path: '/invite/accept',
    validateSearch: (s: Record<string, unknown>) => ({
      invitationId: String(s.invitationId ?? ''),
    }),
    component: InviteAcceptPage,
  })
  const app = createRoute({
    getParentRoute: () => root,
    path: '/app',
    loader: () => ensureMe(qc),
    component: () => (
      <div>
        {app
          .useLoaderData()
          .orgs.map((org: MeOrg) => org.name)
          .join(', ')}
      </div>
    ),
  })
  const router = createTestRouter(
    root.addChildren([invite, app]),
    '/invite/accept?invitationId=inv_0123456789abcdef0123456789abcdef',
    qc,
  )
  const rendered = renderWithAppProviders(<RouterProvider router={router} />, { queryClient: qc })
  return { qc, router, ...rendered }
}

describe('invitation acceptance', () => {
  it.each([[[]], [[a]]])('refreshes cached memberships before the app gate (%s)', async (orgs) => {
    api.mockImplementation(async (path) =>
      path === '/api/me'
        ? createMe({ orgs: [...orgs, b] })
        : { org: b, membership: { role: 'member' } },
    )
    setup(orgs)
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    expect(
      await screen.findByText([...orgs, b].map((org) => org.name).join(', ')),
    ).toBeInTheDocument()
    expect(api.mock.calls.filter(([path]) => path === '/api/me')).toHaveLength(1)
  })

  it('retains acceptance retry on POST failure', async () => {
    api.mockRejectedValue(new Error('offline'))
    const { router } = setup()
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: en.inviteAcceptSubmit })).toBeEnabled(),
    )
    expect(router.state.location.pathname).toBe('/invite/accept')
    expect(api.mock.calls.filter(([path]) => path === '/api/me')).toHaveLength(0)
  })

  it('retries only the profile read after acceptance', async () => {
    let reads = 0
    api.mockImplementation(async (path) => {
      if (path !== '/api/me') return { org: b, membership: { role: 'member' } }
      if (++reads === 1) throw new Error('offline')
      return createMe({ orgs: [a, b] })
    })
    const { router } = setup()
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    expect(await screen.findByText(en.inviteRefreshFailed)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/invite/accept')
    await userEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText('Alpha, Beta')).toBeInTheDocument()
    expect(api.mock.calls.filter(([path]) => path !== '/api/me')).toHaveLength(1)
    expect(reads).toBe(2)
  })

  it('cancels an older profile read before refreshing', async () => {
    let resolveOld!: (value: ReturnType<typeof createMe>) => void
    const old = new Promise<ReturnType<typeof createMe>>((resolve) => {
      resolveOld = resolve
    })
    let reads = 0
    api.mockImplementation(async (path) => {
      if (path !== '/api/me') return { org: b, membership: { role: 'member' } }
      return ++reads === 1 ? old : createMe({ orgs: [a, b] })
    })
    const { qc } = setup()
    const stale = qc
      .fetchQuery({ queryKey: meQueryKey, queryFn: fetchMe, staleTime: 0 })
      .catch(() => undefined)
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    expect(await screen.findByText('Alpha, Beta')).toBeInTheDocument()
    resolveOld(createMe({ orgs: [a] }))
    await stale
    expect(qc.getQueryData(meQueryKey)).toEqual(createMe({ orgs: [a, b] }))
  })

  it('does not navigate after unmount while POST is pending', async () => {
    let resolvePost!: (value: unknown) => void
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )
    const { router, unmount } = setup()
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    unmount()
    resolvePost({ org: b, membership: { role: 'member' } })
    await Promise.resolve()
    expect(router.state.location.pathname).toBe('/invite/accept')
    expect(api.mock.calls.filter(([path]) => path === '/api/me')).toHaveLength(0)
  })
  it('does not apply an old acceptance after the invitation changes', async () => {
    let resolvePost!: (value: unknown) => void
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )
    const { router } = setup()
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    router.history.push('/invite/accept?invitationId=inv_ffffffffffffffffffffffffffffffff')
    await waitFor(() => expect(router.state.location.searchStr).toContain('ffffffff'))
    expect(await screen.findByRole('button', { name: en.inviteAcceptSubmit })).toBeEnabled()
    resolvePost({ org: b, membership: { role: 'member' } })
    await Promise.resolve()
    expect(router.state.location.pathname).toBe('/invite/accept')
    expect(api.mock.calls.filter(([path]) => path === '/api/me')).toHaveLength(0)
  })
  it('keeps accepted recovery when focus cancels the post-accept read', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise<unknown>((resolve) => {
      resolveOld = resolve
    })
    let reads = 0
    let firstSignal: AbortSignal | null | undefined
    api.mockImplementation(async (path, init) => {
      if (path !== '/api/me') return { org: b, membership: { role: 'member' } }
      reads += 1
      if (reads === 1) {
        firstSignal = init?.signal
        return old
      }
      if (reads === 2) throw new Error('offline')
      return createMe({ orgs: [a, b] })
    })
    const { qc, router } = setup()
    configureImpersonation(qc, async () => {})
    await userEvent.click(await screen.findByRole('button', { name: en.inviteAcceptSubmit }))
    await waitFor(() => expect(reads).toBe(1))
    window.dispatchEvent(new Event('focus'))
    await expect(refreshImpersonation()).rejects.toThrow('offline')
    expect(firstSignal?.aborted).toBe(true)
    expect(await screen.findByText(en.inviteRefreshFailed)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/invite/accept')
    resolveOld(createMe({ orgs: [a] }))
    await userEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText('Alpha, Beta')).toBeInTheDocument()
    expect(api.mock.calls.filter(([path]) => path !== '/api/me')).toHaveLength(1)
    expect(reads).toBe(3)
  })
})
