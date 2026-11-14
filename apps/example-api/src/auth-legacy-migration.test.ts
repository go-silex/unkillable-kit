import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from 'better-auth/crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { createMemoryEnv, type EnvLike } from './test/memory-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ORIGIN = 'http://localhost:5173'
const LEGACY_EMAIL = 'legacy@kit.local'
const LEGACY_PASSWORD = 'legacy-password'

const BA_ENV = {
  through: '0013_tasks_comments.sql',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  ENVIRONMENT: 'test',
  CORS_ORIGINS: ORIGIN,
} as const

async function insertLegacyCredential(env: EnvLike, passwordHash: string) {
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind('legacy_user', 'Legacy User', LEGACY_EMAIL, 1, 1)
    .run()
  await env.DB.prepare(
    `INSERT INTO account (
       id, account_id, provider_id, user_id, password, created_at, updated_at
     ) VALUES (?, ?, 'credential', ?, ?, 1, 1)`,
  )
    .bind('acc_legacy', 'legacy_user', 'legacy_user', passwordHash)
    .run()
}

describe('legacy Better Auth 1.6 account after additive 1.7 migration', () => {
  it('backfills issuer and signs in under BA 1.7', async () => {
    const app = createApp()
    const env = createMemoryEnv(BA_ENV)

    const colsBefore = (await env.DB.prepare('PRAGMA table_info(account)').all()) as {
      results: { name: string }[]
    }
    expect(colsBefore.results.some((col) => col.name === 'issuer')).toBe(false)

    await insertLegacyCredential(env, await hashPassword(LEGACY_PASSWORD))

    await env.DB.exec(
      readFileSync(join(__dirname, '../migrations/0014_better_auth_1_7_additive.sql'), 'utf8'),
    )
    await env.DB.exec(readFileSync(join(__dirname, '../migrations/0025_account_state.sql'), 'utf8'))

    const row = (await env.DB.prepare(
      `SELECT issuer, account_id AS accountId FROM account WHERE id = 'acc_legacy'`,
    ).first()) as { issuer: string; accountId: string } | null
    expect(row).toEqual({ issuer: 'local:credential', accountId: 'legacy_user' })

    const login = await app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: LEGACY_EMAIL, password: LEGACY_PASSWORD }),
      },
      env,
    )
    expect(login.status, `legacy sign-in → ${login.status}`).toBe(200)
    expect(login.headers.get('set-cookie')).toMatch(/kit_session=/)
  })
})
