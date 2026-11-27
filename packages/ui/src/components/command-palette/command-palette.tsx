import { type CommandPaletteMessages, commandPaletteMessages } from '@kit/i18n'
import { SearchIcon, XIcon } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { CommandEntry } from './command-entry'
import { type CommandSource, useCommandResults } from './sources'

export type CommandPaletteProps = {
  sources: readonly CommandSource[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hotkey?: false | ((event: globalThis.KeyboardEvent) => boolean)
  debounceMs?: number
  messages?: Partial<CommandPaletteMessages>
  /** Override ordinary same-tab navigation. Modified link activation stays native. */
  onNavigate?: (href: string) => void
}

function defaultHotkey(event: globalThis.KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  )
}

export function CommandPalette({
  sources,
  open: controlledOpen,
  onOpenChange,
  hotkey = defaultHotkey,
  debounceMs = 200,
  messages,
  onNavigate,
}: CommandPaletteProps) {
  const [uncontrolledOpen, setOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (hotkey === false) return
    function toggle(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || !matches(event)) return
      event.preventDefault()
      const current = document.activeElement
      if (!open) opener.current = current instanceof HTMLElement ? current : null
      if (controlledOpen === undefined) setOpen(!open)
      onOpenChange?.(!open)
    }
    const matches = hotkey
    document.addEventListener('keydown', toggle)
    return () => document.removeEventListener('keydown', toggle)
  }, [hotkey, controlledOpen, onOpenChange, open])

  function close() {
    if (controlledOpen === undefined) setOpen(false)
    onOpenChange?.(false)
  }

  function finalFocus() {
    const previous = opener.current
    opener.current = null
    return previous?.isConnected ? previous : true
  }

  const strings = { ...commandPaletteMessages, ...messages }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogPortal>
        <DialogOverlay className="motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none motion-reduce:transition-none" />
        <DialogPopup
          initialFocus={input}
          finalFocus={finalFocus}
          className="fixed inset-x-4 top-[15vh] z-50 mx-auto grid max-w-xl gap-2 rounded-xl bg-popover p-3 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none"
        >
          <DialogTitle className="sr-only">{strings.title}</DialogTitle>
          {open && (
            <PaletteSearch
              sources={sources}
              delay={debounceMs}
              strings={strings}
              input={input}
              close={close}
              onNavigate={onNavigate}
            />
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  )
}

function PaletteSearch({
  sources,
  delay,
  strings,
  input,
  close,
  onNavigate,
}: {
  sources: readonly CommandSource[]
  delay: number
  strings: CommandPaletteMessages
  input: RefObject<HTMLInputElement | null>
  close: () => void
  onNavigate: CommandPaletteProps['onNavigate']
}) {
  const listId = useId()
  const [text, setText] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const { groups, retry } = useCommandResults(sources, text.trim(), delay)
  const options = groups.map(({ source, result }) => {
    const groupId = `${listId}-group-${encodeURIComponent(source.id)}`
    return {
      source,
      result,
      groupId,
      label: source.label ?? strings.group,
      items:
        result.state === 'ready'
          ? result.commands.map((command) => ({
              command,
              id: `${listId}-option-${encodeURIComponent(source.id)}:${encodeURIComponent(command.id)}`,
            }))
          : [],
    }
  })
  const items = options.flatMap(({ items }) => items)
  const selected = items.find(({ id }) => id === selectedId) ?? items[0]

  const activeId = selected?.id
  // Preserve the active command if an earlier group finishes searching later.
  if (selectedId !== activeId) setSelectedId(activeId)
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  function activateResult(id: string, href: string | undefined, newTab: boolean) {
    if (!newTab) {
      document.getElementById(id)?.querySelector<HTMLElement>('a,button')?.click()
    } else if (href !== undefined) {
      window.open(href, '_blank', 'noopener,noreferrer')
      close()
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!selected || event.nativeEvent.isComposing || event.altKey || event.shiftKey) return
    const { key, metaKey, ctrlKey } = event
    if (key === 'Enter') {
      event.preventDefault()
      activateResult(selected.id, selected.command.href, metaKey || ctrlKey)
      return
    }
    if (metaKey || ctrlKey) return
    const next = listIndexForKey(key, items.indexOf(selected), items.length)
    if (next === undefined) return
    event.preventDefault()
    setSelectedId(items[next]?.id)
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b pb-2">
        <SearchIcon aria-hidden="true" className="ml-2 size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={input}
          role="combobox"
          aria-label={strings.placeholder}
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={selected?.id}
          autoComplete="off"
          placeholder={strings.placeholder}
          value={text}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value)
            setSelectedId(undefined)
          }}
          className="border-none bg-transparent dark:bg-transparent"
        />
        <DialogClose
          render={
            <Button type="button" size="icon-sm" variant="ghost" aria-label={strings.close} />
          }
        >
          <XIcon aria-hidden="true" />
        </DialogClose>
      </div>
      <div className="max-h-[55vh] overflow-y-auto">
        <div id={listId} role="listbox" aria-label={strings.results}>
          {options.map(
            ({ groupId, items, label }) =>
              items.length > 0 && (
                <fieldset key={groupId} className="min-w-0 py-1">
                  <legend className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {label}
                  </legend>
                  {items.map(({ id, command }) => (
                    <div
                      key={id}
                      id={id}
                      role="option"
                      tabIndex={-1}
                      aria-selected={activeId === id}
                    >
                      <CommandEntry command={command} close={close} onNavigate={onNavigate} />
                    </div>
                  ))}
                </fieldset>
              ),
          )}
        </div>
        {options.length === 0 && (
          <p role="status" className="p-2">
            {strings.empty}
          </p>
        )}
        {options.map(
          ({ source, groupId, label, items, result }) =>
            items.length === 0 && (
              <div
                key={groupId}
                className="flex items-center justify-between px-2 py-1 text-muted-foreground"
              >
                <p id={groupId} role="status">
                  {label}:{' '}
                  {result.state === 'loading'
                    ? strings.loading
                    : result.state === 'error'
                      ? strings.error
                      : strings.empty}
                </p>
                {result.state === 'error' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-describedby={groupId}
                    onClick={() => {
                      input.current?.focus()
                      retry(source.id)
                    }}
                  >
                    {strings.retry}
                  </Button>
                )}
              </div>
            ),
        )}
      </div>
    </>
  )
}

function listIndexForKey(key: string, index: number, length: number) {
  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return length - 1
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'ArrowDown':
      return Math.min(length - 1, index + 1)
  }
}
