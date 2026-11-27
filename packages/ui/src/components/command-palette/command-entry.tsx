import type { Command } from './sources'

export function CommandEntry({
  command,
  close,
  onNavigate,
}: {
  command: Command
  close: () => void
  onNavigate: ((href: string) => void) | undefined
}) {
  const className =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-accent [[aria-selected=true]>&]:bg-accent [[aria-selected=true]>&]:text-accent-foreground'
  const content = (
    <>
      {command.icon != null && (
        <span aria-hidden="true" className="shrink-0 [&_svg]:size-4">
          {command.icon}
        </span>
      )}
      <span className="flex-1 truncate">{command.label}</span>
      {command.shortcut && (
        <kbd className="shrink-0 text-xs text-muted-foreground">{command.shortcut}</kbd>
      )}
    </>
  )
  if (command.href !== undefined) {
    const href = command.href
    return (
      <a
        href={href}
        tabIndex={-1}
        className={className}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return
          if (onNavigate) {
            event.preventDefault()
            onNavigate(href)
          }
          close()
        }}
      >
        {content}
      </a>
    )
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      className={className}
      onClick={() => {
        close()
        command.run()
      }}
    >
      {content}
    </button>
  )
}
