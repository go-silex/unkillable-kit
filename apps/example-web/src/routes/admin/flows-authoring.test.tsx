import { act, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../../lib/api'
import { createTestQueryClient } from '../../test/query-client'
import { renderWithAppProviders } from '../../test/render'
import { FlowsAuthoringCard } from './flows-authoring'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  vi.mocked(apiFetch).mockReset()
})

it('keeps the submitted Organization and YAML across a view switch', async () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  vi.mocked(apiFetch).mockReturnValue(promise)
  const qc = createTestQueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const view = renderWithAppProviders(<FlowsAuthoringCard key="a" orgId="a" />, { queryClient: qc })
  const field = view.getByRole('textbox')
  fireEvent.change(field, { target: { value: 'plan: A' } })
  fireEvent.click(view.getByRole('button', { name: /save plan/i }))
  view.rerender(<FlowsAuthoringCard key="b" orgId="b" />)
  expect((view.getByRole('textbox') as HTMLTextAreaElement).value).not.toBe('plan: A')
  await waitFor(() => expect(apiFetch).toHaveBeenCalled())
  expect(vi.mocked(apiFetch).mock.calls[0]?.[1]).toMatchObject({
    headers: { 'X-Org-Id': 'a' },
    body: expect.stringContaining('plan: A'),
  })
  await act(async () => {
    resolve({})
  })
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['flows', 'plans', 'a'] }),
  )
})
