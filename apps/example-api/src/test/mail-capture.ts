import { baVerification } from '@kit/auth/schema'
import { expect, onTestFinished, vi } from 'vitest'
import type { KitDb } from '../lib/db-type'
import * as emailPort from '../lib/email-port'

export function captureMail() {
  const messages: Array<{ to: string; subject: string; text: string }> = []
  const resolve = emailPort.resolveEmailPort
  const spy = vi.spyOn(emailPort, 'resolveEmailPort').mockImplementation((bindings) => {
    const port = resolve(bindings)
    return {
      send: async (message) => {
        messages.push({ to: message.to, subject: message.subject, text: message.text })
        return port.send(message)
      },
    }
  })
  onTestFinished(() => spy.mockRestore())
  return {
    message(to: string) {
      const message = [...messages].reverse().find((item) => item.to === to)
      expect(message, `mail delivered to ${to}`).toBeDefined()
      return message!
    },
    link(to: string, label: 'Reset link' | 'Sign-in link' | 'Set your password'): URL {
      const message = [...messages]
        .reverse()
        .find((item) => item.to === to && item.text.includes(`${label}: `))
      const line = message?.text.split('\n').find((item) => item.startsWith(`${label}: `))
      expect(Boolean(line), `${label} delivered`).toBe(true)
      return new URL(line!.slice(label.length + 2))
    },
  }
}

export async function expectTokenAbsentFromVerification(db: KitDb, token: string) {
  const rows = await db.select().from(baVerification)
  expect(rows.length).toBeGreaterThan(0)
  expect(
    rows.every((row) => !JSON.stringify(row).includes(token)),
    'verification rows contain no raw token',
  ).toBe(true)
}

export function resetTokenFromLink(link: URL): string {
  const token = link.searchParams.get('token') ?? link.pathname.split('/').pop()
  expect(Boolean(token), 'reset token delivered').toBe(true)
  return token!
}
