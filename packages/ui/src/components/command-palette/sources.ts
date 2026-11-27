import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

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

type SearchRequest = {
  sources: readonly CommandSource[]
  query: string
  delay: number
}

type Snapshot = {
  request: SearchRequest
  results: ReadonlyMap<string, SourceResult>
}

const loading = { state: 'loading' } as const

export function useCommandResults(sources: readonly CommandSource[], query: string, delay: number) {
  const request = useMemo(() => ({ sources, query, delay }), [sources, query, delay])
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const retries = useRef(new Map<string, () => void>())

  useEffect(() => {
    const { sources, query, delay } = request
    const controller = new AbortController()
    const scheduled = new Map<string, () => void>()
    const activeRetries = retries.current

    function publish(id: string, result: SourceResult) {
      if (controller.signal.aborted) return
      setSnapshot((previous) => {
        const results = new Map(previous?.request === request ? previous.results : undefined)
        results.set(id, result)
        return { request, results }
      })
    }

    for (const { id, search } of sources) {
      if (!search) continue
      const run = async () => {
        if (controller.signal.aborted) return
        try {
          const commands = await search(query, { signal: controller.signal })
          publish(id, { state: 'ready', commands })
        } catch {
          publish(id, { state: 'error' })
        }
      }
      scheduled.set(id, () => void run())
      activeRetries.set(id, () => {
        publish(id, loading)
        void run()
      })
    }

    if (scheduled.size === 0) return
    const timeout = setTimeout(() => {
      for (const run of scheduled.values()) run()
    }, delay)
    return () => {
      clearTimeout(timeout)
      controller.abort()
      activeRetries.clear()
    }
  }, [request])

  const results = snapshot?.request === request ? snapshot.results : undefined
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return {
    groups: sources.map((source) => ({
      source,
      result: source.commands
        ? ({
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
          } satisfies SourceResult)
        : (results?.get(source.id) ?? loading),
    })),
    retry: (id: string) => retries.current.get(id)?.(),
  }
}
