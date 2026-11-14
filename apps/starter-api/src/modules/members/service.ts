import type { Db } from '../../platform/types'
import { listOrganizationMembers } from './repository'

export async function getMembers(db: Db, organizationId: string) {
  const members = await listOrganizationMembers(db, organizationId)
  return members.map(({ id, userId, role }) => ({ id, userId, role }))
}
