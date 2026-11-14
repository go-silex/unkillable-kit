import { apiFetch } from '@kit/api-client'
import { parseMe } from '@kit/api-client/me'

export function getMe(signal?: AbortSignal) {
  return apiFetch('/api/me', { parse: parseMe, signal })
}

export function signIn(email: string, password: string) {
  return apiFetch('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function signOut() {
  return apiFetch('/api/auth/sign-out', { method: 'POST', body: '{}' })
}
