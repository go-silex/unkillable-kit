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
  permissions: [{ role: 'staff', read, write }],
  requestId: 'test',
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

function setup(
  patch: (body: string) => unknown = () => response(false, true),
  get: (signal: AbortSignal | null | undefined) => unknown = () => response(true, false),
) {
  const client = createTestQueryClient()
  client.setQueryData(meQueryKey, createMe({ platformRole: 'super_admin' }))
  vi.mocked(apiFetch).mockImplementation(
    createApiDispatcher()
      .on('GET', '/api/me', () => createMe({ platformRole: 'super_admin' }))
      .on('GET', path, ({ init }) => get(init?.signal))
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
      role: 'staff',
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

  it('does not let an older pending GET undo a confirmed save', async () => {
    let releaseGet!: (value: unknown) => void
    let releasePatch!: (value: unknown) => void
    const oldGet = new Promise<unknown>((resolve) => {
      releaseGet = resolve
    })
    const firstPatch = new Promise<unknown>((resolve) => {
      releasePatch = resolve
    })
    let gets = 0
    let pendingSignal: AbortSignal | null | undefined
    const patch = vi.fn((_body: string) =>
      patch.mock.calls.length === 1 ? firstPatch : response(false, true),
    )
    const client = setup(patch, (signal) => {
      if (++gets === 1) return response(true, false)
      pendingSignal = signal
      return oldGet
    })
    const user = userEvent.setup()
    const read = await screen.findByRole('checkbox', { name: 'Read' })
    await user.click(read)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    act(() => {
      void client.refetchQueries({ queryKey: key })
    })
    await waitFor(() => expect(gets).toBe(2))
    await act(async () => releasePatch(response(false, false)))
    expect(pendingSignal?.aborted).toBe(true)
    await waitFor(() => expect(read).toBeEnabled())
    await act(async () => releaseGet(response(true, false)))
    expect(read).not.toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Write' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(patch.mock.calls[1]?.[0] ?? '')).toEqual({
      role: 'staff',
      read: false,
      write: true,
    })
  })

  it('retains a newer observed policy and conflict when an older PATCH arrives', async () => {
    let releaseGet!: (value: unknown) => void
    let releasePatch!: (value: unknown) => void
    const newerGet = new Promise<unknown>((resolve) => {
      releaseGet = resolve
    })
    const firstPatch = new Promise<unknown>((resolve) => {
      releasePatch = resolve
    })
    let gets = 0
    const patch = vi.fn((_body: string) =>
      patch.mock.calls.length === 1 ? firstPatch : response(false, true),
    )
    const client = setup(patch, () =>
      ++gets === 1 ? response(true, false) : gets === 2 ? newerGet : response(false, false),
    )
    const user = userEvent.setup()
    const read = await screen.findByRole('checkbox', { name: 'Read' })
    const write = screen.getByRole('checkbox', { name: 'Write' })
    await user.click(write)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    act(() => {
      void client.refetchQueries({ queryKey: key })
    })
    await waitFor(() => expect(gets).toBe(2))
    await act(async () => releaseGet(response(false, false)))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await act(async () => releasePatch(response(true, true)))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(read).toBeChecked()
    expect(write).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(read).not.toBeChecked()
    expect(write).not.toBeChecked()
    await user.click(write)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(patch.mock.calls[1]?.[0] ?? '')).toEqual({
      role: 'staff',
      read: false,
      write: true,
    })
  })

  it('reconciles simultaneous row saves without replacing the other row', async () => {
    let releaseStaff!: (value: unknown) => void
    let releaseSuper!: (value: unknown) => void
    const staffSave = new Promise<unknown>((resolve) => {
      releaseStaff = resolve
    })
    const superSave = new Promise<unknown>((resolve) => {
      releaseSuper = resolve
    })
    const policies = (staff: boolean, superAdmin: boolean) => ({
      permissions: [
        { role: 'staff', read: staff, write: false },
        { role: 'super_admin', read: superAdmin, write: false },
      ],
      requestId: 'test',
    })
    let gets = 0
    const patch = vi.fn((body: string) =>
      JSON.parse(body).role === 'staff' ? staffSave : superSave,
    )
    setup(patch, () => (++gets === 1 ? policies(false, false) : policies(true, true)))
    const user = userEvent.setup()
    const reads = await screen.findAllByRole('checkbox', { name: 'Read' })
    await user.click(reads[0]!)
    await user.click(reads[1]!)
    const saves = screen.getAllByRole('button', { name: 'Save' })
    await user.click(saves[0]!)
    await user.click(saves[1]!)
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    await act(async () => releaseStaff(policies(true, false)))
    await waitFor(() => expect(reads[0]).toBeEnabled())
    await act(async () => releaseSuper(policies(false, true)))
    await waitFor(() => expect(gets).toBe(2))
    expect(reads[0]).toBeChecked()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reads[1]).toBeChecked()
    expect(reads[0]).toBeChecked()
  })
})
