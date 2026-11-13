import { describe, expect, it } from 'vitest'
import { deliveryRefSchema } from './index'

describe('server-owned Delivery references', () => {
  it.each([
    '',
    `u_${'a'.repeat(255)}`,
    'u_alpha\n',
    'u_alpha\r',
    'u_alpha\u2028',
    'u_alpha\u2029',
    'u_é',
    'u_alpha/beta',
  ])('rejects a non-encodable Delivery id %j', (id) => {
    expect(deliveryRefSchema.safeParse({ orgId: 'org-a', kind: 'user', id }).success).toBe(false)
  })

  it.each([
    { orgId: '', kind: 'user', id: 'u_alpha' },
    { orgId: 'a'.repeat(257), kind: 'user', id: 'u_alpha' },
    { orgId: 'org-a', kind: 'workflow', id: 'u_alpha' },
    { kind: 'user', id: 'u_alpha' },
  ])('rejects a missing or invalid owner reference %j', (ref) => {
    expect(deliveryRefSchema.safeParse(ref).success).toBe(false)
  })

  it.each([
    { stage: 'send' },
    { address: 'recipient@example.test' },
    { grants: ['send'] },
    { attemptCount: 0 },
    { params: {} },
  ])('rejects caller-supplied execution or authority fields %j', (extra) => {
    expect(
      deliveryRefSchema.safeParse({ orgId: 'org-a', kind: 'user', id: 'u_alpha', ...extra })
        .success,
    ).toBe(false)
  })
})
