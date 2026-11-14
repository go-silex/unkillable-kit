import { scrubHeaderLine } from '../scrub'

export type EmailLocale = 'fr' | 'en'
export type EmailTemplateOptions = { locale: EmailLocale; productName: string }

// Dynamic text is flattened before it is inserted into either body or subject.
export const templateValue = scrubHeaderLine

type Copy = {
  inviteSubject: (org: string, product: string) => string
  inviteIntro: (org: string, product: string) => string
  invitedBy: (inviter: string) => string
  accept: string
  expires: (expiry: string) => string
  magicSubject: (product: string) => string
  magicIntro: (product: string) => string
  magicAction: string
  magicLinkLabel: string
  resetSubject: (product: string) => string
  resetIntro: (product: string) => string
  resetAction: string
  resetLinkLabel: string
  welcomeSubject: (product: string) => string
  greeting: (name: string) => string
  welcomeIntro: (product: string) => string
  welcomeAction: string
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
    expires: (expiry) => `Expires: ${expiry}`,
    magicSubject: (product) => `Sign in — ${product}`,
    magicIntro: (product) => `You requested a sign-in link for ${product}.`,
    magicAction: 'Sign in',
    magicLinkLabel: 'Sign-in link',
    resetSubject: (product) => `Reset your password — ${product}`,
    resetIntro: (product) => `You requested a password reset for ${product}.`,
    resetAction: 'Reset password',
    resetLinkLabel: 'Reset link',
    welcomeSubject: (product) => `Welcome — set your password — ${product}`,
    greeting: (name) => `Hi ${name},`,
    welcomeIntro: (product) => `An account was created for you on ${product}.`,
    welcomeAction: 'Set your password',
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
    expires: (expiry) => `Expire le : ${expiry}`,
    magicSubject: (product) => `Connexion — ${product}`,
    magicIntro: (product) => `Vous avez demandé un lien de connexion pour ${product}.`,
    magicAction: 'Se connecter',
    magicLinkLabel: 'Lien de connexion',
    resetSubject: (product) => `Réinitialiser votre mot de passe — ${product}`,
    resetIntro: (product) =>
      `Vous avez demandé la réinitialisation de votre mot de passe pour ${product}.`,
    resetAction: 'Réinitialiser le mot de passe',
    resetLinkLabel: 'Lien de réinitialisation',
    welcomeSubject: (product) => `Bienvenue — créez votre mot de passe — ${product}`,
    greeting: (name) => `Bonjour ${name},`,
    welcomeIntro: (product) => `Un compte a été créé pour vous sur ${product}.`,
    welcomeAction: 'Créer votre mot de passe',
    fallbackName: 'à vous',
    fiveMinutes: 'environ 5 minutes',
    oneHour: 'environ 1 heure',
    expiresIn: (expiry) => `Ce lien expire dans ${expiry}.`,
    ignoreRequest: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.',
    ignoreWelcome: 'Si vous n’attendiez pas cet e-mail, ignorez-le.',
  },
}
