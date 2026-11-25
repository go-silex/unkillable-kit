import { describe, expect, it } from 'vitest'
import {
  defineAuthorizationFact,
  defineAuthorizationProjection,
  isAuthorizationProjection,
} from './facts'

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

const productProjection = {
  table: { name: 'product_shares', columns: ['organization_id', 'user_id', 'visible_id'] },
  scope: { kind: 'organization-role', organizationId: 'organization_id', userId: 'user_id' },
  select: ['visible_id'],
} as const

function registerProjection(input: unknown) {
  return defineAuthorizationProjection(input as typeof productProjection)
}

describe('authorization projection declarations', () => {
  it('rejects caller-controlled decoding, SQL, ordering, operators and source caps', () => {
    for (const options of [
      { decode: () => '[]' },
      { sql: 'SELECT 1' },
      { orderBy: ['visible_id'] },
      { limit: 1 },
      { maxRows: 128 },
      { where: { visible_id: { eq: 'visible' } } },
      { where: { missing: null } },
      { select: ['lower(visible_id)'] },
      { select: ['visible_id', 'VISIBLE_ID'] },
    ]) {
      expect(() => registerProjection({ ...productProjection, ...options })).toThrow(
        'Invalid authorization fact declaration',
      )
    }
  })

  it('requires both distinct registered anchors in an exact member scope', () => {
    const { scope } = productProjection
    for (const invalidScope of [
      { kind: scope.kind, organizationId: scope.organizationId },
      { kind: scope.kind, userId: scope.userId },
      { ...scope, userId: undefined },
      { ...scope, userId: 'missing' },
      { ...scope, userId: 'ORGANIZATION_ID' },
      { ...scope, roleId: undefined },
      { ...scope, kind: 'delegated-role' },
      { ...scope, kind: 'organization' },
    ]) {
      expect(() => registerProjection({ ...productProjection, scope: invalidScope })).toThrow(
        'Invalid authorization fact declaration',
      )
    }
  })

  it('rejects Kit tables and secret-bearing registered columns', () => {
    for (const table of [
      { name: 'member', columns: ['organization_id', 'user_id', 'role'] },
      { name: 'session', columns: [...productProjection.table.columns] },
      { ...productProjection.table, columns: [...productProjection.table.columns, 'secret'] },
    ]) {
      expect(() =>
        registerProjection({ ...productProjection, table, select: ['user_id'] }),
      ).toThrow('Invalid authorization fact declaration')
    }
  })

  it('brands only the registered descriptor, not copies or ordinary facts', () => {
    const projection = defineAuthorizationProjection(productProjection)
    expect(isAuthorizationProjection(projection)).toBe(true)
    expect(isAuthorizationProjection({ ...projection })).toBe(false)
    expect(isAuthorizationProjection(defineAuthorizationFact(productFact))).toBe(false)
  })
})
