import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { apiFetch, HttpError } from '../lib/api'
import { meQueryKey } from '../lib/auth'
import { fr } from '../messages/fr'
import { createTestQueryClient } from '../test/query-client'
import { renderWithAppProviders } from '../test/render'
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
  expect(match).toHaveAttribute('href', '/app/notes?noteId=%22a%22')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/app/notes?noteId=%22a%22')
  await act(() => vi.advanceTimersByTimeAsync(32))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
