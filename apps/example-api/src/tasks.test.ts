import { MODULE_DENIAL } from '@kit/auth/hono'
import { baMember } from '@kit/auth/schema'
import { COMMENTS_MODULE_ID } from '@kit/comments'
import { kitComments } from '@kit/comments/schema'
import { createDb } from '@kit/db'
import { TASKS_MODULE_ID } from '@kit/tasks'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'
import type { KitDb } from './lib/db-type'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { setOrgModuleEnabled } from './services/platform-modules'
import {
  loginCookie,
  seedDemoEnv,
  sessionHeaders,
  signIn as signInRequest,
} from './test/api-fixture'
import { createMemoryEnv } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'
const ORG = 'org_acme'
const ORG_TEAM = 'org_team'

async function login(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createMemoryEnv>,
  email: string,
) {
  await seedDemoEnv(env, { notes: true, environment: 'test' })
  return loginCookie(app, env, email, TENANCY_PASSWORD, ORIGIN)
}

/** Every `kit_comments` id, sorted: a delete that reaches one row too many shows up here. */
async function commentIds(db: KitDb) {
  const rows = await db.select({ id: kitComments.id }).from(kitComments)
  return rows.map((row) => row.id).sort()
}

/** A comment row written straight to D1, for targets the API cannot produce. */
function directComment(id: string, orgId: string, targetType: string, targetId: string) {
  return {
    id,
    orgId,
    targetType,
    targetId,
    authorId: 'user_staff',
    body: 'direct row',
    visibility: 'shared',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('tasks dogfood API', () => {
  it('requires auth and org', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    expect((await app.request('/api/tasks', {}, env)).status).toBe(401)
  })

  it('CRUD + visibility hide from reader + comment', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await login(app, env, 'staff@kit.local')
    // add reader to acme for external audience test
    const db = createDb(env.DB as unknown as D1Database, schema)
    // team-reader is only on org_solo in seed — use member create internal/shared as staff

    const createShared = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({
          title: 'Shared task',
          boardKey: 'main',
          visibility: 'shared',
        }),
      },
      env,
    )
    expect(createShared.status).toBe(201)
    const shared = (await createShared.json()) as { task: { id: string } }

    const createInternal = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({
          title: 'Internal only',
          boardKey: 'main',
          visibility: 'internal',
        }),
      },
      env,
    )
    expect(createInternal.status).toBe(201)
    const internal = (await createInternal.json()) as { task: { id: string } }

    const listStaff = await app.request(
      '/api/tasks',
      { headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(listStaff.status).toBe(200)
    const staffTasks = (await listStaff.json()) as { tasks: { id: string }[] }
    expect(staffTasks.tasks.map((t) => t.id).sort()).toEqual(
      [shared.task.id, internal.task.id].sort(),
    )

    // Promote team-reader onto acme as reader for external filter
    await db.insert(baMember).values({
      id: 'mem_org_acme_user_team_reader',
      organizationId: ORG,
      userId: 'user_team_reader',
      role: 'reader',
      createdAt: new Date(),
    })

    const readerCookie = await login(app, env, 'team-reader@kit.local')
    const listReader = await app.request(
      '/api/tasks',
      { headers: sessionHeaders(readerCookie, ORG, ORIGIN) },
      env,
    )
    expect(listReader.status).toBe(200)
    const readerTasks = (await listReader.json()) as { tasks: { id: string; title: string }[] }
    expect(readerTasks.tasks.map((t) => t.id)).toEqual([shared.task.id])

    const getInternal = await app.request(
      `/api/tasks/${internal.task.id}`,
      { headers: sessionHeaders(readerCookie, ORG, ORIGIN) },
      env,
    )
    expect(getInternal.status).toBe(404)

    const commentsInternal = await app.request(
      `/api/tasks/${internal.task.id}/comments`,
      { headers: sessionHeaders(readerCookie, ORG, ORIGIN) },
      env,
    )
    expect(commentsInternal.status).toBe(404)

    const comment = await app.request(
      `/api/tasks/${shared.task.id}/comments`,
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({ body: 'Looks good', visibility: 'shared' }),
      },
      env,
    )
    expect(comment.status).toBe(201)

    const comments = await app.request(
      `/api/tasks/${shared.task.id}/comments`,
      { headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(comments.status).toBe(200)
    const body = (await comments.json()) as { comments: { body: string }[] }
    expect(body.comments[0]?.body).toBe('Looks good')

    const stages = await app.request(
      '/api/tasks/stages',
      { headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(stages.status).toBe(200)
    const stageBody = (await stages.json()) as { stages: { id: string; isDefault: boolean }[] }
    const doing = stageBody.stages.find((s) => !s.isDefault)
    expect(doing).toBeTruthy()

    const patch = await app.request(
      `/api/tasks/${shared.task.id}`,
      {
        method: 'PATCH',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({ stageId: doing!.id, title: 'Shared task v2' }),
      },
      env,
    )
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as { task: { title: string; stageId: string } }
    expect(patched.task.title).toBe('Shared task v2')
    expect(patched.task.stageId).toBe(doing!.id)

    const link = await app.request(
      '/api/tasks/links',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({
          fromTaskId: shared.task.id,
          toTaskId: internal.task.id,
          kind: 'blocks',
        }),
      },
      env,
    )
    expect(link.status).toBe(201)

    const listLinks = await app.request(
      '/api/tasks/links',
      { headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(listLinks.status).toBe(200)
    const linksBody = (await listLinks.json()) as {
      links: { fromTaskId: string; toTaskId: string }[]
    }
    expect(linksBody.links.length).toBeGreaterThanOrEqual(1)
    expect(
      linksBody.links.some(
        (l) => l.fromTaskId === shared.task.id && l.toTaskId === internal.task.id,
      ),
    ).toBe(true)

    const readerLinks = await app.request(
      '/api/tasks/links',
      { headers: sessionHeaders(readerCookie, ORG, ORIGIN) },
      env,
    )
    expect(readerLinks.status).toBe(200)
    const readerLinksBody = (await readerLinks.json()) as {
      links: { fromTaskId: string; toTaskId: string }[]
    }
    expect(
      readerLinksBody.links.some(
        (l) => l.fromTaskId === shared.task.id && l.toTaskId === internal.task.id,
      ),
    ).toBe(false)

    const readerPatch = await app.request(
      `/api/tasks/${shared.task.id}`,
      {
        method: 'PATCH',
        headers: sessionHeaders(readerCookie, ORG, ORIGIN),
        body: JSON.stringify({ title: 'nope' }),
      },
      env,
    )
    expect(readerPatch.status).toBe(403)

    const del = await app.request(
      `/api/tasks/${internal.task.id}`,
      { method: 'DELETE', headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(del.status).toBe(200)
  })

  it('stolen task id with other org X-Org-Id is 404', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await login(app, env, 'staff@kit.local')
    const db = createDb(env.DB as unknown as D1Database, schema)
    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, true)
    await setOrgModuleEnabled(db, ORG_TEAM, COMMENTS_MODULE_ID, true)

    const created = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({
          title: 'Acme secret',
          boardKey: 'main',
          visibility: 'shared',
          assigneeIds: ['user_staff'],
        }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string } }

    const other = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({ title: 'Acme other', boardKey: 'main', visibility: 'shared' }),
      },
      env,
    )
    expect(other.status).toBe(201)
    const otherTask = (await other.json()) as { task: { id: string } }

    const commentRes = await app.request(
      `/api/tasks/${task.id}/comments`,
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({ body: 'acme note', visibility: 'shared' }),
      },
      env,
    )
    expect(commentRes.status).toBe(201)
    const { comment } = (await commentRes.json()) as { comment: { id: string } }

    const linkRes = await app.request(
      '/api/tasks/links',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, ORG, ORIGIN),
        body: JSON.stringify({
          fromTaskId: task.id,
          toTaskId: otherTask.task.id,
          kind: 'blocks',
        }),
      },
      env,
    )
    expect(linkRes.status).toBe(201)

    const teamCookie = (
      await signInRequest(app, env, {
        email: 'team-owner@kit.local',
        password: TENANCY_PASSWORD,
        origin: ORIGIN,
      })
    ).cookie
    const team = sessionHeaders(teamCookie, ORG_TEAM, ORIGIN)

    const list = await app.request('/api/tasks', { headers: team }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { tasks: { id: string }[] }
    expect(listed.tasks.map((t) => t.id)).not.toContain(task.id)

    const get = await app.request(`/api/tasks/${task.id}`, { headers: team }, env)
    expect(get.status).toBe(404)

    const patch = await app.request(
      `/api/tasks/${task.id}`,
      { method: 'PATCH', headers: team, body: JSON.stringify({ title: 'stolen' }) },
      env,
    )
    expect(patch.status).toBe(404)

    // A row of the caller's org on the stolen id: a 404 DELETE must not reach it either.
    await db.insert(kitComments).values(directComment('team_row', ORG_TEAM, 'task', task.id))
    const commentsBefore = await commentIds(db)
    const del = await app.request(`/api/tasks/${task.id}`, { method: 'DELETE', headers: team }, env)
    expect(del.status).toBe(404)
    expect(await commentIds(db)).toEqual(commentsBefore)

    const comments = await app.request(`/api/tasks/${task.id}/comments`, { headers: team }, env)
    expect(comments.status).toBe(404)

    const postComment = await app.request(
      `/api/tasks/${task.id}/comments`,
      {
        method: 'POST',
        headers: team,
        body: JSON.stringify({ body: 'nope', visibility: 'shared' }),
      },
      env,
    )
    expect(postComment.status).toBe(404)

    const delComment = await app.request(
      `/api/tasks/comments/${comment.id}`,
      { method: 'DELETE', headers: team },
      env,
    )
    expect(delComment.status).toBe(404)

    const stealLink = await app.request(
      '/api/tasks/links',
      {
        method: 'POST',
        headers: team,
        body: JSON.stringify({
          fromTaskId: task.id,
          toTaskId: otherTask.task.id,
          kind: 'blocks',
        }),
      },
      env,
    )
    expect(stealLink.status).toBe(404)

    // Assignees: another org can neither read nor rewrite them (ADR-0007 D2).
    const stealAssignees = await app.request(
      `/api/tasks/${task.id}`,
      {
        method: 'PATCH',
        headers: team,
        body: JSON.stringify({ assigneeIds: ['user_team_owner'] }),
      },
      env,
    )
    expect(stealAssignees.status).toBe(404)
    const teamList = (await (await app.request('/api/tasks', { headers: team }, env)).json()) as {
      tasks: { id: string; assigneeIds: string[] }[]
    }
    expect(teamList.tasks.flatMap((t) => t.assigneeIds)).not.toContain('user_staff')

    const links = await app.request('/api/tasks/links', { headers: team }, env)
    expect(links.status).toBe(200)
    const linkBody = (await links.json()) as { links: { fromTaskId: string }[] }
    expect(linkBody.links.map((l) => l.fromTaskId)).not.toContain(task.id)

    const stillThere = await app.request(
      `/api/tasks/${task.id}`,
      { headers: sessionHeaders(staffCookie, ORG, ORIGIN) },
      env,
    )
    expect(stillThere.status).toBe(200)
    const owned = (await stillThere.json()) as { task: { assigneeIds: string[] } }
    expect(owned.task.assigneeIds).toEqual(['user_staff'])
  })

  it('deleting a task deletes its comments and no other comment row', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staff = sessionHeaders(await login(app, env, 'staff@kit.local'), ORG, ORIGIN)
    const db = createDb(env.DB as unknown as D1Database, schema)
    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, true)
    await setOrgModuleEnabled(db, ORG_TEAM, COMMENTS_MODULE_ID, true)
    const team = sessionHeaders(
      (
        await signInRequest(app, env, {
          email: 'team-owner@kit.local',
          password: TENANCY_PASSWORD,
          origin: ORIGIN,
        })
      ).cookie,
      ORG_TEAM,
      ORIGIN,
    )

    const createTask = async (h: Record<string, string>, title: string) => {
      const res = await app.request(
        '/api/tasks',
        {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ title, boardKey: 'main', visibility: 'shared' }),
        },
        env,
      )
      expect(res.status, title).toBe(201)
      return ((await res.json()) as { task: { id: string } }).task.id
    }
    const addComment = async (h: Record<string, string>, taskId: string, body: string) => {
      const res = await app.request(
        `/api/tasks/${taskId}/comments`,
        { method: 'POST', headers: h, body: JSON.stringify({ body, visibility: 'shared' }) },
        env,
      )
      expect(res.status, body).toBe(201)
      return ((await res.json()) as { comment: { id: string } }).comment.id
    }

    const doomed = await createTask(staff, 'Doomed')
    const kept = await createTask(staff, 'Kept')
    const teamTask = await createTask(team, 'Team task')
    const doomedComments = [
      await addComment(staff, doomed, 'first'),
      await addComment(staff, doomed, 'second'),
    ]
    await addComment(staff, kept, 'on another task')
    await addComment(team, teamTask, 'in another org')
    // Same target id as the doomed task, one column apart: another org, then another target type.
    await db
      .insert(kitComments)
      .values([
        directComment('other_org_row', ORG_TEAM, 'task', doomed),
        directComment('other_type_row', ORG, 'project', doomed),
      ])
    const before = await commentIds(db)
    expect(before).toEqual(expect.arrayContaining(doomedComments))

    const del = await app.request(`/api/tasks/${doomed}`, { method: 'DELETE', headers: staff }, env)
    expect(del.status).toBe(200)

    expect(await commentIds(db)).toEqual(before.filter((id) => !doomedComments.includes(id)))
  })

  it('task comment routes need the tasks grant, not only comments (403)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await login(app, env, 'staff@kit.local')
    const staff = sessionHeaders(staffCookie, ORG, ORIGIN)
    const db = createDb(env.DB as unknown as D1Database, schema)

    const roleRes = await app.request(
      `/api/orgs/${ORG}/roles`,
      {
        method: 'POST',
        headers: staff,
        body: JSON.stringify({
          key: 'commenter',
          name: 'Commenter',
          grants: [
            { moduleId: COMMENTS_MODULE_ID, access: 'write' },
            { moduleId: TASKS_MODULE_ID, access: 'disabled' },
          ],
        }),
      },
      env,
    )
    expect(roleRes.status).toBe(201)
    const { role } = (await roleRes.json()) as { role: { id: string; key: string } }
    await db.insert(baMember).values({
      id: 'mem_org_acme_user_team_reader',
      organizationId: ORG,
      userId: 'user_team_reader',
      role: role.key,
      createdAt: new Date(),
    })

    const created = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: staff,
        body: JSON.stringify({ title: 'Commented', boardKey: 'main', visibility: 'shared' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string } }
    const seeded = await app.request(
      `/api/tasks/${task.id}/comments`,
      {
        method: 'POST',
        headers: staff,
        body: JSON.stringify({ body: 'staff note', visibility: 'shared' }),
      },
      env,
    )
    expect(seeded.status).toBe(201)
    const { comment } = (await seeded.json()) as { comment: { id: string } }

    const commenter = sessionHeaders(
      (
        await signInRequest(app, env, {
          email: 'team-reader@kit.local',
          password: TENANCY_PASSWORD,
          origin: ORIGIN,
        })
      ).cookie,
      ORG,
      ORIGIN,
    )
    const list = () => app.request(`/api/tasks/${task.id}/comments`, { headers: commenter }, env)
    const post = () =>
      app.request(
        `/api/tasks/${task.id}/comments`,
        {
          method: 'POST',
          headers: commenter,
          body: JSON.stringify({ body: 'commenter note', visibility: 'shared' }),
        },
        env,
      )
    const remove = (id: string) =>
      app.request(`/api/tasks/comments/${id}`, { method: 'DELETE', headers: commenter }, env)

    for (const res of [await list(), await post(), await remove(comment.id)]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        error: { message: MODULE_DENIAL.insufficientGrant },
      })
    }
    const staffList = () => app.request(`/api/tasks/${task.id}/comments`, { headers: staff }, env)
    const onlySeeded = { comments: [{ id: comment.id }] }
    expect(await (await staffList()).json()).toMatchObject(onlySeeded)

    // Same user, same comments grant: tasks read alone turns the three routes back on.
    const grant = await app.request(
      `/api/orgs/${ORG}/roles/${role.id}/grants/${TASKS_MODULE_ID}`,
      { method: 'PATCH', headers: staff, body: JSON.stringify({ access: 'read' }) },
      env,
    )
    expect(grant.status).toBe(200)
    expect(await (await list()).json()).toMatchObject(onlySeeded)
    const own = await post()
    expect(own.status).toBe(201)
    const { comment: ownComment } = (await own.json()) as { comment: { id: string } }
    expect((await remove(ownComment.id)).status).toBe(200)
    expect(await (await staffList()).json()).toMatchObject(onlySeeded)
  })

  it('task comment routes answer 404 when the tasks module is not effective', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    await login(app, env, 'staff@kit.local')
    const db = createDb(env.DB as unknown as D1Database, schema)
    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, true)
    await setOrgModuleEnabled(db, ORG_TEAM, COMMENTS_MODULE_ID, true)
    // signIn, not login: login reseeds and resets the module switches.
    const team = sessionHeaders(
      (
        await signInRequest(app, env, {
          email: 'team-owner@kit.local',
          password: TENANCY_PASSWORD,
          origin: ORIGIN,
        })
      ).cookie,
      ORG_TEAM,
      ORIGIN,
    )

    const created = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: team,
        body: JSON.stringify({ title: 'Team task', boardKey: 'main', visibility: 'shared' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string } }
    const list = () => app.request(`/api/tasks/${task.id}/comments`, { headers: team }, env)
    const seeded = await app.request(
      `/api/tasks/${task.id}/comments`,
      {
        method: 'POST',
        headers: team,
        body: JSON.stringify({ body: 'team note', visibility: 'shared' }),
      },
      env,
    )
    expect(seeded.status).toBe(201)
    const { comment } = (await seeded.json()) as { comment: { id: string } }

    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, false)
    const denied = [
      await list(),
      await app.request(
        `/api/tasks/${task.id}/comments`,
        {
          method: 'POST',
          headers: team,
          body: JSON.stringify({ body: 'nope', visibility: 'shared' }),
        },
        env,
      ),
      await app.request(
        `/api/tasks/comments/${comment.id}`,
        { method: 'DELETE', headers: team },
        env,
      ),
    ]
    for (const res of denied) {
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: { message: MODULE_DENIAL.notAvailable } })
    }

    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, true)
    expect(await (await list()).json()).toMatchObject({ comments: [{ id: comment.id }] })
  })

  it('assignees must be members of the task org (ADR-0007 D2)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await login(app, env, 'staff@kit.local')
    const acme = sessionHeaders(staffCookie, ORG, ORIGIN)
    const post = (body: object) =>
      app.request('/api/tasks', { method: 'POST', headers: acme, body: JSON.stringify(body) }, env)
    const base = { title: 'Assigned', boardKey: 'main', visibility: 'shared' }

    // user_solo exists, but belongs to org_solo only.
    const rejected = await post({ ...base, assigneeIds: ['user_solo'] })
    expect(rejected.status).toBe(400)
    const rejectedBody = (await rejected.json()) as {
      error: { code: string; details: { fieldErrors: Record<string, string[]> } }
    }
    expect(rejectedBody.error.code).toBe('VALIDATION_ERROR')
    expect(rejectedBody.error.details.fieldErrors.assigneeIds?.[0]).toContain('user_solo')
    // an unknown id is just as foreign
    expect((await post({ ...base, assigneeIds: ['user_does_not_exist'] })).status).toBe(400)
    // nothing was created by the rejected attempts
    const afterRejects = (await (
      await app.request('/api/tasks', { headers: acme }, env)
    ).json()) as {
      tasks: unknown[]
    }
    expect(afterRejects.tasks).toEqual([])

    const created = await post({ ...base, assigneeIds: ['user_team_owner', 'user_team_owner'] })
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string; assigneeIds: string[] } }
    expect(task.assigneeIds).toEqual(['user_team_owner'])

    // PATCH with a foreign assignee is rejected and leaves the stored set and the other fields alone.
    const patch = await app.request(
      `/api/tasks/${task.id}`,
      {
        method: 'PATCH',
        headers: acme,
        body: JSON.stringify({ title: 'renamed', assigneeIds: ['user_team_owner', 'user_solo'] }),
      },
      env,
    )
    expect(patch.status).toBe(400)
    const unchanged = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: acme }, env)
    ).json()) as { task: { title: string; assigneeIds: string[] } }
    expect(unchanged.task).toMatchObject({ title: 'Assigned', assigneeIds: ['user_team_owner'] })

    // user_staff administers org_acme, but is not a member of org_team: assigning across orgs fails.
    const db = createDb(env.DB as unknown as D1Database, schema)
    await setOrgModuleEnabled(db, ORG_TEAM, TASKS_MODULE_ID, true)
    const teamCookie = (
      await signInRequest(app, env, {
        email: 'team-owner@kit.local',
        password: TENANCY_PASSWORD,
        origin: ORIGIN,
      })
    ).cookie
    const team = sessionHeaders(teamCookie, ORG_TEAM, ORIGIN)
    const teamTask = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: team,
        body: JSON.stringify({ ...base, assigneeIds: ['user_staff'] }),
      },
      env,
    )
    expect(teamTask.status).toBe(400)
  })
})
