import { useQuery } from '@tanstack/react-query'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../lib/notes'
import { en } from '../messages/en'
import { renderWithAppProviders } from '../test/render'
import { NotesTable } from './notes-table'

function note(id: string, title: string, body: string): Note {
  return { id, title, body, createdAt: Number(id.slice(1)) }
}

function LoadedNotesTable({ notes }: { notes: Note[] }) {
  const query = useQuery({
    queryKey: ['notes-table-test'],
    queryFn: () => Promise.resolve({ notes }),
  })
  return <NotesTable notes={query} onDelete={vi.fn()} onCreate={vi.fn()} />
}

async function renderTable(notes: Note[]) {
  renderWithAppProviders(<LoadedNotesTable notes={notes} />)
  await screen.findByRole('table')
}

function visibleTitles(): string[] {
  const [, ...bodyRows] = screen.getAllByRole('row')
  return bodyRows.map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '')
}

function titleHeader(): { button: HTMLElement; ariaSort: () => string | null } {
  const button = screen.getByRole('button', { name: `${en.title} — ${en.tableSortHint}` })
  return { button, ariaSort: () => button.closest('th')?.getAttribute('aria-sort') ?? null }
}

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
})

describe('NotesTable on TanStack Table v9', () => {
  it('cycles title sort none → asc → desc → none in case-insensitive order', async () => {
    const user = userEvent.setup()
    await renderTable([
      note('n1', 'Banana', 'yellow'),
      note('n2', 'cherry', 'red'),
      note('n3', 'apple', ''),
    ])
    const title = titleHeader()
    expect(title.ariaSort()).toBe('none')
    expect(visibleTitles()).toEqual(['Banana', 'cherry', 'apple'])

    await user.click(title.button)
    expect(title.ariaSort()).toBe('ascending')
    expect(visibleTitles()).toEqual(['apple', 'Banana', 'cherry'])

    await user.click(title.button)
    expect(title.ariaSort()).toBe('descending')
    expect(visibleTitles()).toEqual(['cherry', 'Banana', 'apple'])

    await user.click(title.button)
    expect(title.ariaSort()).toBe('none')
    expect(visibleTitles()).toEqual(['Banana', 'cherry', 'apple'])
  })

  it('sorts digit-bearing titles in natural order, not raw string order', async () => {
    const user = userEvent.setup()
    await renderTable([
      note('n1', 'Note 10', ''),
      note('n2', 'note 9', ''),
      note('n3', 'Note 1', ''),
    ])

    await user.click(titleHeader().button)

    expect(visibleTitles()).toEqual(['Note 1', 'note 9', 'Note 10'])
  })

  it('searches title and body case-insensitively, then shows the no-results state', async () => {
    const user = userEvent.setup()
    await renderTable([
      note('n1', 'cherry', 'Red fruit'),
      note('n2', 'Banana', 'yellow'),
      note('n3', 'apple', ''),
    ])
    const search = screen.getByRole('textbox', { name: en.tableSearch })

    await user.type(search, 'RED')
    expect(visibleTitles()).toEqual(['cherry'])

    await user.clear(search)
    await user.type(search, 'banana')
    expect(visibleTitles()).toEqual(['Banana'])

    await user.type(search, ' split')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText(en.tableNoResults)).toBeInTheDocument()
  })

  it('applies the body column filter for empty and non-empty bodies', async () => {
    const user = userEvent.setup()
    await renderTable([
      note('n1', 'cherry', 'red'),
      note('n2', 'Banana', '   '),
      note('n3', 'apple', ''),
    ])

    await user.click(screen.getByRole('combobox', { name: en.tableFilter }))
    await user.click(await screen.findByRole('option', { name: en.tableFilterEmptyBody }))
    expect(visibleTitles()).toEqual(['Banana', 'apple'])

    await user.click(screen.getByRole('combobox', { name: en.tableFilter }))
    await user.click(await screen.findByRole('option', { name: en.tableFilterWithBody }))
    expect(visibleTitles()).toEqual(['cherry'])

    await user.click(screen.getByRole('combobox', { name: en.tableFilter }))
    await user.click(await screen.findByRole('option', { name: en.tableFilterAll }))
    expect(visibleTitles()).toEqual(['cherry', 'Banana', 'apple'])
  })
})
