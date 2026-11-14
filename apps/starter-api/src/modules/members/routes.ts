import { Hono } from 'hono'
import { requireAuth, requireOrg } from '../../platform/auth'
import type { AppEnv } from '../../platform/types'
import { getMembers } from './service'

export const members = new Hono<AppEnv>()
members.get('/api/orgs/:orgId/members', requireAuth, requireOrg, async (c) =>
  c.json({ members: await getMembers(c.get('db')!, c.get('orgId')!) }),
)
