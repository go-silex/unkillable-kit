import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { type Command, CommandPalette, type CommandSource } from '../../index'

const queryInput = () => screen.getByRole('combobox', { name: 'Search commands…' })

function press(key: string, modifiers: KeyboardEventInit = {}) {
  fireEvent.keyDown(queryInput(), { key, ...modifiers })
}

function controlSearch() {
  const requests: Array<{
    query: string
    signal: AbortSignal
    resolve: (commands: readonly Command[]) => void
    reject: (error: Error) => void
  }> = []
  const search = (query: string, { signal }: { signal: AbortSignal }) =>
    new Promise<readonly Command[]>((resolve, reject) =>
      requests.push({ query, signal, resolve, reject }),
    )
  return { requests, search }
}

it('toggles with Ctrl+K and Cmd+K from text fields, and Escape restores focus', async () => {
  const user = userEvent.setup()
  render(
    <>
      <input aria-label="Editor" />
      <CommandPalette sources={[]} />
    </>,
  )
  const editor = screen.getByRole('textbox', { name: 'Editor' })
  await user.click(editor)
  await user.keyboard('{Control>}k{/Control}')
  expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
  expect(queryInput()).toHaveFocus()
  await user.keyboard('{Meta>}k{/Meta}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(editor).toHaveFocus())

  await user.keyboard('{Meta>}k{/Meta}')
  await user.type(queryInput(), 'notes')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(editor).toHaveFocus())
  await user.keyboard('{Control>}k{/Control}')
  expect(queryInput()).toHaveValue('')
})

it('supports disabling or replacing the default hotkey', () => {
  const { rerender } = render(<CommandPalette sources={[]} hotkey={false} />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(<CommandPalette sources={[]} hotkey={(event) => event.key === 'F2'} />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'F2' })
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('navigates across groups, stops at the ends, and runs the selected action', () => {
  const first = vi.fn()
  const last = vi.fn()
  render(
    <CommandPalette
      open
      sources={[
        { id: 'first', label: 'First group', commands: [{ id: 'a', label: 'First', run: first }] },
        {
          id: 'second',
          label: 'Second group',
          commands: [
            { id: 'b', label: 'Middle', run: vi.fn() },
            { id: 'c', label: 'Last', run: last },
          ],
        },
      ]}
    />,
  )
  const list = screen.getByRole('listbox', { name: 'Results' })
  expect(queryInput()).toHaveAttribute('aria-controls', list.id)
  const firstOption = within(screen.getByRole('group', { name: 'First group' })).getByRole('option')
  const lastOption = within(screen.getByRole('group', { name: 'Second group' })).getByRole(
    'option',
    { name: 'Last' },
  )
  const assertActive = (option: HTMLElement) => {
    expect(queryInput()).toHaveAttribute('aria-activedescendant', option.id)
    expect(option).toHaveAttribute('aria-selected', 'true')
  }
  assertActive(firstOption)
  press('ArrowUp')
  assertActive(firstOption)
  press('ArrowDown')
  assertActive(screen.getByRole('option', { name: 'Middle' }))
  press('End')
  press('ArrowDown')
  assertActive(lastOption)
  press('Home')
  assertActive(firstOption)
  press('End')
  press('Enter')
  expect(last).toHaveBeenCalledOnce()
  expect(first).not.toHaveBeenCalled()
  fireEvent.click(firstOption)
  expect(first).toHaveBeenCalledOnce()
})

it('statically matches terms across the label and keywords, with overridable messages', () => {
  render(
    <CommandPalette
      open
      messages={{
        title: 'Palette',
        placeholder: 'Chercher',
        group: 'Commandes',
        empty: 'Aucun résultat',
        resultCount: (count) => `${count} résultat`,
        sourceStatus: (label, status) => `${label} — ${status}`,
      }}
      sources={[
        {
          id: 'nav',
          commands: [
            { id: 'new', label: 'Create note', keywords: ['draft'], run: vi.fn() },
            { id: 'archive', label: 'Archive note', run: vi.fn() },
          ],
        },
      ]}
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Palette' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Commandes' })).toBeInTheDocument()
  const input = screen.getByRole('combobox', { name: 'Chercher' })
  fireEvent.change(input, { target: { value: 'NOTE Draft' } })
  expect(screen.getByRole('option', { name: 'Create note' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: 'Archive note' })).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Commandes — 1 résultat')
  fireEvent.change(input, { target: { value: 'missing' } })
  expect(screen.getByRole('status')).toHaveTextContent('Commandes — Aucun résultat')
  expect(input).not.toHaveAttribute('aria-activedescendant')
})

it('renders a real link and leaves modified navigation out of the same-tab adapter', () => {
  const onNavigate = vi.fn()
  const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
  const sources: CommandSource[] = [
    { id: 'navigation', commands: [{ id: 'home', label: 'Home', href: '/home' }] },
  ]
  render(<CommandPalette open sources={sources} onNavigate={onNavigate} />)
  const linkOption = screen.getByRole('option', { name: 'Home' })
  expect(linkOption).toBeInstanceOf(HTMLAnchorElement)
  expect(linkOption).toHaveAttribute('href', '/home')
  expect(queryInput()).toHaveAttribute('aria-activedescendant', linkOption.id)
  press('Enter', { ctrlKey: true })
  press('Enter', { metaKey: true })
  expect(openWindow).toHaveBeenCalledTimes(2)
  expect(openWindow).toHaveBeenCalledWith('/home', '_blank', 'noopener,noreferrer')
  expect(onNavigate).not.toHaveBeenCalled()
  press('Enter')
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith('/home')
  fireEvent.click(linkOption)
  expect(onNavigate).toHaveBeenCalledTimes(2)
})

it('settles each source independently and retries only the failed source', async () => {
  vi.useFakeTimers()
  const slow = controlSearch()
  const fast = controlSearch()
  const empty = controlSearch()
  render(
    <CommandPalette
      open
      debounceMs={40}
      sources={[
        { id: 'slow', label: 'Slow', search: slow.search },
        { id: 'fast', label: 'Fast', search: fast.search },
        { id: 'empty', label: 'Empty', search: empty.search },
      ]}
    />,
  )
  expect(screen.getByText('Slow: Loading…')).toBeInTheDocument()
  const live = screen.getByRole('status')
  expect(live).toHaveTextContent('Slow: Loading… · Fast: Loading… · Empty: Loading…')
  await act(() => vi.advanceTimersByTimeAsync(39))
  expect(fast.requests).toHaveLength(0)
  await act(() => vi.advanceTimersByTimeAsync(1))
  await act(async () => {
    fast.requests[0]?.resolve([{ id: 'fixed', label: 'Fast result', run: vi.fn() }])
    empty.requests[0]?.resolve([])
  })
  expect(screen.getByRole('option', { name: 'Fast result' })).toBeInTheDocument()
  expect(screen.getByText('Slow: Loading…')).toBeInTheDocument()
  expect(screen.getByText('Empty: No results')).toBeInTheDocument()
  expect(screen.getByRole('status')).toBe(live)
  expect(live).toHaveTextContent('Slow: Loading… · Fast: 1 result · Empty: No results')
  await act(async () => slow.requests[0]?.reject(new Error('not user-facing')))
  expect(screen.getByText('Slow: Could not load results')).toBeInTheDocument()
  expect(live).toHaveTextContent('Slow: Could not load results')
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry', description: 'Slow: Could not load results' }),
  )
  expect(screen.getByText('Slow: Loading…')).toBeInTheDocument()
  expect(live).toHaveTextContent('Slow: Loading…')
  expect(slow.requests).toHaveLength(2)
  expect(fast.requests).toHaveLength(1)
  expect(empty.requests).toHaveLength(1)
  await act(async () =>
    slow.requests[1]?.resolve([{ id: 'recovered', label: 'Recovered', run: vi.fn() }]),
  )
  expect(screen.getByRole('option', { name: 'Recovered' })).toBeInTheDocument()
  expect(live).toHaveTextContent('Slow: 1 result · Fast: 1 result · Empty: No results')
})

it('cancels stale requests on query changes and unregistration, even if a source ignores abort', async () => {
  vi.useFakeTimers()
  const source = controlSearch()
  const sources = [{ id: 'search', search: source.search }]
  const { rerender } = render(<CommandPalette open sources={sources} debounceMs={20} />)
  fireEvent.change(queryInput(), { target: { value: '  first  ' } })
  await act(() => vi.advanceTimersByTimeAsync(20))
  fireEvent.change(queryInput(), { target: { value: 'second' } })
  expect(source.requests[0]?.signal.aborted).toBe(true)
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(source.requests.map(({ query }) => query)).toEqual(['first', 'second'])
  await act(async () =>
    source.requests[1]?.resolve([{ id: 'new', label: 'Current', run: vi.fn() }]),
  )
  await act(async () =>
    source.requests[0]?.resolve([{ id: 'stale', label: 'Stale', run: vi.fn() }]),
  )
  expect(screen.getByRole('option', { name: 'Current' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: 'Stale' })).not.toBeInTheDocument()
  rerender(<CommandPalette open sources={[]} />)
  expect(source.requests[1]?.signal.aborted).toBe(true)
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
})

it('keeps a search and its active result when other sources register or unregister', async () => {
  vi.useFakeTimers()
  const found = controlSearch()
  const extra = controlSearch()
  const source = { id: 'search', search: found.search }
  const staticSource: CommandSource = {
    id: 'static',
    commands: [{ id: 'home', label: 'Home', run: vi.fn() }],
  }
  const extraSource = { id: 'extra', search: extra.search }
  const { rerender } = render(<CommandPalette open sources={[source]} debounceMs={20} />)
  await act(() => vi.advanceTimersByTimeAsync(10))
  rerender(<CommandPalette open sources={[staticSource, source]} debounceMs={20} />)
  await act(() => vi.advanceTimersByTimeAsync(10))
  expect(found.requests).toHaveLength(1)
  rerender(<CommandPalette open sources={[staticSource, source, extraSource]} debounceMs={20} />)
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(found.requests[0]?.signal.aborted).toBe(false)
  expect(found.requests).toHaveLength(1)
  await act(async () => found.requests[0]?.resolve([{ id: 'hit', label: 'A hit', run: vi.fn() }]))
  press('End')
  const active = screen.getByRole('option', { name: 'A hit', selected: true })
  rerender(<CommandPalette open sources={[source]} debounceMs={20} />)
  expect(extra.requests[0]?.signal.aborted).toBe(true)
  rerender(<CommandPalette open sources={[staticSource, source]} debounceMs={20} />)
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(found.requests[0]?.signal.aborted).toBe(false)
  expect(found.requests).toHaveLength(1)
  expect(screen.getByRole('option', { name: 'A hit', selected: true })).toBe(active)
  expect(queryInput()).toHaveAttribute('aria-activedescendant', active.id)
})
