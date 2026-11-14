import { listMembers } from '@kit/auth/repos/orgs'
import type { Db } from '../../platform/types'

export function listOrganizationMembers(db: Db, organizationId: string) {
  return listMembers(db, organizationId)
}
