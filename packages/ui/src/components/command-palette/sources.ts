import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

export type Command = {
  id: string
  label: string
  keywords?: readonly string[]
  icon?: ReactNode
  shortcut?: string
} & ({ href: string; run?: never } | { run: () => void; href?: never })

export type CommandSource = {
  id: string
  label?: string
} & (
  | { commands: readonly Command[]; search?: never }
  | {
      search: (query: string, context: { signal: AbortSignal }) => Promise<readonly Command[]>
      commands?: never
    }
)

type SourceResult =
  | { state: 'loading' | 'error' }
  | { state: 'ready'; commands: readonly Command[] }

const loading = { state: 'loading' } as const

type Search = NonNullable<CommandSource['search']>
type SearchIdentity = { search: Search; query: string }
type SearchJob = SearchIdentity & { cancel: () => void; retry: () => void }
type Snapshot = SearchIdentity & { result: SourceResult }

function startSearch(
  search: Search,
  query: string,
  delay: number,
  notify: (result: SourceResult) => void,
): SearchJob {
  const controller = new AbortController()
  const publish = (result: SourceResult) => {
    if (!controller.signal.aborted) notify(result)
  }
  async function run() {
    try {
      const commands = await search(query, { signal: controller.signal })
      publish({ state: 'ready', commands })
    } catch {
      publish({ state: 'error' })
    }
  }
  const timeout = setTimeout(() => void run(), delay)
  return {
    search,
    query,
    cancel() {
      clearTimeout(timeout)
      controller.abort()
    },
    retry() {
      publish(loading)
      void run()
    },
  }
}

export function useCommandResults(sources: readonly CommandSource[], query: string, delay: number) {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, Snapshot>>(() => new Map())
  const jobs = useRef(new Map<string, SearchJob>())

  useEffect(() => {
    const current = jobs.current
    const searches = new Map(sources.map(({ id, search }) => [id, search]))
    const obsolete: string[] = []
    for (const [id, job] of current) {
      if (job.query === query && job.search === searches.get(id)) continue
      job.cancel()
      current.delete(id)
      obsolete.push(id)
    }
    if (obsolete.length > 0) {
      setSnapshots((previous) => {
        const next = new Map(previous)
        for (const id of obsolete) next.delete(id)
        return next
      })
    }
    for (const [id, search] of searches) {
      if (!search || current.has(id)) continue
      current.set(
        id,
        startSearch(search, query, delay, (result) => {
          setSnapshots((previous) => new Map(previous).set(id, { search, query, result }))
        }),
      )
    }
  }, [sources, query, delay])

  useEffect(() => {
    const current = jobs.current
    return () => {
      for (const job of current.values()) job.cancel()
      current.clear()
    }
  }, [])

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return {
    groups: sources.map((source) => {
      const snapshot = snapshots.get(source.id)
      const result: SourceResult = source.commands
        ? {
            state: 'ready',
            commands:
              terms.length === 0
                ? source.commands
                : source.commands.filter(({ label, keywords }) => {
                    const name = label.toLowerCase()
                    const aliases = keywords?.map((keyword) => keyword.toLowerCase())
                    return terms.every(
                      (term) =>
                        name.includes(term) || aliases?.some((keyword) => keyword.includes(term)),
                    )
                  }),
          }
        : snapshot && snapshot.search === source.search && snapshot.query === query
          ? snapshot.result
          : loading
      return { source, result }
    }),
    retry: (id: string) => jobs.current.get(id)?.retry(),
  }
}
