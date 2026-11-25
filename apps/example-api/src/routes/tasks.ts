import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { invalidRequest } from '../lib/openapi'
import { authorization } from '../middleware/authorization'
import { requireOrgContext } from '../middleware/org-context'
import { requireAuth } from '../middleware/require-auth'
import { createNotificationDeliveryRuntime } from '../notifications-delivery/admission'
import * as commentsService from '../services/comments'
import * as tasksService from '../services/tasks'
import { resolveAudience } from '../services/tasks-audience'
import type { AppEnv } from '../types'
import { createTask, deleteTask, getTask, listStages, listTasks, updateTask } from './tasks.schemas'
import {
  createComment,
  createLink,
  deleteComment,
  listComments,
  listLinks,
} from './tasks-comments.schemas'

export const tasksRoutes = new OpenAPIHono<AppEnv>()

const orgMw = requireOrgContext()

function audienceOf(c: Context<AppEnv>) {
  return resolveAudience({
    orgRole: c.get('orgRole'),
    platformRole: c.get('platformRole'),
  })
}

tasksRoutes.use('/api/tasks', requireAuth)
tasksRoutes.use('/api/tasks/*', requireAuth)
tasksRoutes.use('/api/tasks', orgMw)
tasksRoutes.use('/api/tasks/*', orgMw)

tasksRoutes.openapi(listTasks, async (c) => {
  const tasks = await tasksService.listTasksForOrg(c.get('db')!, c.get('orgId')!, audienceOf(c), {
    readOnly: Boolean(authorization.view(c).delegation),
  })
  return c.json({ tasks, requestId: c.get('requestId') })
})

tasksRoutes.openapi(listStages, async (c) => {
  const { boardKey } = c.req.valid('query')
  const stages = await tasksService.listStagesForOrg(c.get('db')!, c.get('orgId')!, boardKey, {
    readOnly: Boolean(authorization.view(c).delegation),
  })
  return c.json({ stages, requestId: c.get('requestId') })
})

tasksRoutes.openapi(listLinks, async (c) => {
  const links = await tasksService.listLinksForOrg(c.get('db')!, c.get('orgId')!, audienceOf(c))
  return c.json({ links, requestId: c.get('requestId') })
})

tasksRoutes.openapi(
  createTask,
  async (c) => {
    const task = await tasksService.createTaskForOrg(
      c.get('db')!,
      createNotificationDeliveryRuntime(c.get('db')!, c.env),
      c.get('orgId')!,
      c.get('subject')!,
      audienceOf(c),
      c.req.valid('json'),
    )
    return c.json({ task, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid task'),
)

tasksRoutes.openapi(
  createLink,
  async (c) => {
    const link = await tasksService.createLinkForOrg(
      c.get('db')!,
      c.get('orgId')!,
      c.get('subject')!,
      audienceOf(c),
      c.req.valid('json'),
    )
    return c.json({ link, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid task link'),
)

tasksRoutes.openapi(deleteComment, async (c) => {
  await commentsService.deleteCommentForOrg(
    c.get('db')!,
    c.get('orgId')!,
    c.req.valid('param').commentId,
    audienceOf(c),
    c.get('subject')!,
  )
  return c.json({ ok: true, requestId: c.get('requestId') })
})

tasksRoutes.openapi(getTask, async (c) => {
  const task = await tasksService.getTaskForOrg(
    c.get('db')!,
    c.get('orgId')!,
    c.req.valid('param').id,
    audienceOf(c),
  )
  return c.json({ task, requestId: c.get('requestId') })
})

tasksRoutes.openapi(
  updateTask,
  async (c) => {
    const task = await tasksService.updateTaskForOrg(
      c.get('db')!,
      createNotificationDeliveryRuntime(c.get('db')!, c.env),
      c.get('orgId')!,
      c.req.valid('param').id,
      c.get('subject')!,
      audienceOf(c),
      c.req.valid('json'),
    )
    return c.json({ task, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid task patch'),
)

tasksRoutes.openapi(deleteTask, async (c) => {
  await tasksService.deleteTaskForOrg(
    c.get('db')!,
    createNotificationDeliveryRuntime(c.get('db')!, c.env),
    c.get('orgId')!,
    c.req.valid('param').id,
    c.get('subject')!,
    audienceOf(c),
  )
  return c.json({ ok: true, requestId: c.get('requestId') })
})

tasksRoutes.openapi(listComments, async (c) => {
  const comments = await commentsService.listCommentsForTarget(
    c.get('db')!,
    c.get('orgId')!,
    'task',
    c.req.valid('param').id,
    audienceOf(c),
  )
  return c.json({ comments, requestId: c.get('requestId') })
})

tasksRoutes.openapi(
  createComment,
  async (c) => {
    const data = c.req.valid('json')
    const comment = await commentsService.createCommentForOrg(
      c.get('db')!,
      c.get('orgId')!,
      c.get('subject')!,
      audienceOf(c),
      {
        ...data,
        targetType: 'task',
        targetId: c.req.valid('param').id,
      },
    )
    return c.json({ comment, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid comment'),
)
