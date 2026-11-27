/** English fallbacks for Kit chrome; Products own their locale catalogs. */
export const commandPaletteMessages = {
  title: 'Command palette',
  close: 'Close command palette',
  placeholder: 'Search commands…',
  results: 'Results',
  group: 'Commands',
  empty: 'No results',
  loading: 'Loading…',
  error: 'Could not load results',
  retry: 'Retry',
  resultCount: (count: number) => `${count} ${count === 1 ? 'result' : 'results'}`,
  sourceStatus: (label: string, status: string) => `${label}: ${status}`,
}

export type CommandPaletteMessages = typeof commandPaletteMessages
