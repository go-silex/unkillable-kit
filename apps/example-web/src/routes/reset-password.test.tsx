import { RouterProvider } from '@tanstack/react-router'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { healthQueryKey } from '../lib/health'
import { en } from '../messages/en'
import { routeTree } from '../routeTree'
import { createTestQueryClient } from '../test/query-client'
import { createTestRouter, renderWithAppProviders } from '../test/render'

it('offers another link when a direct reset link is rejected as invalid', async () => {
  localStorage.setItem('kit.locale', 'en')
  const fetch = vi.fn(async () =>
    Response.json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, { status: 400 }),
  )
  vi.stubGlobal('fetch', fetch)
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(healthQueryKey, { ok: true, requestId: 'req_fixture' })
  const resetPath = '/reset-password'
  const issuedLink = new URL(resetPath, 'https://app.example')
  issuedLink.searchParams.set('token', 'invalid')
  const router = createTestRouter(routeTree, `${resetPath}${issuedLink.search}`, queryClient)
  renderWithAppProviders(<RouterProvider router={router} />, { queryClient })

  const passwordInput = await screen.findByLabelText(en.resetPasswordNew)
  await waitFor(() => expect(router.state.location.href).toBe(resetPath))
  expect(router.history.canGoBack()).toBe(false)
  const user = userEvent.setup()
  const password = 'x'.repeat(12)
  await user.type(passwordInput, password)
  await user.type(screen.getByLabelText(en.resetPasswordConfirm), password)
  await user.click(screen.getByRole('button', { name: en.resetPasswordSubmit }))

  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/auth/reset-password',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ newPassword: password, token: issuedLink.searchParams.get('token') }),
    }),
  )
  expect(await screen.findByText(en.resetPasswordInvalidLink)).toBeVisible()
  expect(screen.getByRole('button', { name: en.forgotPassword })).toHaveAttribute(
    'href',
    '/forgot-password',
  )
  expect(screen.queryByLabelText(en.resetPasswordNew)).not.toBeInTheDocument()
  expect(router.state.location.href).toBe(resetPath)
})
