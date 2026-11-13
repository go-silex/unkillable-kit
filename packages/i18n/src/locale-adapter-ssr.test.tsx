// @vitest-environment node
import { createReactI18n } from '@kit/i18n/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

const { LocaleProvider, useLocale } = createReactI18n({
  catalogs: { es: { greeting: 'Hola' }, de: { greeting: 'Hallo' } },
  defaultLocale: 'es',
  storageKey: 'ua.locale',
})

function Consumer() {
  const { locale, m } = useLocale()
  return (
    <span>
      {locale}:{m.greeting}
    </span>
  )
}

describe('React locale adapter on the server', () => {
  it('renders the default catalog without browser globals', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
    expect(
      renderToStaticMarkup(
        <LocaleProvider>
          <Consumer />
        </LocaleProvider>,
      ),
    ).toBe('<span>es:Hola</span>')
  })
})
