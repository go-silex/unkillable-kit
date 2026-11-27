import {
  defineNotificationRegistry,
  defineNotificationType,
  type EmailContent,
} from '@kit/notifications'
import { MAX_TASK_TITLE_LEN } from '@kit/tasks'
import * as z from 'zod'
import { type NotificationLocale, notificationMessages } from '../messages'

type Message = { email: EmailContent; slack: { text: string } }
type Locale = NotificationLocale
const assignedParams = z.strictObject({ taskTitle: z.string().min(1).max(MAX_TASK_TITLE_LEN) })

const assigned = defineNotificationType<typeof assignedParams, Message, Locale>({
  category: 'tasks',
  moduleId: 'tasks',
  params: assignedParams,
  channels: ['email', 'slack'],
  defaultOn: ['email', 'slack'],
  render: {
    in_app: ({ params, href, locale }) => ({
      title: notificationMessages.t(locale).taskAssigned,
      body: params.taskTitle,
      href,
    }),
    email: ({ params, href, locale }) => ({
      subject: notificationMessages.t(locale).taskAssigned,
      text: `${params.taskTitle}\n${href}`,
    }),
    slack: ({ params, href, locale }) => ({
      text: `${notificationMessages.t(locale).taskAssigned}: ${params.taskTitle}\n${href}`,
    }),
  },
})

const approvalParams = z.strictObject({})
const approval = defineNotificationType<typeof approvalParams, Message, Locale>({
  category: 'flows',
  moduleId: 'flows',
  params: approvalParams,
  channels: ['email', 'slack'],
  defaultOn: ['email', 'slack'],
  organizationDestinations: true,
  render: {
    in_app: ({ href, locale }) => ({
      title: notificationMessages.t(locale).approvalRequested,
      body: notificationMessages.t(locale).approvalBody,
      href,
    }),
    email: ({ href, locale }) => ({
      subject: notificationMessages.t(locale).approvalRequested,
      text: `${notificationMessages.t(locale).approvalBody}\n${href}`,
    }),
    slack: ({ href, locale }) => ({
      text: `${notificationMessages.t(locale).approvalBody}\n${href}`,
    }),
  },
})

export const notificationsDogfoodRegistry = defineNotificationRegistry({
  'tasks.assigned': assigned,
  'flows.approval_requested': approval,
})
