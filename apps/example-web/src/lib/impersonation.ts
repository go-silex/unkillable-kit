import type { ImpersonationInfo } from '@kit/api-client/me'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import {
  apiFetch,
  invalidatePrincipalGeneration,
  StalePrincipalError,
  setImpersonationFence,
} from './api'
import {
  fetchMe,
  type MeResponse,
  meQueryKey,
  setFenceChangeHandler,
  setMeReadBarrier,
} from './auth'

let queryClient: QueryClient | undefined
let revalidate: (() => Promise<unknown>) | undefined
let recovery: ImpersonationInfo | null = null
let revision = 0
let refresh: Promise<void> | undefined
const listeners = new Set<() => void>()
let lifecycle: Promise<void> | undefined
let finishLifecycle: (() => void) | undefined
const channel =
  typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('kit.impersonation')
const noticeKey = 'kit.impersonation.notice'

function setRecovery(info: ImpersonationInfo | null): void {
  if (recovery === info) return
  recovery = info
  for (const listener of listeners) listener()
}

export function useImpersonationRecovery(): ImpersonationInfo | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => recovery,
    () => null,
  )
}

export function isImpersonationRecoveryPending(): boolean {
  return recovery !== null
}

/** Call only after confirmed sign-out, when the previous session is gone. */
export function clearImpersonationRecovery(): void {
  setRecovery(null)
}

function notifyTabs(): void {
  channel?.postMessage('changed')
  try {
    localStorage.setItem(noticeKey, `${Date.now()}-${Math.random()}`)
  } catch {
    // BroadcastChannel and focus refresh remain available when storage is disabled.
  }
}

async function resyncAttempt(
  client: QueryClient,
  invalidateRouter: () => Promise<unknown>,
): Promise<boolean> {
  const started = revision
  const previous = client.getQueryData<MeResponse>(meQueryKey)
  try {
    await client.cancelQueries({ queryKey: meQueryKey, exact: true })
    if (started !== revision) return false
    let receipt: { me: MeResponse; signal: AbortSignal } | undefined
    await client.fetchQuery({
      queryKey: meQueryKey,
      queryFn: async (context) => {
        const signal = context.signal
        const me = await fetchMe(context)
        if (!signal.aborted) receipt = { me, signal }
        return me
      },
      staleTime: 0,
    })
    if (started !== revision) return false
    // TypeScript does not track the assignment inside the query callback.
    const current = receipt as { me: MeResponse; signal: AbortSignal } | undefined
    if (!current || current.signal.aborted) {
      throw new Error('Impersonation refresh did not complete a current network read')
    }
    if (previous && previous.subject !== current.me.subject) {
      invalidatePrincipalGeneration()
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] })
    }
    setRecovery(null)
    await invalidateRouter()
    return started === revision
  } catch (error) {
    if (started !== revision) return false
    await invalidateRouter()
    if (started !== revision) return false
    throw error
  }
}

async function resync(): Promise<void> {
  if (!(queryClient && revalidate)) throw new Error('Impersonation is not configured')
  const client = queryClient
  const invalidateRouter = revalidate
  while (true) {
    if (lifecycle) await lifecycle
    if (await resyncAttempt(client, invalidateRouter)) return
  }
}

/** Join the current refresh; never cancel another lifecycle refresh. */
export function refreshImpersonation(): Promise<void> {
  if (lifecycle) return lifecycle.then(() => refreshImpersonation())
  if (!refresh) {
    refresh = resync().finally(() => {
      refresh = undefined
    })
  }
  return refresh
}

function receiveNotice(): void {
  revision += 1
  if (!lifecycle) invalidatePrincipalGeneration()
  queryClient?.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] })
  // Abort the old /me before it can apply its fence or populate the cache.
  void queryClient?.cancelQueries({ queryKey: meQueryKey, exact: true })
  void refreshImpersonation().catch(() => {})
}

async function beforeMeRead(signal?: AbortSignal): Promise<() => void> {
  while (lifecycle) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const pending = lifecycle
    if (!signal) {
      await pending
    } else {
      // ES2022 does not include Promise.withResolvers; the abort listener must be removed on settlement.
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', abort, { once: true })
        void pending.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
    }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const started = revision
  return () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (lifecycle || started !== revision) throw new StalePrincipalError()
  }
}

export function configureImpersonation(
  client: QueryClient,
  invalidateRouter: () => Promise<unknown>,
): void {
  queryClient = client
  revalidate = invalidateRouter
  setMeReadBarrier(beforeMeRead)
  setFenceChangeHandler(() => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] })
    if (!refresh) void invalidateRouter()
  })
  if (channel) channel.onmessage = receiveNotice
  window.addEventListener('storage', (event) => {
    if (event.key === noticeKey && !channel) receiveNotice()
  })
  window.addEventListener('focus', () => {
    void refreshImpersonation().catch(() => {})
  })
}

export async function switchImpersonation(path: 'start' | 'stop', body: object): Promise<void> {
  while (lifecycle) await lifecycle
  // ES2022 does not include Promise.withResolvers.
  lifecycle = new Promise<void>((resolve) => {
    finishLifecycle = resolve
  })
  revision += 1
  // Cancellation is initiated synchronously; a hung network response must not block Return.
  void queryClient?.cancelQueries({ queryKey: meQueryKey, exact: true })
  invalidatePrincipalGeneration()
  let result: { impersonation: ImpersonationInfo } | undefined
  try {
    result = await apiFetch<{ impersonation: ImpersonationInfo }>(`/api/impersonation/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    // A notice during POST defers generation invalidation until the POST settles.
    invalidatePrincipalGeneration()
    finishLifecycle?.()
    lifecycle = undefined
    finishLifecycle = undefined
    notifyTabs()
    void refreshImpersonation().catch(() => {})
    throw error
  }
  invalidatePrincipalGeneration()
  const prior = recovery ?? queryClient?.getQueryData<MeResponse>(meQueryKey)?.impersonation ?? null
  setRecovery(path === 'start' ? result.impersonation : prior)
  setImpersonationFence(path === 'start' ? result.impersonation.id : null)
  revision += 1
  queryClient?.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] })
  finishLifecycle?.()
  lifecycle = undefined
  finishLifecycle = undefined
  notifyTabs()
  // The POST succeeded. A refresh failure leaves recovery visible, not a false POST error.
  await refreshImpersonation().catch(() => {})
}
