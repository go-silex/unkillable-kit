import { readFileSync } from 'node:fs'
import { oauthProvider } from '@better-auth/oauth-provider'
import Database from 'better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { oidcProviderDrizzleSchema } from './oidc-provider-schema'

describe('OIDC provider session foreign keys', () => {
  it('keeps the intentional access-token cascade in sync with the kit migration', () => {
    const upstream = oauthProvider({ loginPage: '/login', consentPage: '/consent' }).schema
    // Better Auth defaults both to SET NULL; only the access token intentionally differs.
    expect(upstream.oauthAccessToken.fields.sessionId.references.onDelete).toBe('set null')
    expect(upstream.oauthRefreshToken.fields.sessionId.references.onDelete).toBe('set null')

    const sqlite = new Database(':memory:')
    try {
      sqlite.exec(
        readFileSync(
          new URL(
            '../../../../apps/example-api/migrations/0027_better_auth_oidc_provider.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      )
      for (const [table, name, expected] of [
        [oidcProviderDrizzleSchema.oauthAccessToken, 'oauth_access_token', 'cascade'],
        [oidcProviderDrizzleSchema.oauthRefreshToken, 'oauth_refresh_token', 'set null'],
      ] as const) {
        const foreignKey = getTableConfig(table).foreignKeys.find(
          (key) => key.reference().columns[0]?.name === 'session_id',
        )
        expect(foreignKey?.onDelete).toBe(expected)
        const sqlKeys = sqlite.pragma(`foreign_key_list(${name})`) as Array<{
          from: string
          table: string
          to: string
          on_delete: string
        }>
        expect(sqlKeys.find((key) => key.from === 'session_id')).toMatchObject({
          table: 'session',
          to: 'id',
          on_delete: expected.toUpperCase(),
        })
      }
    } finally {
      sqlite.close()
    }
  })
})
