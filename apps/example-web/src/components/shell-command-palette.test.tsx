import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import { fr } from '../messages/fr'
import { renderWithAppProviders } from '../test/render'
import { ShellCommandPalette } from './shell-command-palette'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))

it('registers navigation and cancelable notes search, and passes the result href to routing', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockResolvedValueOnce({
    notes: [
      { id: 'a', title: 'Project kickoff', body: 'Agenda for the next meeting' },
      { id: 'b', title: 'Unrelated note', body: 'Something else' },
    ],
  })
  const navigate = vi.fn()
  renderWithAppProviders(<ShellCommandPalette mode="app" delegated={false} onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: fr.paletteTitle }))
  expect(screen.getByRole('link', { name: fr.navAppHome })).toHaveAttribute('href', '/app')
  const input = screen.getByRole('combobox', { name: fr.palettePlaceholder })
  fireEvent.change(input, { target: { value: 'Agenda' } })
  expect(apiFetch).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/notes', {
    signal: expect.any(AbortSignal),
  })
  const match = screen.getByRole('link', { name: 'Project kickoff' })
  expect(match).toHaveAttribute('href', '/app/notes?q=%22Project+kickoff%22')
  expect(screen.queryByRole('link', { name: 'Unrelated note' })).not.toBeInTheDocument()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/app/notes?q=%22Project+kickoff%22')
  await act(() => vi.advanceTimersByTimeAsync(32))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('does not register notes in the delegated shell', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockClear()
  renderWithAppProviders(<ShellCommandPalette mode="app" delegated onNavigate={vi.fn()} />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(screen.getByRole('link', { name: fr.navTasks })).toHaveAttribute('href', '/app/tasks')
  expect(screen.queryByRole('link', { name: fr.navNotes })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'notes' } })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(apiFetch).not.toHaveBeenCalled()
})
