import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@kit/ui'
import { useForm } from '@tanstack/react-form'
import { createColumnHelper, FlexRender, useTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useLocale } from '../../lib/locale'
import { type ListTableFeatures, listTableFeatures } from '../list-table'
import { SafeMarkdown } from '../safe-markdown'
import { SortableTableHead } from '../sortable-table-head'
import { DemoBox, Section } from './section'

type DemoRow = { id: string; name: string; status: 'ok' | 'pending' }

const demoCol = createColumnHelper<ListTableFeatures, DemoRow>()

const DEMO_ROWS: DemoRow[] = [
  { id: '1', name: 'hello kit', status: 'ok' },
  { id: '2', name: 'verify-kit', status: 'ok' },
  { id: '3', name: 'draft', status: 'pending' },
]

const demoFormSchema = z.object({
  title: z.string().min(1),
})

const mdSample = `### TanStack Markdown

Body notes use the same renderer on **\`/app/notes\`**.

- list item
- **bold** and \`code\`
`

export function TanstackSection() {
  const { m } = useLocale()

  const tsForm = useForm({
    defaultValues: { title: '' },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = demoFormSchema.safeParse(value)
        if (parsed.success) return
        return { form: m.errValidation, fields: { title: m.errValidation } }
      },
    },
    onSubmit: async ({ value }) => {
      toast.success('TanStack Form', { description: value.title })
      tsForm.reset()
    },
  })

  const [tsSearch, setTsSearch] = useState('')
  const [tsStatus, setTsStatus] = useState<'all' | 'ok' | 'pending'>('all')

  const tsColumns = useMemo(
    () =>
      demoCol.columns([
        demoCol.accessor('name', {
          header: 'Name',
          enableSorting: true,
          cell: (info) => <span className="font-medium">{info.getValue()}</span>,
        }),
        demoCol.accessor('status', {
          header: 'Status',
          enableSorting: true,
          filterFn: (row, _id, value: string) => {
            if (!value || value === 'all') return true
            return row.getValue('status') === value
          },
          cell: (info) => (
            <Badge variant={info.getValue() === 'ok' ? 'secondary' : 'outline'}>
              {info.getValue()}
            </Badge>
          ),
        }),
      ]),
    [],
  )
  const tsStatusItems = useMemo(
    () => [
      { value: 'all' as const, label: m.tableFilterAll },
      { value: 'ok' as const, label: 'ok' },
      { value: 'pending' as const, label: 'pending' },
    ],
    [m.tableFilterAll],
  )
  // Sorting stays table-owned; search owns the global filter, status derives the column filter.
  const tsTable = useTable({
    features: listTableFeatures,
    data: DEMO_ROWS,
    columns: tsColumns,
    state: {
      globalFilter: tsSearch,
      columnFilters: tsStatus === 'all' ? [] : [{ id: 'status', value: tsStatus }],
    },
    onGlobalFilterChange: setTsSearch,
    globalFilterFn: 'includesString',
  })

  return (
    <Section id="tanstack" title={m.dsTanstack} description={m.dsTanstackDesc}>
      <div className="grid gap-4">
        <DemoBox title="@tanstack/react-form + Zod">
          <form
            className="flex max-w-md flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void tsForm.handleSubmit()
            }}
          >
            <tsForm.Field name="title">
              {(field) => {
                const err = field.state.meta.errors[0]
                const invalid = Boolean(err)
                return (
                  <Field data-invalid={invalid || undefined}>
                    <FieldLabel htmlFor="ts-title">{m.title}</FieldLabel>
                    <Input
                      id="ts-title"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                      placeholder="Submit empty → validation"
                    />
                    {invalid ? <FieldError>{String(err)}</FieldError> : null}
                  </Field>
                )
              }}
            </tsForm.Field>
            <Button type="submit" size="sm" className="w-fit">
              {m.submit}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            Live forms also on /login and /app/notes.
          </p>
        </DemoBox>

        <DemoBox title="@tanstack/react-table + UI Table">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={tsSearch}
              onChange={(e) => setTsSearch(e.target.value)}
              placeholder={m.tableSearch}
              className="sm:max-w-56"
              aria-label={m.tableSearch}
            />
            <Select
              items={tsStatusItems}
              value={tsStatus}
              onValueChange={(v) => {
                if (v === 'all' || v === 'ok' || v === 'pending') setTsStatus(v)
              }}
            >
              <SelectTrigger className="sm:w-36" aria-label={m.tableFilter}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {tsStatusItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              {tsTable.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <SortableTableHead key={header.id} header={header} sortHint={m.tableSortHint} />
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {tsTable.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-muted-foreground">
                    {m.tableNoResults}
                  </TableCell>
                </TableRow>
              ) : (
                tsTable.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">
            Product list dogfood: /app/notes (sort + search + filter).
          </p>
        </DemoBox>

        <DemoBox title="@tanstack/markdown/react">
          <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border p-4">
            <SafeMarkdown>{mdSample}</SafeMarkdown>
          </div>
        </DemoBox>
      </div>
    </Section>
  )
}
