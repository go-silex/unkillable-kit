import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * TanStack Table features shared by the Example App's client-side list tables
 * (`NotesTable`, design-system demo) and `SortableTableHead`: sorting plus
 * column and global filtering over rows already loaded in the browser.
 */
export const listTableFeatures = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  // `sortFn: 'auto'` resolves string columns to these by name; otherwise it falls back to `basic`.
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  filterFns: { includesString: filterFn_includesString },
})

export type ListTableFeatures = typeof listTableFeatures
