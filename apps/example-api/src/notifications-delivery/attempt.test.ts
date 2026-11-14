import { upsertOrgModule, upsertPlatformModule } from '@kit/auth/repos/platform-modules'
import { finishDelivery, loadDelivery } from '@kit/notifications/repos'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env'
import * as emailPort from '../lib/email-port'
import { createAppNotificationService } from '../services/notifications/app'
import { createRecordingNotificationRuntime } from '../test/notification-runtime'
import { createNotificationFixture } from '../test/notifications/fixture'
import { sendNotificationAttempt } from './attempt'

describe('live notification attempt', () => {
  it('honors terminal receipts and freshly revoked module access before resolving a port', async () => {
    const f = await createNotificationFixture()
    // The attempt receives its actual D1-backed KitDb separately; these Worker bindings
    // are intentionally unavailable so an accidental dependency fails the test.
    const env: Env = {
      ...f.env,
      get DB(): never {
        throw new Error('Unexpected Worker DB access')
      },
      get BUCKET(): never {
        throw new Error('Unexpected Worker bucket access')
      },
    }
    const spy = vi.spyOn(emailPort, 'resolveEmailPort')
    try {
      await upsertPlatformModule(f.db, {
        moduleId: 'tasks',
        available: true,
        configJson: null,
        updatedAt: 1,
      })
      await upsertOrgModule(f.db, {
        organizationId: 'org_team',
        moduleId: 'tasks',
        enabled: true,
        updatedAt: 1,
      })
      const service = createAppNotificationService(
        f.db,
        createRecordingNotificationRuntime().runtime,
      )
      const created = await service.notify({
        orgId: 'org_team',
        type: 'tasks.assigned',
        source: { kind: 'task', id: 'attempt-test' },
        params: { taskTitle: 'Task' },
        userIds: ['user_team_owner'],
      })
      const refs = await Promise.all(
        created.createdDeliveries.map(async (ref) => ({ ref, row: await loadDelivery(f.db, ref) })),
      )
      const email = refs.find(({ row }) => row?.channel === 'email')
      if (!email?.row) throw new Error('Missing email delivery')
      await upsertOrgModule(f.db, {
        organizationId: 'org_team',
        moduleId: 'tasks',
        enabled: false,
        updatedAt: 2,
      })
      expect(await sendNotificationAttempt(f.db, env, email.ref, email.row.workflowId)).toEqual({
        status: 'skipped',
        code: 'notification_access_denied',
      })
      expect(spy).not.toHaveBeenCalled()
      await finishDelivery(f.db, email.ref, { status: 'sent' }, Date.now())
      expect(await sendNotificationAttempt(f.db, env, email.ref, email.row.workflowId)).toEqual({
        status: 'sent',
        code: null,
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      f.env.close()
    }
  })
})
