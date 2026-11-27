import { RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { apiFetch, HttpError } from '../lib/api'
import { meQueryKey } from '../lib/auth'
import { fr } from '../messages/fr'
import { routeTree } from '../routeTree'
import { createMe } from '../test/factories'
import { createTestQueryClient } from '../test/query-client'
import { createTestRouter, renderWithAppProviders } from '../test/render'
import { ShellCommandPalette } from './shell-command-palette'

vi.mock(import('../lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}))

it('registers navigation and cancelable notes search, and passes the result href to routing', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockResolvedValueOnce({
    notes: [
      { id: 'a', title: 'Project kickoff', body: 'Agenda for the next meeting' },
      { id: 'b', title: 'Project kickoff', body: 'Something else' },
    ],
  })
  const navigate = vi.fn()
  renderWithAppProviders(<ShellCommandPalette mode="app" delegated={false} onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: fr.paletteTitle }))
  expect(screen.getByRole('option', { name: fr.navAppHome })).toHaveAttribute('href', '/app')
  const input = screen.getByRole('combobox', { name: fr.palettePlaceholder })
  fireEvent.change(input, { target: { value: 'Agenda' } })
  expect(apiFetch).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/notes', {
    signal: expect.any(AbortSignal),
  })
  const match = screen.getByRole('option', { name: 'Project kickoff' })
  const href = match.getAttribute('href')
  expect(href).toMatch(/^\/app\/notes\?noteId=%22a%22&reveal=[a-f0-9-]+$/)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href)
  await act(() => vi.advanceTimersByTimeAsync(32))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('reveals the same note again after filtering it out without leaving Notes', async () => {
  const me = createMe()
  const notes = [
    { id: 'a', title: 'Project kickoff', body: 'Agenda', createdAt: 1 },
    { id: 'b', title: 'Other record', body: 'Other body', createdAt: 2 },
  ]
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/me') return me
    if (path === '/api/notes') return { notes }
    throw new Error(`Unexpected request: ${path}`)
  })
  const queryClient = createTestQueryClient()
  const router = createTestRouter(routeTree, '/app/notes', queryClient)
  const navigate = vi.spyOn(router, 'navigate')
  renderWithAppProviders(<RouterProvider router={router} />, { queryClient })

  async function selectNote() {
    fireEvent.click(await screen.findByRole('button', { name: fr.paletteTitle }))
    fireEvent.change(screen.getByRole('combobox', { name: fr.palettePlaceholder }), {
      target: { value: 'kickoff' },
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Project kickoff' }))
  }

  await selectNote()
  await screen.findByRole('row', { name: /Project kickoff/, current: true })
  const initialHref = router.state.location.href
  fireEvent.change(screen.getByRole('textbox', { name: fr.tableSearch }), {
    target: { value: 'Other record' },
  })
  expect(screen.queryByRole('row', { name: /Project kickoff/ })).not.toBeInTheDocument()
  expect(screen.getByRole('row', { name: /Other record/ })).toBeInTheDocument()

  await selectNote()
  expect(await screen.findByRole('row', { name: /Project kickoff/ })).toHaveAttribute(
    'aria-current',
    'true',
  )
  expect(router.state.location.pathname).toBe('/app/notes')
  expect(router.state.location.href).not.toBe(initialHref)
  expect(screen.getByRole('textbox', { name: fr.tableSearch })).toHaveValue('')
  expect(navigate).toHaveBeenCalledWith({
    href: expect.stringContaining('/app/notes?noteId='),
    resetScroll: false,
  })

  fireEvent.click(screen.getByRole('button', { name: fr.paletteTitle }))
  fireEvent.click(screen.getByRole('option', { name: fr.navNotes }))
  expect(navigate).toHaveBeenCalledWith({ href: '/app/notes', resetScroll: true })
  await screen.findByRole('row', { name: /Project kickoff/, current: false })
  vi.mocked(apiFetch).mockReset()
})

it('does not register notes in the delegated shell', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockClear()
  renderWithAppProviders(<ShellCommandPalette mode="app" delegated onNavigate={vi.fn()} />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(screen.getByRole('option', { name: fr.navTasks })).toHaveAttribute('href', '/app/tasks')
  expect(screen.queryByRole('option', { name: fr.navNotes })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'notes' } })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(apiFetch).not.toHaveBeenCalled()
})

it('clears the cached principal on a protected notes search 401', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockRejectedValueOnce(new HttpError(401))
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(meQueryKey, { subject: 'signed-in-user' })
  renderWithAppProviders(
    <ShellCommandPalette mode="app" delegated={false} onNavigate={vi.fn()} />,
    { queryClient },
  )
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'note' } })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(queryClient.getQueryData(meQueryKey)).toBeUndefined()
  expect(screen.getByRole('status')).toHaveTextContent(fr.loadFailed)
})
