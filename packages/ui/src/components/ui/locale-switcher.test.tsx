import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { LocaleSwitcher } from './locale-switcher'

function Harness() {
  const [locale, setLocale] = useState<'fr' | 'en'>('fr')
  return (
    <LocaleSwitcher
      locales={['fr', 'en']}
      value={locale}
      onChange={setLocale}
      labels={{ fr: 'Français', en: 'English' }}
    />
  )
}

describe('LocaleSwitcher', () => {
  it('renders nothing when a single locale is registered', () => {
    const { container } = render(
      <LocaleSwitcher locales={['fr']} value="fr" onChange={() => undefined} />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a button per locale and calls onChange', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const fr = screen.getByRole('button', { name: 'Français' })
    const en = screen.getByRole('button', { name: 'English' })
    expect(fr).toHaveAttribute('aria-pressed', 'true')
    expect(en).toHaveAttribute('aria-pressed', 'false')
    await user.click(en)
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('menu variant lists locales inside a dropdown and hides when mono-locale', async () => {
    const user = userEvent.setup()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button>Open</Button>} />
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <LocaleSwitcher
              variant="menu"
              locales={['fr', 'en']}
              value="fr"
              onChange={() => undefined}
            />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByText('FR')).toBeInTheDocument()
    expect(screen.getByText('EN')).toBeInTheDocument()

    const { container } = render(
      <LocaleSwitcher variant="menu" locales={['fr']} value="fr" onChange={() => undefined} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
