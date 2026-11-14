import { scrubHeaderLine } from '../scrub'

export type EmailLocale = 'fr' | 'en'
export type EmailTemplateOptions = { locale: EmailLocale; productName: string }

// Dynamic text is flattened before it is inserted into either body or subject.
export const templateValue = scrubHeaderLine

export class EmailTemplateLocaleError extends Error {
  constructor() {
    super('EMAIL_LOCALE_INVALID')
    this.name = 'EmailTemplateLocaleError'
  }
}

export function getTemplateCopy(locale: EmailLocale): Copy {
  if (locale !== 'en' && locale !== 'fr') throw new EmailTemplateLocaleError()
  return copy[locale]
}

type Copy = {
  inviteSubject: (org: string, product: string) => string
  inviteIntro: (org: string, product: string) => string
  invitedBy: (inviter: string) => string
  accept: string
  acceptLink: (href: string) => string
  expires: (expiry: string) => string
  magicSubject: (product: string) => string
  magicIntro: (product: string) => string
  magicAction: string
  magicLink: (href: string) => string
  resetSubject: (product: string) => string
  resetIntro: (product: string) => string
  resetAction: string
  resetLink: (href: string) => string
  welcomeSubject: (product: string) => string
  greeting: (name: string) => string
  welcomeIntro: (product: string) => string
  welcomeAction: string
  welcomeLink: (href: string) => string
  fallbackName: string
  fiveMinutes: string
  oneHour: string
  expiresIn: (expiry: string) => string
  ignoreRequest: string
  ignoreWelcome: string
}

export const copy: Record<EmailLocale, Copy> = {
  en: {
    inviteSubject: (org, product) => `Invitation to ${org} — ${product}`,
    inviteIntro: (org, product) => `You have been invited to join ${org} on ${product}.`,
    invitedBy: (inviter) => `Invited by: ${inviter}`,
    accept: 'Accept invitation',
    acceptLink: (href) => `Accept invitation: ${href}`,
    expires: (expiry) => `Expires: ${expiry}`,
    magicSubject: (product) => `Sign in — ${product}`,
    magicIntro: (product) => `You requested a sign-in link for ${product}.`,
    magicAction: 'Sign in',
    magicLink: (href) => `Sign-in link: ${href}`,
    resetSubject: (product) => `Reset your password — ${product}`,
    resetIntro: (product) => `You requested a password reset for ${product}.`,
    resetAction: 'Reset password',
    resetLink: (href) => `Reset link: ${href}`,
    welcomeSubject: (product) => `Welcome — set your password — ${product}`,
    greeting: (name) => `Hi ${name},`,
    welcomeIntro: (product) => `An account was created for you on ${product}.`,
    welcomeAction: 'Set your password',
    welcomeLink: (href) => `Set your password: ${href}`,
    fallbackName: 'there',
    fiveMinutes: 'about 5 minutes',
    oneHour: 'about 1 hour',
    expiresIn: (expiry) => `This link expires in ${expiry}.`,
    ignoreRequest: 'If you did not request this, ignore this email.',
    ignoreWelcome: 'If you did not expect this email, ignore it.',
  },
  fr: {
    inviteSubject: (org, product) => `Invitation à rejoindre ${org} — ${product}`,
    inviteIntro: (org, product) => `Vous avez été invité à rejoindre ${org} sur ${product}.`,
    invitedBy: (inviter) => `Invitation envoyée par : ${inviter}`,
    accept: 'Accepter l’invitation',
    acceptLink: (href) => `Accepter l’invitation : ${href}`,
    expires: (expiry) => `Expire le : ${expiry}`,
    magicSubject: (product) => `Connexion — ${product}`,
    magicIntro: (product) => `Vous avez demandé un lien de connexion pour ${product}.`,
    magicAction: 'Se connecter',
    magicLink: (href) => `Lien de connexion : ${href}`,
    resetSubject: (product) => `Réinitialiser votre mot de passe — ${product}`,
    resetIntro: (product) =>
      `Vous avez demandé la réinitialisation de votre mot de passe pour ${product}.`,
    resetAction: 'Réinitialiser le mot de passe',
    resetLink: (href) => `Lien de réinitialisation : ${href}`,
    welcomeSubject: (product) => `Bienvenue — créez votre mot de passe — ${product}`,
    greeting: (name) => `Bonjour ${name},`,
    welcomeIntro: (product) => `Un compte a été créé pour vous sur ${product}.`,
    welcomeAction: 'Créer votre mot de passe',
    welcomeLink: (href) => `Créer votre mot de passe : ${href}`,
    fallbackName: 'à vous',
    fiveMinutes: 'environ 5 minutes',
    oneHour: 'environ 1 heure',
    expiresIn: (expiry) => `Ce lien expire dans ${expiry}.`,
    ignoreRequest: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.',
    ignoreWelcome: 'Si vous n’attendiez pas cet e-mail, ignorez-le.',
  },
}
