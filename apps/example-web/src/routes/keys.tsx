import type {
  ApiKeyScope,
  ListApiKeysResponse,
  MintApiKeyRequest,
  MintApiKeyResponse,
} from '@kit/api-client/me'
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
} from '@kit/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '../components/app-shell'
import { apiErrorToMessage, apiFetch } from '../lib/api'
import { useLocale } from '../lib/locale'
import { useOrgContext } from '../lib/org-context'

/** Plaintext sk_ is shown once then auto-cleared. */
const PLAINTEXT_TTL_MS = 60_000

export function KeysPage() {
  const { m } = useLocale()
  const qc = useQueryClient()
  const { activeOrgId, orgs } = useOrgContext()
  const [minted, setMinted] = useState<{ id: string; key: string } | null>(null)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read'])

  const orgScope = activeOrgId ?? orgs[0]?.id ?? 'none'
  const keysQueryKey = ['keys', orgScope] as const

  const keys = useQuery({
    queryKey: keysQueryKey,
    queryFn: () => {
      const headers: Record<string, string> = {}
      if (orgScope !== 'none') headers['X-Org-Id'] = orgScope
      return apiFetch<ListApiKeysResponse>('/api/keys', { headers })
    },
  })

  useEffect(() => {
    if (!minted) return
    const t = window.setTimeout(() => setMinted(null), PLAINTEXT_TTL_MS)
    return () => window.clearTimeout(t)
  }, [minted])

  const mint = useMutation({
    mutationFn: () => {
      const organizationId = activeOrgId ?? orgs[0]?.id
      const headers: Record<string, string> = {}
      if (organizationId) headers['X-Org-Id'] = organizationId
      const body: MintApiKeyRequest = { organizationId, scopes }
      return apiFetch<MintApiKeyResponse>('/api/keys', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (data) => {
      setMinted(data)
      toast.success(m.keyMinted)
      await qc.invalidateQueries({ queryKey: keysQueryKey })
    },
    onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success(m.keyRevoked)
      await qc.invalidateQueries({ queryKey: keysQueryKey })
    },
    onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
  })

  const copy = async () => {
    if (!minted?.key) return
    try {
      await navigator.clipboard.writeText(minted.key)
      toast.success(m.copied)
      // Clear plaintext from UI after successful copy
      setMinted(null)
    } catch (e) {
      toast.error(m.error, { description: apiErrorToMessage(e, m) })
    }
  }

  const activeKeys = (keys.data?.keys ?? []).filter((k) => k.revokedAt == null)

  return (
    <div>
      <PageHeader title={m.keys} description={m.keysDesc} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              {m.mintKey}
            </CardTitle>
            <CardDescription>{m.mintKeyDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{m.keyScopes}</legend>
              <p className="text-xs text-muted-foreground">{m.keyScopesHelp}</p>
              {(
                [
                  ['read', m.keyScopeRead],
                  ['write', m.keyScopeWrite],
                  ['admin', m.keyScopeAdmin],
                ] as const
              ).map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setScopes((current) =>
                        checked ? [...current, scope] : current.filter((value) => value !== scope),
                      )
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <Button onClick={() => mint.mutate()} disabled={mint.isPending || scopes.length === 0}>
              {m.mintKey}
            </Button>
            {minted ? (
              <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {m.keyOnce}
                </p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={minted.key}
                    className="font-mono text-xs"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={m.copyKey}
                    onClick={() => void copy()}
                  >
                    <Copy />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">id: {minted.id}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-sm font-medium">{m.keysList}</p>
              {keys.isLoading ? (
                <p className="text-xs text-muted-foreground">{m.loading}</p>
              ) : keys.isError ? (
                <p className="text-xs text-destructive">{m.loadFailed}</p>
              ) : activeKeys.length === 0 ? (
                <Empty className="border border-dashed border-border py-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <KeyRound className="size-4" aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>{m.emptyKeys}</EmptyTitle>
                    <EmptyDescription>{m.mintKeyDesc}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="space-y-2">
                  {activeKeys.map((k) => (
                    <li
                      key={k.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="block truncate font-mono">{k.id.slice(0, 8)}…</span>
                        <span>
                          {m.keyScopes}: {k.scopes.join(', ') || '—'}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={m.revokeKey}
                        disabled={revoke.isPending}
                        onClick={() => setRevokeId(k.id)}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <AlertDialog
          open={revokeId != null}
          onOpenChange={(open) => {
            if (!open) setRevokeId(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.revokeKey}</AlertDialogTitle>
              <AlertDialogDescription>{m.confirmRevoke}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{m.cancel}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={revoke.isPending}
                onClick={() => {
                  if (revokeId) revoke.mutate(revokeId)
                  setRevokeId(null)
                }}
              >
                {m.revokeKey}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{m.bearerTitle}</CardTitle>
            <CardDescription>{m.bearerDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{m.bearerHelp}</p>
            <p>{m.bearerSessionNote}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
