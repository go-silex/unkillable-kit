import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@kit/ui'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '../components/app-shell'
import { apiErrorToMessage, apiFetch } from '../lib/api'
import { useLocale } from '../lib/locale'
import { type CreateItemValues, createItemSchema, updateItemSchema } from '../lib/schemas'

type Item = { id: string; code: string; label: string; description: string; active: boolean }

export function ItemsPage() {
  const { m } = useLocale()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editItem, setEditItem] = useState<Item | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Item | null>(null)
  const [q, setQ] = useState('')

  const itemsQueryKey = ['items', q] as const

  const items = useQuery({
    queryKey: itemsQueryKey,
    queryFn: () => {
      const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
      return apiFetch<{ items: Item[] }>(`/api/items${qs}`)
    },
  })

  const createItem = useMutation({
    mutationFn: (input: CreateItemValues) => {
      return apiFetch('/api/items', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: itemsQueryKey })
      toast.success(m.itemCreated)
    },
    onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
  })

  const updateItem = useMutation({
    mutationFn: (input: { id: string; label: string; description: string; active: boolean }) => {
      return apiFetch(`/api/items/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: input.label,
          description: input.description,
          active: input.active,
        }),
      })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: itemsQueryKey })
      toast.success(m.itemUpdated)
      setEditItem(null)
    },
    onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
  })

  const deleteItem = useMutation({
    mutationFn: (id: string) => {
      return apiFetch(`/api/items/${id}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: itemsQueryKey })
      toast.success(m.itemDeleted)
      setPendingDelete(null)
    },
    onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
  })

  const createForm = useForm({
    defaultValues: { code: '', label: '', description: '' },
    onSubmit: async ({ value }) => {
      const parsed = createItemSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(m.error, { description: m.errValidation })
        return
      }
      await createItem.mutateAsync(parsed.data)
      createForm.reset()
      setCreateOpen(false)
    },
  })

  const editForm = useForm({
    defaultValues: { label: '', description: '', active: true },
    onSubmit: async ({ value }) => {
      if (!editItem) return
      const parsed = updateItemSchema.safeParse(value)
      if (!parsed.success) {
        toast.error(m.error, { description: m.errValidation })
        return
      }
      await updateItem.mutateAsync({ id: editItem.id, ...parsed.data })
    },
  })

  const rows = items.data?.items ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.itemsTitle}
        description={m.itemsDescription}
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {m.itemCreate}
          </Button>
        }
      />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={m.itemSearchPlaceholder}
        className="max-w-sm"
      />
      {items.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.isError ? (
        <p className="text-sm text-destructive">{apiErrorToMessage(items.error, m)}</p>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.itemEmptyTitle}</EmptyTitle>
            <EmptyDescription>{m.itemEmptyDescription}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={() => setCreateOpen(true)}>
              {m.itemCreate}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.itemCode}</TableHead>
              <TableHead>{m.itemLabel}</TableHead>
              <TableHead>{m.itemActive}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.code}</TableCell>
                <TableCell className="font-medium">{row.label}</TableCell>
                <TableCell>{row.active ? m.itemActiveYes : m.itemActiveNo}</TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditItem(row)
                      editForm.setFieldValue('label', row.label)
                      editForm.setFieldValue('description', row.description)
                      editForm.setFieldValue('active', row.active)
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setPendingDelete(row)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.itemCreate}</DialogTitle>
            <DialogDescription>{m.itemsDescription}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void createForm.handleSubmit()
            }}
          >
            <createForm.Field name="code">
              {(f) => (
                <Field>
                  <FieldLabel>{m.itemCode}</FieldLabel>
                  <Input value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />
                </Field>
              )}
            </createForm.Field>
            <createForm.Field name="label">
              {(f) => (
                <Field>
                  <FieldLabel>{m.itemLabel}</FieldLabel>
                  <Input value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />
                </Field>
              )}
            </createForm.Field>
            <createForm.Field name="description">
              {(f) => (
                <Field>
                  <FieldLabel>{m.itemDescription}</FieldLabel>
                  <Textarea
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value)}
                  />
                </Field>
              )}
            </createForm.Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                {m.cancel}
              </Button>
              <Button type="submit" disabled={createItem.isPending}>
                {m.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editItem} onOpenChange={(o) => !o && setEditItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.itemEdit}</DialogTitle>
            <DialogDescription>{editItem?.code}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void editForm.handleSubmit()
            }}
          >
            <editForm.Field name="label">
              {(f) => (
                <Field>
                  <FieldLabel>{m.itemLabel}</FieldLabel>
                  <Input value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />
                </Field>
              )}
            </editForm.Field>
            <editForm.Field name="description">
              {(f) => (
                <Field>
                  <FieldLabel>{m.itemDescription}</FieldLabel>
                  <Textarea
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value)}
                  />
                </Field>
              )}
            </editForm.Field>
            <editForm.Field name="active">
              {(f) => (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.state.value}
                    onChange={(e) => f.handleChange(e.target.checked)}
                  />
                  {m.itemActive}
                </label>
              )}
            </editForm.Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditItem(null)}>
                {m.cancel}
              </Button>
              <Button type="submit" disabled={updateItem.isPending}>
                {m.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.itemDeleteConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? `${pendingDelete.code} — ${pendingDelete.label}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && deleteItem.mutate(pendingDelete.id)}>
              {m.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
