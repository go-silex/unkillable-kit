import { AppError } from '@kit/core'
import type { BetterAuthLike } from '../better-auth-port'

type EffectiveCookie = Readonly<{ name: string; secret: string }>
const issuedCookies = new WeakMap<BetterAuthLike, EffectiveCookie>()

/** Record the exact issuer configuration, not a second App-supplied verifier policy. */
export function recordSessionCookie(auth: BetterAuthLike, name: string, secret: string): void {
  issuedCookies.set(auth, { name, secret })
}

export function requestSessionCookie(auth: BetterAuthLike, header: string | null) {
  const issuer = issuedCookies.get(auth)
  if (!issuer) throw AppError.internal('Request auth requires the Kit Better Auth factory')
  return { header, name: issuer.name, secret: issuer.secret }
}
