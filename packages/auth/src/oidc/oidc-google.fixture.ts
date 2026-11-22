import { generateKeyPairSync, sign } from 'node:crypto'

export const GOOGLE_CLIENT = 'google-client-id'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const googleJwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'google-test-key',
  alg: 'RS256',
  use: 'sig',
}

export function googleIdToken(emailVerified: boolean) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = `${encode({ alg: 'RS256', kid: googleJwk.kid, typ: 'JWT' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT,
    iat: now,
    exp: now + 3600,
    sub: 'google-subject',
    name: 'Google User',
    email: 'google@example.test',
    email_verified: emailVerified,
    hd: 'example.test',
  })}`
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`
}
