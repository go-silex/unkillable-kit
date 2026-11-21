/**
 * ADR-0007 task board Drizzle tables; tenancy shape in its D2.
 * Applied SQL SSoT: apps/example-api/migrations/* (dogfood tranche), 0013 + 0018.
 */
import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/** ADR-0007 — task stages (kanban columns per board_key). */
export const kitTaskStages = sqliteTable('kit_task_stages', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  boardKey: text('board_key').notNull(),
  label: text('label').notNull(),
  position: integer('position', { mode: 'number' }).notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

/** ADR-0007 — work items. */
export const kitTasks = sqliteTable(
  'kit_tasks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    boardKey: text('board_key').notNull(),
    stageId: text('stage_id').notNull(),
    visibility: text('visibility').notNull().default('shared'),
    scopeKind: text('scope_kind'),
    scopeId: text('scope_id'),
    priority: text('priority'),
    dueAt: integer('due_at', { mode: 'number' }),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    orderIndex: integer('order_index', { mode: 'number' }).notNull().default(0),
    externalUrl: text('external_url'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  // Target of the composite tenancy FKs (ADR-0007 D2): children bind to (id, org_id).
  (t) => [unique('kit_tasks_id_org_uidx').on(t.id, t.orgId)],
)

/**
 * ADR-0007 D2: `org_id` is the task's owner Organization. Migration 0019 enforces NOT NULL
 * and composite ownership foreign keys; repository reads and writes remain owner-scoped.
 */
export const kitTaskAssignees = sqliteTable(
  'kit_task_assignees',
  {
    orgId: text('org_id').notNull(),
    taskId: text('task_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
)

export const kitTaskLinks = sqliteTable('kit_task_links', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  fromTaskId: text('from_task_id').notNull(),
  toTaskId: text('to_task_id').notNull(),
  kind: text('kind').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
})

export const tasksDrizzleSchema = {
  kitTaskStages,
  kitTasks,
  kitTaskAssignees,
  kitTaskLinks,
}
