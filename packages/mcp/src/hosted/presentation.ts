import type { ConsentPresentation } from './env'

type ConsentBrand = NonNullable<ConsentPresentation['brand']>

export type ResolvedConsentPresentation = Omit<ConsentPresentation, 'brand'> & {
  readonly brand?: ConsentBrand & { readonly buttonInk?: '#000' | '#fff' }
}

const IMAGE_PATH = /^\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:svg|png|jpe?g|webp|avif)$/i

function imagePath(path: string | undefined, key: 'logoPath' | 'backdropPath'): string | undefined {
  if (path === undefined) return
  if (typeof path !== 'string' || !IMAGE_PATH.test(path)) {
    throw new TypeError(`consentPresentation.brand.${key} must be a root-relative image path`)
  }
  return path
}

function snapshotBrand(brand: ConsentBrand): NonNullable<ResolvedConsentPresentation['brand']> {
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) {
    throw new TypeError('consentPresentation.brand must be an object')
  }
  const logoPath = imagePath(brand.logoPath, 'logoPath')
  const backdropPath = imagePath(brand.backdropPath, 'backdropPath')
  const { accentColor, serifHeading } = brand
  let buttonInk: '#000' | '#fff' | undefined
  if (accentColor !== undefined) {
    if (typeof accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(accentColor)) {
      throw new TypeError('consentPresentation.brand.accentColor must be a six-digit hex color')
    }
    const channel = (offset: number) => {
      const component = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
    }
    const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    // Pick the higher WCAG contrast of black and white (at least 4.58:1).
    buttonInk = luminance > Math.sqrt(1.05 * 0.05) - 0.05 ? '#000' : '#fff'
  }
  if (serifHeading !== undefined && typeof serifHeading !== 'boolean') {
    throw new TypeError('consentPresentation.brand.serifHeading must be a boolean')
  }
  return {
    ...(logoPath ? { logoPath } : {}),
    ...(backdropPath ? { backdropPath } : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(buttonInk ? { buttonInk } : {}),
    ...(serifHeading !== undefined ? { serifHeading } : {}),
  }
}

/** Copy caller-owned data once, so later mutations cannot change a consent page. */
export function snapshotPresentation(
  value?: ConsentPresentation,
): ResolvedConsentPresentation | undefined {
  if (!value) return undefined
  return {
    ...(value.locale !== undefined ? { locale: value.locale } : {}),
    ...(value.serviceName !== undefined ? { serviceName: value.serviceName } : {}),
    ...(value.disclosures !== undefined
      ? { disclosures: value.disclosures.map(({ label, text }) => ({ label, text })) }
      : {}),
    ...(value.brand !== undefined ? { brand: snapshotBrand(value.brand) } : {}),
  }
}

type ConsentLabels = {
  title: string
  signedInAs: string
  noEmail: string
  client: string
  clientId: string
  destination: string
  customSchemeBefore: string
  customSchemeAfter: string
  loopbackWarning: string
  warningAdvice: string
  allow: string
  deny: string
}

export const CONSENT_LABELS: Record<'en' | 'fr', ConsentLabels> = {
  en: {
    title: 'Authorize MCP client',
    signedInAs: 'Signed in as',
    noEmail: '(no email)',
    client: 'Client',
    clientId: 'Client ID',
    destination: 'Sends you back to',
    customSchemeBefore: 'The code goes to an app on this device (',
    customSchemeAfter: '), not a website.',
    loopbackWarning: 'The code goes to a program on your own computer, not a website.',
    warningAdvice: 'Allow only if you started this client yourself.',
    allow: 'Allow',
    deny: 'Deny',
  },
  fr: {
    title: 'Autoriser le client MCP',
    signedInAs: 'Connecté en tant que',
    noEmail: '(aucune adresse e-mail)',
    client: 'Client',
    clientId: 'Identifiant du client',
    destination: 'Vous redirige vers',
    customSchemeBefore: 'Le code est envoyé à une application sur cet appareil (',
    customSchemeAfter: '), et non à un site web.',
    loopbackWarning:
      'Le code est envoyé à un programme sur votre ordinateur, et non à un site web.',
    warningAdvice: 'Autorisez uniquement si vous avez démarré ce client vous-même.',
    allow: 'Autoriser',
    deny: 'Refuser',
  },
}
