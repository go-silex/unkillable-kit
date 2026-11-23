/** @vitest-environment happy-dom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChangePasswordForm } from './change-password-form'
import { ForgotPasswordForm } from './forgot-password-form'
import { ResetPasswordForm } from './reset-password-form'

const forgotCopy = {
  email: 'Email',
  errEmailInvalid: 'bad email',
  errValidation: 'invalid',
  forgotSubmit: 'Send',
  forgotEmailHint: 'hint',
  forgotSentTitle: 'sent-title',
  forgotSentDesc: 'sent-desc',
  error: 'Error',
}

const resetCopy = {
  errValidation: 'invalid',
  showPasswordLabel: 'Show password',
  hidePasswordLabel: 'Hide password',
  resetPasswordNew: 'New',
  resetPasswordConfirm: 'Confirm',
  resetPasswordSubmit: 'Reset',
  resetPasswordTooShort: 'short',
  resetPasswordMismatch: 'mismatch',
  resetPasswordMissingToken: 'no token',
  resetPasswordSuccess: 'ok',
  error: 'Error',
}

const changeCopy = {
  errValidation: 'invalid',
  showPasswordLabel: 'Show password',
  hidePasswordLabel: 'Hide password',
  changePasswordCurrent: 'Current',
  changePasswordNew: 'New',
  changePasswordConfirm: 'Confirm',
  changePasswordSubmit: 'Update',
  changePasswordSuccess: 'updated',
  changePasswordWrong: 'wrong',
  changePasswordReauth: 'reauth',
  changePasswordRevokeOthers: 'Revoke others',
  changePasswordTooShort: 'short',
  changePasswordMismatch: 'mismatch',
  changePasswordCurrentRequired: 'required',
  errRateLimited: 'slow',
  loading: '…',
  error: 'Error',
}

describe('ForgotPasswordForm', () => {
  it('POSTs email + redirectTo then shows sent copy', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockResolvedValue({})
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(
      <ForgotPasswordForm
        fetch={authFetch}
        copy={forgotCopy}
        resetRedirectTo="https://app.example/reset-password"
        notify={notify}
      />,
    )
    await user.type(screen.getByLabelText('Email'), 'ada@kit.local')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/auth/request-password-reset',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            email: 'ada@kit.local',
            redirectTo: 'https://app.example/reset-password',
          }),
        }),
      )
    })
    expect(await screen.findByText('sent-desc')).toBeInTheDocument()
    expect(notify.message).toHaveBeenCalledWith('sent-title', 'sent-desc')
  })

  it('still claims sent on 400 (anti-enumeration)', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockRejectedValue({ status: 400 })
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(
      <ForgotPasswordForm
        fetch={authFetch}
        copy={forgotCopy}
        resetRedirectTo="https://app.example/reset-password"
        notify={notify}
      />,
    )
    await user.type(screen.getByLabelText('Email'), 'ada@kit.local')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('sent-desc')).toBeInTheDocument()
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('does not claim sent on 429', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockRejectedValue({ status: 429, code: 'RATE_LIMITED' })
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(
      <ForgotPasswordForm
        fetch={authFetch}
        copy={forgotCopy}
        resetRedirectTo="https://app.example/reset-password"
        notify={notify}
        rateLimitedDescription={() => 'slow'}
      />,
    )
    await user.type(screen.getByLabelText('Email'), 'ada@kit.local')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Error', 'slow')
    })
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('does not claim sent on HTTP 500', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockRejectedValue(new Error('HTTP 500'))
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(
      <ForgotPasswordForm
        fetch={authFetch}
        copy={forgotCopy}
        resetRedirectTo="https://app.example/reset-password"
        notify={notify}
        rateLimitedDescription={() => 'down'}
      />,
    )
    await user.type(screen.getByLabelText('Email'), 'ada@kit.local')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(notify.error).toHaveBeenCalled()
    })
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })
})

describe('ResetPasswordForm', () => {
  it('POSTs newPassword + token then onSuccess', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockResolvedValue({})
    const onSuccess = vi.fn()
    render(
      <ResetPasswordForm fetch={authFetch} copy={resetCopy} token="tok_1" onSuccess={onSuccess} />,
    )
    await user.type(screen.getByLabelText('New'), '12345678')
    await user.type(screen.getByLabelText('Confirm'), '12345678')
    for (const toggle of screen.getAllByRole('button', { name: 'Show password' })) {
      await user.click(toggle)
    }
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/auth/reset-password',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ newPassword: '12345678', token: 'tok_1' }),
        }),
      )
    })
    expect(onSuccess).toHaveBeenCalled()
    for (const label of ['New', 'Confirm']) {
      const input = screen.getByLabelText(label)
      expect(input).toHaveValue('')
      await user.type(input, 'nextpass')
      expect(input).toHaveAttribute('type', 'password')
    }
  })
})

describe('ChangePasswordForm', () => {
  it('POSTs current/new/revoke then resets fields', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockResolvedValue({})
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(<ChangePasswordForm fetch={authFetch} copy={changeCopy} notify={notify} />)
    await user.type(screen.getByLabelText('Current'), 'oldpass1')
    await user.type(screen.getByLabelText('New'), '12345678')
    await user.type(screen.getByLabelText('Confirm'), '12345678')
    for (const toggle of screen.getAllByRole('button', { name: 'Show password' })) {
      await user.click(toggle)
    }
    await user.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/auth/change-password',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            currentPassword: 'oldpass1',
            newPassword: '12345678',
            revokeOtherSessions: true,
          }),
        }),
      )
    })
    expect(notify.success).toHaveBeenCalledWith('updated')
    for (const label of ['Current', 'New', 'Confirm']) {
      const input = screen.getByLabelText(label)
      expect(input).toHaveValue('')
      await user.type(input, 'nextpass')
      expect(input).toHaveAttribute('type', 'password')
    }
  })

  it('masks the next password after a failed change clears the new and confirmation fields', async () => {
    const user = userEvent.setup()
    const authFetch = vi.fn().mockRejectedValue(new Error('Request failed'))
    const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() }
    render(<ChangePasswordForm fetch={authFetch} copy={changeCopy} notify={notify} />)
    const current = screen.getByLabelText('Current')
    const next = screen.getByLabelText('New')
    const confirm = screen.getByLabelText('Confirm')
    await user.type(current, 'oldpass1')
    await user.type(next, '12345678')
    await user.type(confirm, '12345678')
    for (const toggle of screen.getAllByRole('button', { name: 'Show password' })) {
      await user.click(toggle)
    }
    expect(next).toHaveAttribute('type', 'text')
    expect(confirm).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => {
      expect(next).toHaveValue('')
      expect(confirm).toHaveValue('')
    })
    expect(current).toHaveValue('oldpass1')
    for (const input of [next, confirm]) {
      await user.type(input, 'nextpass')
      expect(input).toHaveAttribute('type', 'password')
    }
  })
})
