import { act, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiDispatcher } from '../test/api-mock'
import { createTestQueryClient } from '../test/query-client'
import { renderWithAppProviders } from '../test/render'
import { apiFetch } from './api'
import {
  clearOptimisticGrantIfCurrent,
  mergeOptimisticGrant,
  type OrgRoleGrantInput,
  orgRoleGrantKey,
  usePatchOrgRoleGrant,
} from './org-members'

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
}))

const fetchMock = vi.mocked(apiFetch)

afterEach(() => {
  fetchMock.mockReset()
})

describe('optimistic grant overlay', () => {
  it('keys by role and module', () => {
    expect(orgRoleGrantKey('role_a', 'notes')).toBe('role_a:notes')
  })

  it('clears only the operation owning the overlay, including repeated values', () => {
    const first = { orgId: 'org_1', roleId: 'r1', moduleId: 'notes', access: 'write' } as const
    const newer = { ...first }
    const sibling = { orgId: 'org_1', roleId: 'r1', moduleId: 'files', access: 'read' } as const
    const both = mergeOptimisticGrant(
      mergeOptimisticGrant(mergeOptimisticGrant({}, first), newer),
      sibling,
    )
    expect(clearOptimisticGrantIfCurrent(both, first)['r1:notes']).toBe(newer)
    const afterNewer = clearOptimisticGrantIfCurrent(both, newer)
    expect(afterNewer['r1:notes']).toBeUndefined()
    expect(afterNewer['r1:files']).toBe(sibling)
    expect(clearOptimisticGrantIfCurrent(afterNewer, sibling)['r1:files']).toBeUndefined()
  })
})

function GrantProbe({ onEvent }: { onEvent: (event: string) => void }) {
  const patch = usePatchOrgRoleGrant({
    onSuccess: (input) => onEvent(`${input.moduleId}:onSuccess`),
    onError: (_e, input) => onEvent(`${input.moduleId}:onError`),
  })
  return (
    <button
      type="button"
      onClick={() => {
        patch.mutate({ orgId: 'org_1', roleId: 'r1', moduleId: 'A', access: 'write' })
        patch.mutate({ orgId: 'org_1', roleId: 'r1', moduleId: 'B', access: 'write' })
      }}
    >
      go
    </button>
  )
}

function SwitchingGrant({ orgId }: { orgId: string }) {
  const [overlay, setOverlay] = useState<Record<string, OrgRoleGrantInput>>({})
  const patch = usePatchOrgRoleGrant({
    onMutate: (input) => setOverlay((prev) => mergeOptimisticGrant(prev, input)),
    onSuccess: (input) => setOverlay((prev) => clearOptimisticGrantIfCurrent(prev, input)),
    onError: (_error, input) => setOverlay((prev) => clearOptimisticGrantIfCurrent(prev, input)),
  })
  return (
    <button
      type="button"
      onClick={() => patch.mutate({ orgId, roleId: 'r1', moduleId: 'notes', access: 'write' })}
    >
      {overlay['r1:notes']?.access ?? 'empty'}
    </button>
  )
}

it('keeps the request and refresh with the submitted Organization until refresh completes', async () => {
  let resolveRequest!: (value: unknown) => void
  let resolveRefresh!: () => void
  const request = new Promise<unknown>((resolve) => {
    resolveRequest = resolve
  })
  const refresh = new Promise<void>((resolve) => {
    resolveRefresh = resolve
  })
  fetchMock.mockReturnValue(request)
  const qc = createTestQueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries').mockReturnValue(refresh)
  const view = renderWithAppProviders(<SwitchingGrant orgId="a" />, { queryClient: qc })
  fireEvent.click(view.getByRole('button'))
  view.rerender(<SwitchingGrant orgId="b" />)
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/orgs/a/roles/r1/grants/notes', expect.anything()),
  )
  await act(async () => {
    resolveRequest({})
  })
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['org-roles', 'a'] }))
  expect(view.getByRole('button').textContent).toBe('write')
  await act(async () => {
    resolveRefresh()
  })
  await waitFor(() => expect(view.getByRole('button').textContent).toBe('empty'))
})

function ConcurrentGrant({ orgId }: { orgId: string }) {
  const [overlay, setOverlay] = useState<Record<string, OrgRoleGrantInput>>({})
  const [events, setEvents] = useState('')
  const patch = usePatchOrgRoleGrant({
    onMutate: (input) => setOverlay((prev) => mergeOptimisticGrant(prev, input)),
    onSuccess: (input) => {
      setOverlay((prev) => clearOptimisticGrantIfCurrent(prev, input))
      setEvents((prev) => `${prev}success:${input.orgId};`)
    },
    onError: (_error, input) => {
      setOverlay((prev) => clearOptimisticGrantIfCurrent(prev, input))
      setEvents((prev) => `${prev}error:${input.orgId};`)
    },
  })
  return (
    <>
      <button
        type="button"
        onClick={() => patch.mutate({ orgId, roleId: 'r1', moduleId: 'notes', access: 'write' })}
      >
        submit
      </button>
      <output>
        {overlay['r1:notes']?.access ?? 'empty'}|{events}
      </output>
    </>
  )
}

it.each(['resolve', 'reject'] as const)(
  'preserves newer identical overlay while earlier refresh %s after a switch',
  async (outcome) => {
    let finishB!: (value: unknown) => void
    let finishRefresh!: () => void
    let rejectRefresh!: (error: unknown) => void
    const requestB = new Promise<unknown>((resolve) => {
      finishB = resolve
    })
    const refresh = new Promise<void>((resolve, reject) => {
      finishRefresh = resolve
      rejectRefresh = reject
    })
    fetchMock.mockImplementation((path) => (path.includes('/a/') ? Promise.resolve({}) : requestB))
    const qc = createTestQueryClient()
    const invalidate = vi
      .spyOn(qc, 'invalidateQueries')
      .mockImplementation((filters) =>
        filters?.queryKey?.[1] === 'a' ? refresh : Promise.resolve(),
      )
    const view = renderWithAppProviders(<ConcurrentGrant orgId="a" />, { queryClient: qc })
    fireEvent.click(view.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['org-roles', 'a'] }))
    view.rerender(<ConcurrentGrant orgId="b" />)
    fireEvent.click(view.getByRole('button', { name: 'submit' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/orgs/b/roles/r1/grants/notes',
        expect.anything(),
      ),
    )
    expect(view.getByText(/^write/)).toBeTruthy()
    await act(async () => {
      if (outcome === 'resolve') finishRefresh()
      else rejectRefresh(new Error('refresh failed'))
    })
    await waitFor(() =>
      expect(
        view.getByText(new RegExp(`^write\\|${outcome === 'resolve' ? 'success' : 'error'}:a;`)),
      ).toBeTruthy(),
    )
    await act(async () => {
      finishB({})
    })
    await waitFor(() => expect(view.getByText(/empty\|.*success:b;/)).toBeTruthy())
  },
)

describe('usePatchOrgRoleGrant', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('fires config-level onError for a superseded first mutation', async () => {
    let rejectA: (error: unknown) => void = () => {}
    let resolveB: (value: unknown) => void = () => {}
    const pendingA = new Promise<never>((_resolve, reject) => {
      rejectA = reject
    })
    const pendingB = new Promise<unknown>((resolve) => {
      resolveB = resolve
    })
    let requests = 0
    fetchMock.mockImplementation(
      createApiDispatcher().on('PATCH', /^\/api\/orgs\/org_1\/roles\/r1\/grants\/[AB]$/, () => {
        requests += 1
        return requests === 1 ? pendingA : pendingB
      }).fetch,
    )

    const events: string[] = []
    const view = renderWithAppProviders(<GrantProbe onEvent={(event) => events.push(event)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'go' }))
    })

    await act(async () => {
      rejectA(new Error('forbidden'))
      resolveB({})
    })

    await waitFor(() => {
      expect(events).toEqual(expect.arrayContaining(['A:onError', 'B:onSuccess']))
    })
    expect(events).toHaveLength(2)
  })
})
