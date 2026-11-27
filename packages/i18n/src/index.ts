/**
 * Locale engine only — catalogs stay app-owned (ADR-0001).
 * Apps pass their own message maps; package never ships product/demo copy.
 *
 * Locale policy = `catalogs` keys. One key → no switcher (`hasLocaleSwitcher`).
 */

export { type CommandPaletteMessages, commandPaletteMessages } from './command-palette'

export type LocaleCatalogs<L extends string, M> = Record<L, M>

export type I18nEngine<L extends string, M> = {
  defaultLocale: L
  t: (locale: L) => M
  locales: readonly L[]
}

export function isLocale<L extends string>(
  locales: readonly L[],
  value: string | null | undefined,
): value is L {
  return typeof value === 'string' && (locales as readonly string[]).includes(value)
}

export function resolveLocale<L extends string>(
  locales: readonly L[],
  defaultLocale: L,
  value: string | null | undefined,
): L {
  return isLocale(locales, value) ? value : defaultLocale
}

/** False when the app registers a single catalog — UI must hide the switcher. */
export function hasLocaleSwitcher<L extends string>(locales: readonly L[]): boolean {
  return locales.length > 1
}

export function createI18n<L extends string, M>(opts: {
  catalogs: LocaleCatalogs<L, M>
  defaultLocale: L
}): I18nEngine<L, M> {
  const locales = Object.keys(opts.catalogs) as L[]
  if (locales.length === 0) {
    throw new Error('createI18n: catalogs must include at least one locale')
  }
  if (!Object.hasOwn(opts.catalogs, opts.defaultLocale)) {
    throw new Error(`createI18n: defaultLocale "${opts.defaultLocale}" is not in catalogs`)
  }
  return {
    defaultLocale: opts.defaultLocale,
    locales,
    t(locale) {
      return opts.catalogs[locale] ?? opts.catalogs[opts.defaultLocale]
    },
  }
}
