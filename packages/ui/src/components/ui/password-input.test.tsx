import { fireEvent, render, screen } from '@testing-library/react'
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
    expect(input).toHaveAttribute('spellcheck', 'false')
    await user.type(input, 'my-password')
    await user.click(showButton)

    const hideButton = screen.getByRole('button', { name: 'Hide password', pressed: true })
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).toHaveValue('my-password')

    await user.click(hideButton)

    expect(screen.getByRole('button', { name: 'Show password', pressed: false })).toBeVisible()
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).toHaveValue('my-password')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('masks an uncontrolled field after the user clears the revealed value', async () => {
    const user = userEvent.setup()
    render(
      <PasswordInput
        aria-label="Password"
        defaultValue="my-password"
        showPasswordLabel="Show password"
        hidePasswordLabel="Hide password"
      />,
    )
    const input = screen.getByLabelText('Password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')
    await user.clear(input)
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 'next-password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('next-password')
  })

  it.each([
    { when: 'already mounted', mounted: true },
    { when: 'mounted later', mounted: false },
  ])('masks a revealed field when its external owner ($when) resets', async ({ mounted }) => {
    const user = userEvent.setup()
    const field = (
      <PasswordInput
        form="credentials"
        aria-label="Password"
        showPasswordLabel="Show password"
        hidePasswordLabel="Hide password"
      />
    )
    const owner = (
      <form id="credentials">
        <button type="reset">Reset credentials</button>
      </form>
    )
    const unrelated = (
      <form>
        <button type="reset">Reset unrelated</button>
      </form>
    )
    const { rerender } = render(
      <>
        {field}
        {mounted && owner}
        {unrelated}
      </>,
    )
    const input = screen.getByLabelText('Password')
    fireEvent.input(input, { target: { value: 'my-password' } })
    await user.click(screen.getByRole('button', { name: 'Show password' }))

    if (!mounted) {
      rerender(
        <>
          {field}
          {owner}
          {unrelated}
        </>,
      )
    }

    await user.click(screen.getByRole('button', { name: 'Reset unrelated' }))
    expect(input).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: 'Reset credentials' }))
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Show password', pressed: false })).toBeVisible()
    await user.type(input, 'next-password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('next-password')
  })
})
