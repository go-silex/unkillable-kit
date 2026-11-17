import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import type { MeResponse } from '../lib/auth'
import { en } from '../messages/en'
import { createApiDispatcher } from '../test/api-mock'
import { createMe } from '../test/factories'
import { renderWithAppProviders } from '../test/render'
import { ItemsPage } from './items'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    apiFetch: vi.fn(),
  }
})

const fetchMock = vi.mocked(apiFetch)

afterEach(() => {
  fetchMock.mockReset()
})

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  fetchMock.mockImplementation(
    createApiDispatcher()
      .on('GET', '/api/items', () => ({ items: [] }))
      .on('POST', '/api/items', () => ({ item: { id: 'i1' } })).fetch,
  )
})

function wrap(me: MeResponse, ui: ReactElement) {
  return renderWithAppProviders(ui, { me })
}

function meWith(orgs: MeResponse['orgs']): MeResponse {
  return createMe({
    subject: 'user_x',
    email: 'x@kit.local',
    orgs,
    requestId: 'r',
  })
}

const adminOrg = {
  id: 'org_acme',
  name: 'Acme',
  slug: 'acme',
  kind: 'client' as const,
  status: 'active' as const,
  role: 'admin' as const,
}

const readerOrg = { ...adminOrg, role: 'reader' as const }

describe('ItemsPage write chrome', () => {
  it('shows create when role is reader (personal kennel)', async () => {
    wrap(meWith([readerOrg]), <ItemsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    expect(screen.getAllByRole('button', { name: en.itemCreate }).length).toBeGreaterThan(0)
  })

  it('shows create when there is no active org', async () => {
    wrap(meWith([]), <ItemsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    expect(screen.getAllByRole('button', { name: en.itemCreate }).length).toBeGreaterThan(0)
  })

  it('still GETs /api/items without an org header', async () => {
    wrap(meWith([]), <ItemsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const listCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/items'))
    expect(listCall).toBeTruthy()
    const init = listCall?.[1] as { headers?: Record<string, string> } | undefined
    expect(init?.headers?.['X-Org-Id']).toBeUndefined()
  })

  it('does not send X-Org-Id on create (personal kennel)', async () => {
    wrap(meWith([adminOrg]), <ItemsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    fetchMock.mockClear()

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: en.itemCreate })[0]!)
    const fields = screen.getAllByRole('textbox')
    await user.type(fields[0]!, 'sku-one')
    await user.type(fields[1]!, 'One')
    await user.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const post = fetchMock.mock.calls.find(([, init]) => {
      const method = (init as { method?: string } | undefined)?.method
      return method === 'POST'
    })
    expect(post).toBeTruthy()
    const postInit = post?.[1] as { headers?: Record<string, string> } | undefined
    expect(postInit?.headers?.['X-Org-Id']).toBeUndefined()
  })
})

describe('ItemsPage deletion', () => {
  const first = { id: 'i1', code: 'ONE', label: 'First item', description: '', active: true }
  const second = { id: 'i2', code: 'TWO', label: 'Second item', description: '', active: true }

  async function confirmSecond() {
    const user = userEvent.setup()
    const row = (await screen.findByText('Second item')).closest('tr')!
    await user.click(within(row).getAllByRole('button')[1]!)
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('TWO — Second item')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: en.delete }))
  }

  it('retains the item and confirmation on failure without an unhandled rejection', async () => {
    const error = new Error('delete failed')
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      fetchMock.mockImplementation(
        createApiDispatcher()
          .on('GET', '/api/items', () => ({ items: [first, second] }))
          .on('DELETE', '/api/items/i2', () => Promise.reject(error)).fetch,
      )
      wrap(meWith([adminOrg]), <ItemsPage />)
      await confirmSecond()
      await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toContain(error)
      expect(unhandled).toEqual([])
      expect(screen.getByText('Second item')).toBeInTheDocument()
      expect(screen.getByRole('alertdialog')).toHaveTextContent('TWO — Second item')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errorToast.mockRestore()
    }
  })

  it('closes only after the successful deletion refreshes the list without an org header', async () => {
    let releaseRefresh!: (value: { items: (typeof first)[] }) => void
    const refresh = new Promise<{ items: (typeof first)[] }>((resolve) => {
      releaseRefresh = resolve
    })
    let reads = 0
    fetchMock.mockImplementation(
      createApiDispatcher()
        .on('GET', '/api/items', () => (++reads === 1 ? { items: [first, second] } : refresh))
        .on('DELETE', '/api/items/i2', () => ({})).fetch,
    )
    wrap(meWith([adminOrg]), <ItemsPage />)
    await confirmSecond()
    await waitFor(() => expect(reads).toBe(2))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Second item')).toBeInTheDocument()
    const request = fetchMock.mock.calls.find(
      ([path, init]) => path === '/api/items/i2' && init?.method === 'DELETE',
    )
    expect(request).toBeDefined()
    expect(new Headers(request?.[1]?.headers).has('X-Org-Id')).toBe(false)
    releaseRefresh({ items: [first] })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.queryByText('Second item')).not.toBeInTheDocument()
    expect(screen.getByText('First item')).toBeInTheDocument()
  })
})
