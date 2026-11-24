import { describe, expect, it } from 'vitest'
import { defineAuthorizationFact } from './facts'

const productFact = {
  table: { name: 'product_preferences', columns: ['user_id', 'flag'] },
  scope: { kind: 'user', userId: 'user_id' },
  select: ['flag'],
  decode: () => true,
} as const

function register(input: unknown) {
  return defineAuthorizationFact(input as typeof productFact)
}

describe('authorization fact declarations', () => {
  it('rejects unknown fields, operations, expressions and columns', () => {
    const rejected = [
      { ...productFact, sql: 'SELECT 1' },
      { ...productFact, scope: { kind: 'deployment' } },
      { ...productFact, scope: { kind: 'user', userId: 'user_id', operation: 'read' } },
      { ...productFact, table: { ...productFact.table, name: 'other.product_preferences' } },
      { ...productFact, select: ['count(flag)'] },
      { ...productFact, select: ['flag', 'FLAG'] },
      { ...productFact, select: ['missing'] },
      { ...productFact, where: { missing: true } },
      { ...productFact, where: { flag: ['value'] } },
      { ...productFact, where: { flag: Infinity } },
      { ...productFact, maxRows: 0 },
      { ...productFact, maxRows: 129 },
    ]
    for (const declaration of rejected)
      expect(() => register(declaration)).toThrow('Invalid authorization fact declaration')
  })

  it('rejects credential tables and secret columns, including predicates and scope anchors', () => {
    for (const name of [
      'Session',
      'API_KEYS',
      'account',
      'oauth_refresh_token',
      'jwks',
      'sqlite_schema',
    ]) {
      expect(() => register({ ...productFact, table: { ...productFact.table, name } })).toThrow()
    }
    for (const column of ['access_token', 'clientSecret', 'key_hash', 'private_key', 'ROWID']) {
      expect(() =>
        register({
          ...productFact,
          table: { ...productFact.table, columns: [...productFact.table.columns, column] },
          scope: { kind: 'user', userId: column },
        }),
      ).toThrow()
    }
    expect(() =>
      register({
        ...productFact,
        table: {
          name: 'organization_modules',
          columns: ['organization_id', 'enabled', 'config_json'],
        },
        scope: { kind: 'organization', organizationId: 'organization_id' },
        select: ['enabled'],
        where: { config_json: null },
      }),
    ).toThrow()
  })

  it('rejects remapping Kit scopes and incomplete compound anchors', () => {
    const member = { name: 'member', columns: ['organization_id', 'user_id', 'role'] }
    expect(() =>
      register({
        ...productFact,
        table: member,
        scope: { kind: 'user', userId: 'user_id' },
        select: ['role'],
      }),
    ).toThrow()
    expect(() =>
      register({
        ...productFact,
        table: member,
        scope: { kind: 'organization-role', organizationId: 'organization_id' },
        select: ['role'],
      }),
    ).toThrow()
    expect(() =>
      register({
        ...productFact,
        table: { name: 'organization', columns: ['id', 'slug'] },
        scope: { kind: 'organization', organizationId: 'slug' },
        select: ['id'],
      }),
    ).toThrow()
    expect(() =>
      register({
        ...productFact,
        scope: { kind: 'hosted-grant', userId: 'user_id', grantId: 'user_id', clientId: 'flag' },
      }),
    ).toThrow()
  })
})
