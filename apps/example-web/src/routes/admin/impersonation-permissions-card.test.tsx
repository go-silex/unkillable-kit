import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../../lib/api'
import { meQueryKey } from '../../lib/auth'
import { createApiDispatcher } from '../../test/api-mock'
import { createMe } from '../../test/factories'
import { createTestQueryClient } from '../../test/query-client'
import { renderWithAppProviders } from '../../test/render'
import { ImpersonationPermissionsCard } from './impersonation-permissions-card'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

const path = '/api/admin/impersonation/permissions'
const key = ['admin-impersonation-permissions']
const response = (read: boolean, write: boolean) => ({
  permissions: [{ role: 'admin', read, write }],
  requestId: 'test',
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

function setup(patch: (body: string) => unknown = () => response(false, true)) {
  const client = createTestQueryClient()
  client.setQueryData(meQueryKey, createMe({ platformRole: 'super_admin' }))
  vi.mocked(apiFetch).mockImplementation(
    createApiDispatcher()
      .on('GET', '/api/me', () => createMe({ platformRole: 'super_admin' }))
      .on('GET', path, () => response(true, false))
      .on('PATCH', path, ({ init }) => patch(String(init?.body))).fetch,
  )
  renderWithAppProviders(<ImpersonationPermissionsCard />, { queryClient: client })
  return client
}

describe('Impersonation permission drafts', () => {
  it('tracks a remote revocation while pristine without enabling save', async () => {
    const client = setup()
    const read = await screen.findByRole('checkbox', { name: 'Read' })
    expect(read).toBeChecked()
    act(() => client.setQueryData(key, response(false, false)))
    await waitFor(() => expect(read).not.toBeChecked())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(apiFetch).not.toHaveBeenCalledWith(path, expect.objectContaining({ method: 'PATCH' }))
  })

  it('preserves a dirty draft on remote change until explicit reload', async () => {
    const client = setup()
    const user = userEvent.setup()
    const read = await screen.findByRole('checkbox', { name: 'Read' })
    const write = screen.getByRole('checkbox', { name: 'Write' })
    await user.click(write)
    act(() => client.setQueryData(key, response(false, false)))
    expect(await screen.findByRole('alert')).toHaveTextContent('permissions changed')
    expect(read).toBeChecked()
    expect(write).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    act(() => client.setQueryData(key, response(true, false)))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => client.setQueryData(key, response(false, false)))
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(read).not.toBeChecked()
    expect(write).not.toBeChecked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(apiFetch).not.toHaveBeenCalledWith(path, expect.objectContaining({ method: 'PATCH' }))
  })

  it('reverts a local edit and saves returned authoritative values', async () => {
    const patch = vi.fn((_body: string) => response(false, true))
    setup(patch)
    const user = userEvent.setup()
    const read = await screen.findByRole('checkbox', { name: 'Read' })
    const write = screen.getByRole('checkbox', { name: 'Write' })
    await user.click(write)
    await user.click(write)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(write)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(read).not.toBeChecked())
    expect(write).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(JSON.parse(patch.mock.calls[0]?.[0] ?? '')).toEqual({
      role: 'admin',
      read: true,
      write: true,
    })
  })

  it('keeps the draft after a failed save', async () => {
    setup(() => Promise.reject(new Error('failed')))
    const user = userEvent.setup()
    const write = await screen.findByRole('checkbox', { name: 'Write' })
    await user.click(write)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(write).toBeChecked()
  })

  it('disables editing while a save is pending', async () => {
    let resolve!: (value: unknown) => void
    const promise = new Promise<unknown>((done) => {
      resolve = done
    })
    setup(() => promise)
    const user = userEvent.setup()
    const write = await screen.findByRole('checkbox', { name: 'Write' })
    await user.click(write)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(write).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Read' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await act(async () => resolve(response(false, true)))
    await waitFor(() => expect(write).toBeEnabled())
  })
})
