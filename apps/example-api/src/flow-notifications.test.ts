import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { flowRuns } from './db/schema'
import {
  createFlowApprovalNotificationPorts,
  flowApprovalSource,
} from './services/notifications/flow-producer'
import { setupFlowNotifications as setup, waiting } from './test/flow-notifications-fixture'
import { ORG_ACME } from './test/flows-fixture'
import { workflowInstanceStub } from './test/memory-env'

describe('flow approval notification lifecycle', () => {
  it('notifies the initiating owner separately for each gate and never resurrects a decision', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.ports.opened(f.notice('second'))
    let rows = (await f.inbox()).items
    expect(rows.map((row) => row.source.id).sort()).toEqual(
      ['first', 'second'].map((id) => flowApprovalSource(f.notice(id)).id).sort(),
    )
    f.env.FLOW_RUN.get = vi.fn(async () => {
      throw new Error('wake failed')
    })
    const response = await f.app.request(
      `/api/flows/runs/${f.runId}/tasks/first/approval`,
      { method: 'POST', headers: f.headers, body: JSON.stringify({ decision: 'approved' }) },
      f.env,
    )
    expect(response.status).toBe(202)
    expect(z.object({ woken: z.boolean() }).parse(await response.json()).woken).toBe(false)
    await f.ports.opened(f.notice('first'))
    rows = (await f.inbox()).items
    expect(rows).toHaveLength(2)
    expect(
      rows.find((row) => row.source.id === flowApprovalSource(f.notice('first')).id)?.resolvedAt,
    ).not.toBeNull()
    expect(
      rows.find((row) => row.source.id === flowApprovalSource(f.notice('second')).id)?.resolvedAt,
    ).toBeNull()
  })

  it('repairs a decision committed after the pre-read but before admission returns', async () => {
    const f = await setup()
    const ports = createFlowApprovalNotificationPorts(f.db, {
      ...f.notifications,
      notify: async (input) => {
        const response = await f.app.request(
          `/api/flows/runs/${f.runId}/tasks/first/approval`,
          { method: 'POST', headers: f.headers, body: JSON.stringify({ decision: 'approved' }) },
          f.env,
        )
        expect(response.status).toBe(202)
        return f.notifications.notify(input)
      },
    })
    await ports.opened(f.notice('first'))
    const rows = (await f.inbox()).items
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resolvedAt).not.toBeNull()
  })

  it('repairs a cancellation that wins before admission', async () => {
    const f = await setup()
    const ports = createFlowApprovalNotificationPorts(f.db, {
      ...f.notifications,
      notify: async (input) => {
        const response = await f.app.request(
          `/api/flows/runs/${f.runId}/cancel`,
          { method: 'POST', headers: f.headers, body: '{}' },
          f.env,
        )
        expect(response.status).toBe(200)
        return f.notifications.notify(input)
      },
    })
    await ports.opened(f.notice('first'))
    const rows = (await f.inbox()).items
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resolvedAt).not.toBeNull()
  })

  it('repairs resolution on decision repeats without changing conflict statuses', async () => {
    const f = await setup()
    const url = `/api/flows/runs/${f.runId}/tasks/first/approval`
    const decide = (decision: string) =>
      f.app.request(
        url,
        { method: 'POST', headers: f.headers, body: JSON.stringify({ decision }) },
        f.env,
      )
    expect((await decide('approved')).status).toBe(202)
    const admit = () =>
      f.notifications.notify({
        orgId: ORG_ACME,
        type: 'flows.approval_requested',
        source: flowApprovalSource(f.notice('first')),
        userIds: ['user_staff'],
        params: {},
      })
    await admit()
    expect((await decide('approved')).status).toBe(200)
    expect((await f.inbox()).items[0]?.resolvedAt).not.toBeNull()
    await admit()
    expect((await decide('rejected')).status).toBe(409)
    expect((await f.inbox()).items.filter((row) => row.resolvedAt === null)).toHaveLength(0)
    await admit()
    await f.db
      .update(flowRuns)
      .set({
        receiptJson: JSON.stringify({
          receiptVersion: 1,
          tokensUsed: 0,
          tasks: { first: { taskId: 'first', outcome: 'ok' } },
        }),
      })
      .where(eq(flowRuns.id, f.runId))
    expect((await decide('approved')).status).toBe(409)
    expect((await f.inbox()).items.filter((row) => row.resolvedAt === null)).toHaveLength(0)
  })

  it('cancels every sealed gate and repairs already-cancelled runs', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.ports.opened(f.notice('second'))
    const cancel = () =>
      f.app.request(
        `/api/flows/runs/${f.runId}/cancel`,
        { method: 'POST', headers: f.headers, body: '{}' },
        f.env,
      )
    expect((await cancel()).status).toBe(200)
    expect((await f.inbox()).items.filter((row) => row.resolvedAt === null)).toHaveLength(0)
    await f.notifications.notify({
      orgId: ORG_ACME,
      type: 'flows.approval_requested',
      source: flowApprovalSource(f.notice('second')),
      userIds: ['user_staff'],
      params: {},
    })
    expect((await cancel()).status).toBe(200)
    expect((await f.inbox()).items.filter((row) => row.resolvedAt === null)).toHaveLength(0)
  })

  it('repairs approvals when cancellation loses its CAS to another canceller', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.ports.opened(f.notice('second'))
    await f.env.DB.prepare(
      "CREATE TRIGGER race_cancel BEFORE UPDATE OF status ON flow_runs WHEN NEW.status = 'cancelled' BEGIN UPDATE flow_runs SET status = 'cancelled' WHERE id = OLD.id; SELECT RAISE(IGNORE); END",
    ).run()
    const response = await f.app.request(
      `/api/flows/runs/${f.runId}/cancel`,
      { method: 'POST', headers: f.headers, body: '{}' },
      f.env,
    )
    expect(response.status).toBe(200)
    expect((await f.inbox()).items.filter((row) => row.resolvedAt === null)).toHaveLength(0)
  })

  it('propagates callback resolution failure while decision still commits and wakes', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.env.DB.prepare(
      "CREATE TRIGGER fail_flow_resolution BEFORE UPDATE OF resolved_at ON kit_notifications BEGIN SELECT RAISE(ABORT, 'private-secret'); END",
    ).run()
    await expect(f.ports.closed({ ...f.notice('first'), outcome: 'approved' })).rejects.toThrow(
      'APPROVAL_NOTIFICATION_FAILED',
    )
    const instance = workflowInstanceStub(f.runId)
    f.env.FLOW_RUN.get = vi.fn(async () => instance)
    const response = await f.app.request(
      `/api/flows/runs/${f.runId}/tasks/first/approval`,
      { method: 'POST', headers: f.headers, body: JSON.stringify({ decision: 'approved' }) },
      f.env,
    )
    expect(response.status).toBe(202)
    expect(instance.sent).toHaveLength(1)
    expect((await f.inbox()).items[0]?.resolvedAt).toBeNull()
    await f.env.DB.prepare('DROP TRIGGER fail_flow_resolution').run()
    const replay = await f.app.request(
      `/api/flows/runs/${f.runId}/tasks/first/approval`,
      { method: 'POST', headers: f.headers, body: JSON.stringify({ decision: 'approved' }) },
      f.env,
    )
    expect(replay.status).toBe(200)
    expect((await f.inbox()).items[0]?.resolvedAt).not.toBeNull()
  })

  it('continues cancellation and resolves sibling gates when one resolution fails', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.ports.opened(f.notice('second'))
    const firstSource = flowApprovalSource(f.notice('first')).id.replaceAll("'", "''")
    await f.env.DB.prepare(
      `CREATE TRIGGER fail_first_resolution BEFORE UPDATE OF resolved_at ON kit_notifications WHEN OLD.source_id = '${firstSource}' BEGIN SELECT RAISE(ABORT, 'private-secret'); END`,
    ).run()
    const instance = workflowInstanceStub(f.runId)
    f.env.FLOW_RUN.get = vi.fn(async () => instance)
    const response = await f.app.request(
      `/api/flows/runs/${f.runId}/cancel`,
      { method: 'POST', headers: f.headers, body: '{}' },
      f.env,
    )
    expect(response.status).toBe(200)
    expect(instance.terminated).toBe(1)
    const rows = (await f.inbox()).items
    expect(rows.find((row) => row.source.id === firstSource)?.resolvedAt).toBeNull()
    expect(
      rows.find((row) => row.source.id === flowApprovalSource(f.notice('second')).id)?.resolvedAt,
    ).not.toBeNull()
  })

  it('fails safely for corrupt persisted facts and resolves terminal or missing runs', async () => {
    const f = await setup()
    await f.ports.opened(f.notice('first'))
    await f.db
      .update(flowRuns)
      .set({ receiptJson: '{private-secret' })
      .where(eq(flowRuns.id, f.runId))
    await expect(f.ports.opened(f.notice('first'))).rejects.toThrow('APPROVAL_NOTIFICATION_FAILED')
    const [run] = await f.db.select().from(flowRuns).where(eq(flowRuns.id, f.runId))
    if (!run) throw new Error('Missing run fixture')
    await f.db
      .update(flowRuns)
      .set({ snapshotJson: '{private-secret', receiptJson: waiting })
      .where(eq(flowRuns.id, f.runId))
    await expect(f.ports.opened(f.notice('first'))).rejects.toThrow('APPROVAL_NOTIFICATION_FAILED')
    await f.db
      .update(flowRuns)
      .set({ snapshotJson: run.snapshotJson })
      .where(eq(flowRuns.id, f.runId))
    await f.db
      .update(flowRuns)
      .set({ receiptJson: waiting, status: 'cancelled' })
      .where(eq(flowRuns.id, f.runId))
    await f.ports.opened(f.notice('first'))
    expect((await f.inbox()).items[0]?.resolvedAt).not.toBeNull()
    await f.ports.opened({ ...f.notice('first'), runId: 'missing-run' })
    expect((await f.inbox()).items).toHaveLength(1)
  })
})
