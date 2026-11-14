import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../lib/api'
import { en } from '../messages/en'
import { createApiDispatcher } from '../test/api-mock'
import { createMe } from '../test/factories'
import { renderWithAppProviders } from '../test/render'
import { KeysPage } from './keys'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiFetch: vi.fn() }
})

const fetchMock = vi.mocked(apiFetch)
const org = {
  id: 'org_acme',
  name: 'Acme',
  slug: 'acme',
  kind: 'client',
  status: 'active',
  role: 'admin',
}

beforeEach(() => {
  localStorage.setItem('kit.locale', 'en')
  fetchMock.mockImplementation(
    createApiDispatcher()
      .on('GET', '/api/keys', () => ({
        keys: [{ id: 'key_12345678', scopes: ['write', 'admin'], revokedAt: null }],
        requestId: 'req_test',
      }))
      .on('POST', '/api/keys', () => ({ id: 'key_new', key: 'sk_test' })).fetch,
  )
})

afterEach(() => fetchMock.mockReset())

function renderPage() {
  return renderWithAppProviders(<KeysPage />, { me: createMe({ orgs: [org] }) })
}

describe('KeysPage scopes', () => {
  it('defaults to read only, submits it, and displays listed scopes', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.getByRole('checkbox', { name: en.keyScopeRead })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: en.keyScopeWrite })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: en.keyScopeAdmin })).not.toBeChecked()
    expect(await screen.findByText('Scopes: write, admin')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: en.mintKey }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/keys',
        expect.objectContaining({
          method: 'POST',
          headers: { 'X-Org-Id': 'org_acme' },
          body: JSON.stringify({ organizationId: 'org_acme', scopes: ['read'] }),
        }),
      ),
    )
    expect(await screen.findByDisplayValue('sk_test')).toBeInTheDocument()
  })

  it('allows independent write and admin scopes and prevents an empty selection', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('checkbox', { name: en.keyScopeRead }))
    expect(screen.getByRole('button', { name: en.mintKey })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: en.keyScopeWrite }))
    await user.click(screen.getByRole('checkbox', { name: en.keyScopeAdmin }))
    await user.click(screen.getByRole('button', { name: en.mintKey }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/keys',
        expect.objectContaining({
          body: JSON.stringify({ organizationId: 'org_acme', scopes: ['write', 'admin'] }),
        }),
      ),
    )
    expect(await screen.findByDisplayValue('sk_test')).toBeInTheDocument()
  })
})
