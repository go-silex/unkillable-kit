import { createRootRoute, createRoute, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import { createMe, createMeOrg } from '../test/factories'
import { createTestQueryClient } from '../test/query-client'
import { createTestRouter, renderWithAppProviders } from '../test/render'
import { OrgMembersPage } from './org-members'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

it.each(['resolve', 'reject'] as const)(
  'isolates B draft and pending grant when A %s after a route switch',
  async (outcome) => {
    let finishA!: (value: unknown) => void
    let rejectA!: (error: unknown) => void
    let finishB!: (value: unknown) => void
    const a = new Promise<unknown>((resolve, reject) => {
      finishA = resolve
      rejectA = reject
    })
    const b = new Promise<unknown>((resolve) => {
      finishB = resolve
    })
    const orgs = ['a', 'b'].map((id) => createMeOrg({ id, name: id, slug: id, role: 'admin' }))
    const me = createMe({ orgs })
    const roles = {
      roles: [
        {
          id: 'r',
          key: 'custom',
          name: 'Custom',
          isSystem: false,
          grants: [{ moduleId: 'notes', access: 'read' }],
        },
      ],
    }
    const qc = createTestQueryClient()
    qc.setQueryData(['me'], me)
    for (const org of ['a', 'b']) {
      qc.setQueryData(['org-roles', org], roles)
      qc.setQueryData(['org-members', org], { members: [] })
      qc.setQueryData(['org-invitations', org], { invitations: [] })
    }
    vi.mocked(apiFetch).mockImplementation((path, init) => {
      if (init?.method === 'PATCH') return path.includes('/a/') ? a : b
      if (path === '/api/me') return Promise.resolve(me)
      if (path.endsWith('/roles')) return Promise.resolve(roles)
      if (path.endsWith('/members')) return Promise.resolve({ members: [] })
      if (path.endsWith('/invitations')) return Promise.resolve({ invitations: [] })
      throw new Error(`unexpected ${path}`)
    })
    const root = createRootRoute()
    const route = createRoute({
      getParentRoute: () => root,
      path: '/app/orgs/$orgId/members',
      component: OrgMembersPage,
    })
    const router = createTestRouter(root.addChildren([route]), '/app/orgs/a/members', qc)
    const view = renderWithAppProviders(<RouterProvider router={router} />, { queryClient: qc })
    const user = userEvent.setup()
    const grant = await view.findByRole('combobox', { name: /notes/i })
    fireEvent.change(view.getByPlaceholderText('lead'), { target: { value: 'draft-a' } })
    await user.click(grant)
    await user.click(await view.findByRole('option', { name: /write/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/orgs/a/roles/r/grants/notes', expect.anything()),
    )
    await act(async () => {
      await router.navigate({ to: '/app/orgs/$orgId/members', params: { orgId: 'b' } })
    })
    await waitFor(() =>
      expect((view.getByPlaceholderText('lead') as HTMLInputElement).value).toBe(''),
    )
    fireEvent.change(view.getByPlaceholderText('lead'), { target: { value: 'draft-b' } })
    const bGrant = await view.findByRole('combobox', { name: /notes/i })
    expect(bGrant.textContent).toMatch(/read/i)
    await user.click(bGrant)
    await user.click(await view.findByRole('option', { name: /disabled/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/orgs/b/roles/r/grants/notes', expect.anything()),
    )
    await act(async () => {
      if (outcome === 'resolve') finishA({})
      else rejectA(new Error('rejected'))
    })
    await waitFor(() =>
      expect(view.getByRole('combobox', { name: /notes/i }).textContent).toMatch(/disabled/i),
    )
    expect((view.getByPlaceholderText('lead') as HTMLInputElement).value).toBe('draft-b')
    await act(async () => {
      finishB({})
    })
  },
)
