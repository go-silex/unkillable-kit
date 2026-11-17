import { act, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../../lib/api'
import { OrgProvider, useOrgContext } from '../../lib/org-context'
import { createMe, createMeOrg } from '../../test/factories'
import { createTestQueryClient } from '../../test/query-client'
import { renderWithAppProviders } from '../../test/render'
import { AdminFlowsPage } from './flows'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

function SwitchOrg() {
  const { setActiveOrgId } = useOrgContext()
  return (
    <button type="button" onClick={() => setActiveOrgId('b')}>
      switch
    </button>
  )
}

it.each(['save', 'check'] as const)(
  'keeps B editor independent after A %s completes',
  async (action) => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve
    })
    const plans = {
      plans: [],
      allowedOperations: { setPlanEnabled: true, createPlan: true, createRun: true },
      requestId: 'r',
    }
    const runs = { runs: [], requestId: 'r' }
    vi.mocked(apiFetch).mockImplementation((path, init) => {
      if (init?.method === 'POST') return pending
      if (path === '/api/flows/plans') return Promise.resolve(plans)
      if (path === '/api/flows/runs') return Promise.resolve(runs)
      throw new Error(`unexpected ${path}`)
    })
    const qc = createTestQueryClient()
    for (const org of ['a', 'b']) {
      qc.setQueryData(['flows', 'plans', org], plans)
      qc.setQueryData(['flows', 'runs', org], runs)
    }
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const me = createMe({
      orgs: ['a', 'b'].map((id) => createMeOrg({ id, name: id, slug: id, role: 'admin' })),
    })
    const view = renderWithAppProviders(
      <OrgProvider me={me}>
        <AdminFlowsPage />
        <SwitchOrg />
      </OrgProvider>,
      { queryClient: qc },
    )
    const field = await view.findByRole('textbox')
    fireEvent.change(field, { target: { value: 'plan: A' } })
    fireEvent.click(view.getByRole('button', { name: action === 'save' ? /save plan/i : /check/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        action === 'save' ? '/api/flows/plans' : '/api/flows/plans/check',
        expect.objectContaining({
          headers: { 'X-Org-Id': 'a' },
          body: JSON.stringify({ yaml: 'plan: A' }),
        }),
      ),
    )
    fireEvent.click(view.getByRole('button', { name: 'switch' }))
    await waitFor(() =>
      expect((view.getByRole('textbox') as HTMLTextAreaElement).value).not.toBe('plan: A'),
    )
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'plan: B' } })
    await act(async () => {
      finish({})
    })
    if (action === 'save')
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['flows', 'plans', 'a'] }),
      )
    expect((view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('plan: B')
  },
)
