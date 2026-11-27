# `@kit/ui` — kit surface

Shared **shadcn Base UI** primitives for Chemin A apps. Product branding does **not** live here.

## What it is

- Package: `packages/ui` → import `@kit/ui`.
- Styles: `@kit/ui/styles.css` (`@kit/ui/globals.css` alias) includes Geist.
- Catalog: `/admin/design-system` (platform session required).

## Theme

From `@kit/ui`, import `ThemeProvider`, `useTheme`, and `Theme`. Wrap the App with `<ThemeProvider storageKey="kit.theme">` using an App-owned key. `useTheme()` returns `theme` (`light`, `dark`, `system`), `setTheme`, and the resolved theme. The provider toggles root `.dark` and tracks system changes in `system` mode. Invalid or inaccessible storage uses `system`, which resolves to `light` without a system preference.

The Example App’s `public/theme-boot.js` uses `kit.theme` before React mounts; match the provider’s key and theme rules.

## Zero-edit / product brand

Custom font: import `@kit/ui/base.css` → App fonts → [App tokens](product-consumer-contract.md#design-overrides-accepted--no-exception-needed). Set `--font-sans` on `:root`; headings follow. Base alone uses system fonts.

Modal backdrops: set `--overlay` on `:root` and `.dark` (default 10% black). On `ui:add`, keep `bg-overlay` in `dialog.tsx`, `alert-dialog.tsx`, and `sheet.tsx`.

Keep branding, shells, and release notes in the App. Share changelog code only when two Products need it.

## Conventions for example-web

- Destructive confirmation: `AlertDialog`, not `window.confirm`.
- Empty lists: `Empty` with `EmptyHeader`, `EmptyMedia` and `EmptyTitle`.
- Selects: Base UI `Select` with `items`, not native `<select>`.
- Forms: TanStack Form, Zod (`lib/schemas.ts`) and Kit `Field`.
- i18n: App catalogs (`src/messages/*`); `LocaleSwitcher` uses `createI18n` locales and hides for one locale.
- Local D1 seed: `bun run db:seed` after `db:migrate`; reapplies SQL only if `d1_migrations` is missing.

## Exports

See `packages/ui/src/index.ts` and the catalogue for exports.
`Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` switch local panels.
Set `activateOnFocus={false}` on `TabsList` for manual activation.
Pass App i18n labels: `PasswordInput` `showPasswordLabel`/`hidePasswordLabel`; `DialogContent`, `DialogFooter`, `SheetContent` `closeLabel`; `Sidebar` `mobileTitle`/`mobileDescription`; `SidebarTrigger`, `SidebarRail` `toggleLabel`.

### Tasks-related primitives (shadcn, 2026-08)

| Export                                | Source                                                            | Use                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Calendar`                            | `shadcn add calendar`                                             | Day grid (`react-day-picker`)                                                                            |
| `DatePicker`                          | Kit composition (Popover + Calendar) — no base-nova registry item | Due dates; pass `placeholder` from app i18n                                                              |
| `LocaleSwitcher`                      | Kit composition (Button / DropdownMenuItem)                       | Auth chips + settings + shell menu. Pass `locales` from `@kit/i18n`. Renders nothing for a single locale |
| `Popover*`                            | `shadcn add popover`                                              | Anchored overlays                                                                                        |
| `Combobox*` (+ `ComboboxChips` multi) | `shadcn add combobox`                                             | Assignees / multi-select                                                                                 |
| `InputGroup*`                         | pulled in by combobox                                             | Input chrome                                                                                             |

Add more via `bun run --filter @kit/ui ui:add <name>`.

### Command palette

Mount one `CommandPalette` from `@kit/ui` in the Product shell. `sources` is its
registration prop. Source IDs are unique per palette; command IDs per source.

```tsx
import { CommandPalette, type CommandSource } from '@kit/ui'

const sources = [
  {
    id: 'navigation',
    label: 'Navigation',
    commands: [{ id: 'home', label: 'Home', keywords: ['dashboard'], href: '/' }],
  },
] satisfies readonly CommandSource[]

export function ProductShell() {
  return <CommandPalette sources={sources} />
}
```

- A static `Command` has `id`, `label`, optional `keywords`, `icon` and `shortcut`
  (display only), and either `run` or `href`. All whitespace-separated terms must
  match the label or keywords, case-insensitively.
- `search(query, { signal })` receives the trimmed query (initially empty) after
  `debounceMs` (200 ms). Honor abort: close, query changes and removing or replacing
  the source's search callback cancel obsolete work. Unchanged searches survive
  other registration changes. Retry only reruns the failed source.
- `open` and `onOpenChange` support a Product-owned trigger. The default
  Cmd/Ctrl+K toggles from text fields too; pass `hotkey={false}` to opt out, or
  pass a predicate to match a different keyboard event. `href` uses a native link;
  an optional `onNavigate(href)` handles ordinary same-tab navigation. Modified
  clicks keep browser behavior.
- The combobox controls a grouped listbox. Up/Down stop at the ends; Home/End
  jump to first/last. Enter activates the option itself; Cmd/Ctrl+Enter opens its
  link in a new tab. Escape restores focus. A polite live region announces
  loading, counts, empty results and errors. Reduced motion disables animation.
- Override `messages` from `@kit/i18n`: `title`, `close`, `placeholder`, `results`,
  `group`, `empty`, `loading`, `error`, `retry`, `resultCount(count)`, `sourceStatus(label, status)`.
  Products supply source and command labels, keywords, and shortcut hints.

A command is a UI affordance, **never authorization**. Filter commands by the
applicable Organization Role or Platform Role; API guards still enforce access.
There is no ambient registry. Remount the palette when its Organization changes.
`example-web` registers navigation and cancelable notes search with links to exact rows.

### Sidebar 07 block (shadcn)

`bunx --bun shadcn@latest add sidebar-07` in `packages/ui` generates Acme chrome (`AppSidebar`, `NavMain`, `NavProjects`, `TeamSwitcher`); delete after install: it is not `@kit/ui` API and must stay out.

| Export                         | Role                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `NavUser`                      | Footer user menu — pass `user`, optional `children` items, `onLogout` |
| `Breadcrumb*` / `Collapsible*` | Supporting primitives                                                 |

`example-web` composes `Sidebar` + `OrgSwitcher` + `NavUser`.

## TanStack (example-web)

| Package                   | Role in kit                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `@tanstack/react-router`  | SPA routes                                                       |
| `@tanstack/react-query`   | Server state                                                     |
| `@tanstack/react-form`    | Forms + Zod validators (login, notes, …)                         |
| `@tanstack/react-table`   | Headless tables (v9 `useTable`: notes list, design-system demo)  |
| `@tanstack/react-hotkeys` | Shortcuts (`HotkeysProvider` in `main.tsx`; notes `Mod+Shift+N`) |
| `@tanstack/markdown`      | Markdown render (`@tanstack/markdown/react` on note body)        |

### TanStack Table v9

The Example App follows the official [v8 → v9 migration guide](https://tanstack.com/table/latest/docs/framework/react/guide/migrating) without the deprecated `useLegacyTable` bridge.

- Declare `tableFeatures()` at module scope. `listTableFeatures` (`src/components/list-table.ts`)
  registers sorting, column and global filters, `text`/`alphanumeric` sort and `includesString`.
- Register named `filterFn`/`globalFilterFn` values, including the column's `'auto'` choice.
  Unregistered names warn only in development and skip filtering. Functions need no registration;
  `globalFilterFn: 'auto'` uses built-in `includesString`. Notes titles and both global filters
  use the registered `includesString`; the body and status filters pass functions.
- An unknown `sortFn` warns only in development and falls back. Auto `alphanumeric` uses a
  registered `text`, otherwise case-sensitive `basic`. The Example App registers both string sorts.
- Keep features, columns and fallback data stable: build `columnHelper.columns(...)` in
  `useMemo` and use a module constant for the notes fallback.
- Give each state slice one owner: table, React state (with `on<Slice>Change` when the table writes
  it), or atom. The table owns sorting; search and filter inputs own their own slices.
- Render via `FlexRender`; iterate `row.getAllCells()` unless `columnVisibilityFeature` is
  registered. `SortableTableHead` keeps `aria-sort` and a labelled sort button.

### List data shapes

| Data shape                                | Default                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| Unbounded catalogue                       | Cursor envelope `{ items, nextCursor, requestId }`           |
| Small lookup or documented demo-size data | Known-small dump or hard cap                                 |
| Aggregate or insights                     | Server-side aggregate, not browser reduction over paged rows |

The notes dump is a documented demo-size exception. If it becomes an unbounded catalogue, migrate it to the cursor envelope. Contract and trade-offs: [ADR-0010](architecture/adr/0010-list-page-cursor-envelope.md).

## Related

- Stack: `AGENTS.md` § UI / packages · `.dev/stack.yml`
- Testing: design-system overlay e2e `bun run test:e2e:design-system` (API + web up)
