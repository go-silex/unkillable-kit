import { expect, it } from 'vitest'
import { authorizeHostedPrincipal, defineAuthorizationFact } from '../snapshot'
import { fixture } from './load.fixture'

it('matches Product Organization scope keys exactly despite column collation', async () => {
  const { db, sqlite } = fixture()
  sqlite.exec("INSERT INTO organization VALUES ('Chosen', 'active')")
  sqlite.exec("INSERT INTO member VALUES ('uppercase-member', 'Chosen', 'actor', 'reader')")
  sqlite.exec('CREATE TABLE product_labels (organization_id TEXT COLLATE NOCASE, label TEXT)')
  const insert = sqlite.prepare('INSERT INTO product_labels VALUES (?, ?)')
  insert.run('chosen', 'lowercase scope')
  insert.run('Chosen', 'uppercase scope')

  const labels = defineAuthorizationFact({
    table: { name: 'product_labels', columns: ['organization_id', 'label'] },
    scope: { kind: 'organization', organizationId: 'organization_id' },
    select: ['label'],
    decode: (rows) => rows.map(({ label }) => label),
  })
  const result = await authorizeHostedPrincipal({
    db,
    principal: { userId: 'actor', grantId: 'grant', clientId: 'client' },
    organizationId: 'chosen',
    facts: [labels],
  })
  expect(result.status).toBe('allowed')
  if (result.status !== 'allowed') return
  expect(result.forOrganization('chosen')?.fact(labels)).toEqual(['lowercase scope'])
  expect(db.batch).toHaveBeenCalledTimes(1)
})

it.each([
  ['INTEGER', 'CREATE TABLE product_labels (organization_id INTEGER, label TEXT)'],
  ['NUMERIC', 'CREATE TABLE product_labels (organization_id NUMERIC, label TEXT)'],
])(
  'does not coerce Organization keys to scope columns with %s affinity',
  async (_affinity, ddl) => {
    const { db, sqlite } = fixture()
    sqlite.exec("INSERT INTO organization VALUES ('001', 'active'), ('1', 'active')")
    sqlite.exec(
      "INSERT INTO member VALUES ('padded-member', '001', 'actor', 'reader'), ('numeric-member', '1', 'actor', 'reader')",
    )
    sqlite.exec(ddl)
    const insert = sqlite.prepare('INSERT INTO product_labels VALUES (?, ?)')
    insert.run('001', 'padded scope')
    insert.run('1', 'numeric scope')
    insert.run('chosen', 'text scope')
    const labels = defineAuthorizationFact({
      table: { name: 'product_labels', columns: ['organization_id', 'label'] },
      scope: { kind: 'organization', organizationId: 'organization_id' },
      select: ['label'],
      decode: (rows) => rows.map(({ label }) => label),
    })
    for (const [organizationId, expected] of [
      ['001', []],
      ['1', []],
      ['chosen', ['text scope']],
    ] as const) {
      const result = await authorizeHostedPrincipal({
        db,
        principal: { userId: 'actor', grantId: 'grant', clientId: 'client' },
        organizationId,
        facts: [labels],
      })
      if (result.status !== 'allowed') throw new Error('Expected admitted Organization')
      expect(result.forOrganization(organizationId)?.fact(labels)).toEqual(expected)
    }
  },
)
