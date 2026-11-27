import { Button, CommandPalette, type CommandSource } from '@kit/ui'
import { SearchIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { apiFetch } from '../lib/api'
import { useLocale } from '../lib/locale'
import type { NotesResponse } from '../lib/notes'
import type { ShellMode } from './app-shell'

export function ShellCommandPalette({
  mode,
  delegated,
  onNavigate,
}: {
  mode: ShellMode
  delegated: boolean
  onNavigate: (href: string) => void
}) {
  const { m } = useLocale()
  const [open, setOpen] = useState(false)
  const sources = useMemo<readonly CommandSource[]>(() => {
    if (mode === 'admin') {
      return [
        {
          id: 'navigation',
          label: m.navAdmin,
          commands: [
            { id: 'home', label: m.navAdminHome, href: '/admin' },
            { id: 'orgs', label: m.navOrgs, href: '/admin/orgs' },
            { id: 'users', label: m.navUsers, href: '/admin/users' },
          ],
        },
      ]
    }

    const tasks = { id: 'tasks', label: m.navTasks, href: '/app/tasks' }
    return [
      {
        id: 'navigation',
        label: m.navApp,
        commands: delegated
          ? [tasks]
          : [
              { id: 'home', label: m.navAppHome, href: '/app' },
              { id: 'notes', label: m.navNotes, href: '/app/notes' },
              { id: 'items', label: m.navItems, href: '/app/items' },
              tasks,
            ],
      },
      ...(!delegated
        ? [
            {
              id: 'notes',
              label: m.notes,
              async search(query: string, { signal }: { signal: AbortSignal }) {
                if (!query) return []
                const { notes } = await apiFetch<NotesResponse>('/api/notes', { signal })
                const needle = query.toLowerCase()
                return notes
                  .filter(
                    ({ title, body }) =>
                      title.toLowerCase().includes(needle) || body.toLowerCase().includes(needle),
                  )
                  .map(({ id, title }) => ({
                    id,
                    label: title,
                    href: `/app/notes?${new URLSearchParams({ q: JSON.stringify(title) })}`,
                  }))
              },
            },
          ]
        : []),
    ]
  }, [m, mode, delegated])

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        aria-label={m.paletteTitle}
        onClick={() => setOpen(true)}
      >
        <SearchIcon aria-hidden="true" />
      </Button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        sources={sources}
        messages={{
          title: m.paletteTitle,
          close: m.paletteClose,
          placeholder: m.palettePlaceholder,
          results: m.paletteResults,
          group: m.paletteGroup,
          empty: m.paletteEmpty,
          loading: m.loading,
          error: m.loadFailed,
          retry: m.retry,
        }}
        onNavigate={onNavigate}
      />
    </>
  )
}
