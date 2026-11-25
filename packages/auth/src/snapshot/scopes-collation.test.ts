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
