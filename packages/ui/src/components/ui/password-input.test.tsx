import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PasswordInput } from './password-input'

describe('PasswordInput', () => {
  it('reveals and hides the entered value without submitting the form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())

    render(
      <form onSubmit={onSubmit}>
        <label htmlFor="password">Password</label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          showPasswordLabel="Show password"
          hidePasswordLabel="Hide password"
        />
        <button type="submit">Submit</button>
      </form>,
    )

    const input = screen.getByLabelText('Password')
    const showButton = screen.getByRole('button', { name: 'Show password', pressed: false })
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 'my-password')
    await user.click(showButton)

    const hideButton = screen.getByRole('button', { name: 'Hide password', pressed: true })
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).toHaveValue('my-password')

    await user.click(hideButton)

    expect(screen.getByRole('button', { name: 'Show password', pressed: false })).toBeVisible()
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).toHaveValue('my-password')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
