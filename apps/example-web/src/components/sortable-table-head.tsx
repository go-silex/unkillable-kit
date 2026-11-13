import { TableHead } from '@kit/ui'
import { FlexRender, type Header, type RowData } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { ListTableFeatures } from './list-table'

function sortAria(
  canSort: boolean,
  sorted: false | 'asc' | 'desc',
): 'ascending' | 'descending' | 'none' | undefined {
  if (!canSort) return undefined
  if (sorted === 'asc') return 'ascending'
  if (sorted === 'desc') return 'descending'
  return 'none'
}

function SortIcon({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (sorted === 'asc') return <ArrowUp className="size-3.5 opacity-70" aria-hidden />
  if (sorted === 'desc') return <ArrowDown className="size-3.5 opacity-70" aria-hidden />
  return <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
}

type SortableHeadProps<T extends RowData> = {
  header: Header<ListTableFeatures, T>
  sortHint: string
  className?: string
  withAriaSort?: boolean
}

/** Shared sortable table head — keeps list callbacks under the complexity cap. */
export function SortableTableHead<T extends RowData>({
  header,
  sortHint,
  className,
  withAriaSort = false,
}: SortableHeadProps<T>) {
  const canSort = header.column.getCanSort()
  const sorted = header.column.getIsSorted()
  const label = <FlexRender header={header} />
  return (
    <TableHead
      key={header.id}
      className={className}
      aria-sort={withAriaSort ? sortAria(canSort, sorted) : undefined}
    >
      {header.isPlaceholder ? null : canSort ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
          onClick={header.column.getToggleSortingHandler()}
          title={sortHint}
          aria-label={
            withAriaSort ? `${String(header.column.columnDef.header)} — ${sortHint}` : undefined
          }
        >
          {label}
          <SortIcon sorted={sorted} />
        </button>
      ) : (
        label
      )}
    </TableHead>
  )
}
