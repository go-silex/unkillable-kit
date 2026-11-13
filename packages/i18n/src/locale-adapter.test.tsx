// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { createReactI18n } from '@kit/i18n/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { LocaleProvider, useLocale } = createReactI18n({
  catalogs: {
    es: { greeting: { title: 'Hola' } },
    de: { greeting: { title: 'Hallo' } },
  },
  defaultLocale: 'es',
  storageKey: 'ua.locale',
})

const single = createReactI18n({
  catalogs: { it: { greeting: 'Ciao' } },
  defaultLocale: 'it',
  storageKey: 'single.locale',
})

function SingleConsumer() {
  const { locale, locales, showSwitcher, m } = single.useLocale()
  return (
    <span>
      {locale}:{locales.join(',')}:{String(showSwitcher)}:{m.greeting}
    </span>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

function Consumer() {
  const { locale, locales, setLocale, showSwitcher, m } = useLocale()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="catalog">{m.greeting.title}</span>
      <span data-testid="locales">{locales.join(',')}</span>
      <span data-testid="switcher">{String(showSwitcher)}</span>
      <button type="button" onClick={() => setLocale('de')}>
        Deutsch
      </button>
      <button type="button" onClick={() => setLocale('invalid' as 'es')}>
        Invalid
      </button>
    </div>
  )
}

function StatefulConsumer() {
  const { locale, setLocale } = useLocale()
  const [count, setCount] = useState(0)
  return (
    <>
      <span data-testid="stateful">
        {locale}:{count}
      </span>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count
      </button>
      <button type="button" onClick={() => setLocale('de')}>
        Switch
      </button>
    </>
  )
}

function RerenderingParent() {
  const [tick, setTick] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        Rerender {tick}
      </button>
      <LocaleProvider>
        <StatefulConsumer />
      </LocaleProvider>
    </>
  )
}

// This function is typechecked but never executed.
function useCheckTypes() {
  const { locale, setLocale, m } = useLocale()
  const knownLocale: 'es' | 'de' = locale
  const title: string = m.greeting.title
  setLocale('de')
  const unknownLocaleExcluded: 'fr' extends Parameters<typeof setLocale>[0] ? false : true = true
  const unknownMessageExcluded: 'missing' extends keyof typeof m ? false : true = true
  return [knownLocale, title, unknownLocaleExcluded, unknownMessageExcluded]
}
void useCheckTypes

describe('React locale adapter', () => {
  it('preserves child state across locale changes and parent rerenders', () => {
    render(<RerenderingParent />)
    fireEvent.click(screen.getByRole('button', { name: 'Count' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rerender 0' }))
    expect(screen.getByTestId('stateful')).toHaveTextContent('de:1')
  })

  it('reads the consumer storage key and supplies its own catalogs', () => {
    localStorage.setItem('kit.locale', 'es')
    localStorage.setItem('ua.locale', 'de')
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('locale')).toHaveTextContent('de')
    expect(screen.getByTestId('catalog')).toHaveTextContent('Hallo')
    expect(screen.getByTestId('locales')).toHaveTextContent('es,de')
    expect(screen.getByTestId('switcher')).toHaveTextContent('true')
    expect(document.documentElement.lang).toBe('de')
  })

  it('falls back for stale stored values and updates messages, storage and document language', () => {
    localStorage.setItem('ua.locale', 'fr')
    const view = render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('locale')).toHaveTextContent('es')
    expect(screen.getByTestId('catalog')).toHaveTextContent('Hola')
    expect(document.documentElement.lang).toBe('es')
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }))
    expect(screen.getByTestId('locale')).toHaveTextContent('de')
    expect(screen.getByTestId('catalog')).toHaveTextContent('Hallo')
    expect(localStorage.getItem('ua.locale')).toBe('de')
    expect(document.documentElement.lang).toBe('de')
    view.unmount()
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('locale')).toHaveTextContent('de')
    expect(screen.getByTestId('catalog')).toHaveTextContent('Hallo')
    fireEvent.click(screen.getByRole('button', { name: 'Invalid' }))
    expect(screen.getByTestId('locale')).toHaveTextContent('es')
    expect(localStorage.getItem('ua.locale')).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it('continues to update language and messages when storage is inaccessible', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('locale')).toHaveTextContent('es')
    expect(document.documentElement.lang).toBe('es')
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }))
    expect(screen.getByTestId('catalog')).toHaveTextContent('Hallo')
    expect(document.documentElement.lang).toBe('de')
  })

  it('hides the switcher for a single catalog', () => {
    render(
      <single.LocaleProvider>
        <SingleConsumer />
      </single.LocaleProvider>,
    )
    expect(screen.getByText('it:it:false:Ciao')).toBeInTheDocument()
  })
})
