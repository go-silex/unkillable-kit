import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@kit/ui'
import {
  type ColumnFiltersState,
  createColumnHelper,
  FlexRender,
  useTable,
} from '@tanstack/react-table'
import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { apiErrorToMessage } from '../lib/api'
import { useLocale } from '../lib/locale'
import type { Note, NotesQuery } from '../lib/notes'
import { type ListTableFeatures, listTableFeatures } from './list-table'
import { SafeMarkdown } from './safe-markdown'
import { SortableTableHead } from './sortable-table-head'

type BodyFilter = 'all' | 'with' | 'empty'

const col = createColumnHelper<ListTableFeatures, Note>()

/** Stable fallback: a fresh `[]` on every render would invalidate the table's row models. */
const NO_NOTES: Note[] = []

export function NotesTable({
  notes,
  onDelete,
  onCreate,
}: {
  notes: NotesQuery
  onDelete: (note: Note) => void
  onCreate: () => void
}) {
  const { m } = useLocale()
  const [globalFilter, setGlobalFilter] = useState('')
  const [bodyFilter, setBodyFilter] = useState<BodyFilter>('all')
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])

  const data = notes.data?.notes ?? NO_NOTES

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('title', {
          header: m.title,
          enableSorting: true,
          filterFn: 'includesString',
          cell: (info) => <span className="font-medium">{info.getValue()}</span>,
        }),
        col.accessor('body', {
          header: m.body,
          enableSorting: true,
          // Custom filter for empty / with body
          filterFn: (row, _id, value: BodyFilter) => {
            if (!value || value === 'all') return true
            const body = (row.getValue('body') as string | undefined)?.trim() ?? ''
            if (value === 'with') return body.length > 0
            if (value === 'empty') return body.length === 0
            return true
          },
          cell: (info) => {
            const body = info.getValue()
            if (!body?.trim()) {
              return <span className="text-muted-foreground">—</span>
            }
            return (
              <div className="prose prose-sm dark:prose-invert line-clamp-3 max-w-md text-muted-foreground [&_p]:m-0">
                <SafeMarkdown>{body}</SafeMarkdown>
              </div>
            )
          },
        }),
        col.display({
          id: 'actions',
          enableSorting: false,
          header: () => null,
          cell: ({ row }) => (
            <div className="text-right">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={m.delete}
                onClick={() => onDelete(row.original)}
              >
                <Trash2 className="text-destructive" />
              </Button>
            </div>
          ),
        }),
      ]),
    [m.title, m.body, m.delete, onDelete],
  )

  const filterItems = useMemo(
    () => [
      { value: 'all' as const, label: m.tableFilterAll },
      { value: 'with' as const, label: m.tableFilterWithBody },
      { value: 'empty' as const, label: m.tableFilterEmptyBody },
    ],
    [m.tableFilterAll, m.tableFilterWithBody, m.tableFilterEmptyBody],
  )

  // Sorting stays table-owned; the search box and body select own their filter slices.
  const table = useTable({
    features: listTableFeatures,
    data,
    columns,
    state: {
      globalFilter,
      columnFilters,
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    globalFilterFn: 'includesString',
  })

  const setBodyFilterValue = (value: BodyFilter) => {
    setBodyFilter(value)
    setColumnFilters(value === 'all' ? [] : [{ id: 'body', value }])
  }

  const rows = table.getRowModel().rows
  const hasSourceData = data.length > 0

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">{m.notes}</CardTitle>
        {hasSourceData ? (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={m.tableSearch}
              className="sm:w-56"
              aria-label={m.tableSearch}
            />
            <Select
              items={filterItems}
              value={bodyFilter}
              onValueChange={(v) => {
                if (v === 'all' || v === 'with' || v === 'empty') setBodyFilterValue(v)
              }}
            >
              <SelectTrigger className="sm:w-40" aria-label={m.tableFilter}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {filterItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {notes.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : notes.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 py-12 text-center">
            <p className="text-sm font-medium text-destructive">{m.loadFailed}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {apiErrorToMessage(notes.error, m)}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void notes.refetch()
              }}
            >
              {m.retry}
            </Button>
          </div>
        ) : !hasSourceData ? (
          <Empty className="border border-dashed border-border py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plus className="size-4" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{m.empty}</EmptyTitle>
              <EmptyDescription>{m.notesDesc}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm" onClick={onCreate}>
                <Plus />
                {m.createNote}
              </Button>
            </EmptyContent>
          </Empty>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{m.tableNoResults}</p>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <SortableTableHead
                      key={header.id}
                      header={header}
                      sortHint={m.tableSortHint}
                      withAriaSort
                      className={header.column.id === 'actions' ? 'w-[100px]' : undefined}
                    />
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
