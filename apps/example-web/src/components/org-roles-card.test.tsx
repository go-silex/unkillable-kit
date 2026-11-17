import { act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import { useOrgRoles } from '../lib/org-members'
import { createTestQueryClient } from '../test/query-client'
import { renderWithAppProviders } from '../test/render'
import { OrgRolesCard } from './org-roles-card'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

function Card({ orgId }: { orgId: string }) {
  const roles = useOrgRoles(orgId, true)
  return <OrgRolesCard key={orgId} orgId={orgId} roles={roles} />
}

it('does not carry a pending grant or draft to another Organization', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>((done) => {
    resolve = done
  })
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (init?.method === 'PATCH') return pending
    if (String(path).endsWith('/roles'))
      return Promise.resolve({
        roles: [
          {
            id: 'r1',
            key: 'custom',
            name: 'Custom',
            isSystem: false,
            grants: [{ moduleId: 'notes', access: 'read' }],
          },
        ],
      })
    throw new Error(`unexpected ${path}`)
  })
  const qc = createTestQueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const view = renderWithAppProviders(<Card orgId="a" />, { queryClient: qc })
  const select = await view.findByRole('combobox', { name: /notes/i })
  const user = userEvent.setup()
  await user.click(select)
  await user.click(await view.findByRole('option', { name: /write/i }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/orgs/a/roles/r1/grants/notes', expect.anything()),
  )
  view.rerender(<Card orgId="b" />)
  await waitFor(() =>
    expect(view.getByRole('combobox', { name: /notes/i }).textContent).toMatch(/read/i),
  )
  await act(async () => {
    resolve({})
  })
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['org-roles', 'a'] }))
  expect(view.getByRole('combobox', { name: /notes/i }).textContent).toMatch(/read/i)
})
