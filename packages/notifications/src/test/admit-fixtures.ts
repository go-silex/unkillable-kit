import type { AdmissionBatch, AdmissionOwnerIdentity } from '../repos'

export function admission(overrides: Partial<AdmissionBatch> = {}): AdmissionBatch {
  return {
    orgId: 'org-a',
    type: 'tasks.assigned',
    moduleId: null,
    source: { kind: 'task', id: 'task-1' },
    params: { value: 'original' },
    now: 1_000,
    users: [],
    organizations: [],
    ...overrides,
  }
}

export function identities(batch: AdmissionBatch, start = 1): AdmissionOwnerIdentity[] {
  let n = start
  const identity = (kind: 'user' | 'organization', id: string): AdmissionOwnerIdentity => ({
    ref: { orgId: batch.orgId, kind, id },
    workflowId: `nd-v1-${(n++).toString(16).padStart(64, '0')}`,
    admissionDeadlineAt: batch.now + 86_400_000,
  })
  return [
    ...batch.users.flatMap((user) =>
      user.deliveries.map((delivery) => identity('user', delivery.id)),
    ),
    ...batch.organizations.map((delivery) => identity('organization', delivery.id)),
  ]
}
