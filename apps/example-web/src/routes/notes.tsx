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
} from '@kit/ui'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useSearch } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '../components/app-shell'
import { NotesCreateDialog } from '../components/notes-create-dialog'
import { NotesTable } from '../components/notes-table'
import { SafeMarkdown } from '../components/safe-markdown'
import { apiErrorToMessage } from '../lib/api'
import { useLocale } from '../lib/locale'
import { type Note, useDeleteNote, useNotes } from '../lib/notes'

export function NotesPage() {
  const { m } = useLocale()
  const { noteId, reveal } = useSearch({ from: '/app/notes' })
  const [open, setOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null)
  const notes = useNotes()
  const deleteNote = useDeleteNote()

  useHotkey('Mod+Shift+N', () => setOpen(true), {
    preventDefault: true,
  })

  return (
    <div>
      <PageHeader
        title={m.notes}
        description={m.notesDesc}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus />
            {m.createNote}
          </Button>
        }
      />

      <NotesTable
        key={JSON.stringify([noteId, reveal])}
        notes={notes}
        selectedNoteId={noteId}
        onDelete={setPendingDelete}
        onCreate={() => setOpen(true)}
      />

      <NotesCreateDialog open={open} onOpenChange={setOpen} />

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(v) => {
          if (!v) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.delete}</AlertDialogTitle>
            <AlertDialogDescription>{m.confirmDelete}</AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDelete ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{pendingDelete.title}</p>
              {pendingDelete.body?.trim() ? (
                <div className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground">
                  <SafeMarkdown>{pendingDelete.body}</SafeMarkdown>
                </div>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteNote.isPending}
              onClick={() =>
                pendingDelete &&
                deleteNote.mutate(pendingDelete.id, {
                  onSuccess: () => {
                    toast.success(m.noteDeleted)
                    setPendingDelete(null)
                  },
                  onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
                })
              }
            >
              {m.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
