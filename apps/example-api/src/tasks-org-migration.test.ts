import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

/**
 * Task tenancy migrations (ADR-0007 D2) on a database that already holds data:
 * 0018 (expand, in the journal) backfills kit_task_assignees.org_id from the owning task;
 * 0019 (contract, in the journal) purges rows that
 * break the tenancy rule, then enforces NOT NULL + composite FKs.
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const journal = join(__dirname, '../migrations')
const CONTRACT = join(journal, '0019_tasks_org_fk_contract.sql')

/** Applies the journal files with `after < name <= last`, in order, like `migrations apply`. */
function applyRange(sqlite: Database.Database, after: string, last: string) {
  for (const name of readdirSync(journal)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (name <= after || name > last) continue
    sqlite.exec(readFileSync(join(journal, name), 'utf8'))
  }
}

const THROUGH_0017 = '0017_flow_run_events.sql'
const THROUGH_0018 = '0018_tasks_assignees_org.sql'

function insertStage(sqlite: Database.Database, org: string, id: string) {
  sqlite
    .prepare(
      `INSERT INTO kit_task_stages (id, org_id, board_key, label, position, created_at, updated_at)
       VALUES (?, ?, 'b', 'L', 0, 1, 1)`,
    )
    .run(id, org)
}

function insertTask(sqlite: Database.Database, org: string, id: string, stageId: string) {
  sqlite
    .prepare(
      `INSERT INTO kit_tasks (id, org_id, title, board_key, stage_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'b', ?, 'u', 1, 1)`,
    )
    .run(id, org, id, stageId)
}

/** Assignee as the previous Worker writes it: no org_id column. */
function insertLegacyAssignee(sqlite: Database.Database, taskId: string, userId: string) {
  sqlite
    .prepare(`INSERT INTO kit_task_assignees (task_id, user_id, created_at) VALUES (?, ?, 1)`)
    .run(taskId, userId)
}

function insertAssignee(sqlite: Database.Database, org: string, taskId: string, userId: string) {
  sqlite
    .prepare(
      `INSERT INTO kit_task_assignees (org_id, task_id, user_id, created_at) VALUES (?, ?, ?, 1)`,
    )
    .run(org, taskId, userId)
}

function insertLink(sqlite: Database.Database, org: string, id: string, from: string, to: string) {
  sqlite
    .prepare(
      `INSERT INTO kit_task_links (id, org_id, from_task_id, to_task_id, kind, created_at)
       VALUES (?, ?, ?, ?, 'blocks', 1)`,
    )
    .run(id, org, from, to)
}

function rows(sqlite: Database.Database, sql: string) {
  return sqlite.prepare(sql).all()
}

/** 0017-shaped data: org-a has t1, t2; org-b has t3; assignees carry no org column yet. */
function openAt0017WithData() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyRange(sqlite, '', THROUGH_0017)
  insertStage(sqlite, 'org-a', 's-a')
  insertStage(sqlite, 'org-b', 's-b')
  insertTask(sqlite, 'org-a', 't1', 's-a')
  insertTask(sqlite, 'org-a', 't2', 's-a')
  insertTask(sqlite, 'org-b', 't3', 's-b')
  insertLegacyAssignee(sqlite, 't1', 'u1')
  insertLegacyAssignee(sqlite, 't3', 'u9')
  insertLink(sqlite, 'org-a', 'l-ok', 't1', 't2')
  // The old schema accepted a link whose org differs from its tasks' org.
  insertLink(sqlite, 'org-b', 'l-cross', 't1', 't3')
  return sqlite
}

describe('0018 tasks_assignees_org (expand)', () => {
  it('backfills org_id from the owning task and keeps every row', () => {
    const sqlite = openAt0017WithData()
    applyRange(sqlite, THROUGH_0017, THROUGH_0018)

    expect(
      rows(sqlite, 'SELECT task_id, user_id, org_id FROM kit_task_assignees ORDER BY task_id'),
    ).toEqual([
      { task_id: 't1', user_id: 'u1', org_id: 'org-a' },
      { task_id: 't3', user_id: 'u9', org_id: 'org-b' },
    ])
    expect(rows(sqlite, 'SELECT count(*) AS n FROM kit_tasks')).toEqual([{ n: 3 }])
    // Additive only: the old Worker's INSERT (no org_id) still works during the deploy window.
    expect(() => insertLegacyAssignee(sqlite, 't2', 'u2')).not.toThrow()
  })

  it('makes (id, org_id) a unique key on kit_tasks', () => {
    const sqlite = openAt0017WithData()
    applyRange(sqlite, THROUGH_0017, THROUGH_0018)
    expect(rows(sqlite, 'PRAGMA index_list(kit_tasks)')).toContainEqual(
      expect.objectContaining({ name: 'kit_tasks_id_org_uidx', unique: 1 }),
    )
  })
})

describe('0019 tasks_org_fk_contract', () => {
  function openAt0018WithDamage() {
    const sqlite = openAt0017WithData()
    applyRange(sqlite, THROUGH_0017, THROUGH_0018)
    // Written by the previous Worker after 0018: no org_id.
    insertLegacyAssignee(sqlite, 't2', 'late')
    // Corruption the old schema allowed: an assignee whose org is not its task's org, and one
    // pointing at a task that no longer exists.
    insertAssignee(sqlite, 'org-b', 't1', 'evil')
    sqlite.pragma('foreign_keys = OFF')
    insertAssignee(sqlite, 'org-a', 'gone', 'ghost')
    sqlite.pragma('foreign_keys = ON')
    return sqlite
  }

  it('re-backfills NULL org_id, purges mismatched assignees and links, keeps valid rows', () => {
    const sqlite = openAt0018WithDamage()
    sqlite.exec(readFileSync(CONTRACT, 'utf8'))

    expect(
      rows(sqlite, 'SELECT org_id, task_id, user_id FROM kit_task_assignees ORDER BY user_id'),
    ).toEqual([
      { org_id: 'org-a', task_id: 't2', user_id: 'late' },
      { org_id: 'org-a', task_id: 't1', user_id: 'u1' },
      { org_id: 'org-b', task_id: 't3', user_id: 'u9' },
    ])
    expect(rows(sqlite, 'SELECT id FROM kit_task_links')).toEqual([{ id: 'l-ok' }])
    expect(rows(sqlite, 'SELECT count(*) AS n FROM kit_tasks')).toEqual([{ n: 3 }])
    expect(rows(sqlite, 'PRAGMA foreign_key_check')).toEqual([])
  })

  it('enforces NOT NULL and the composite tenancy FKs afterwards', () => {
    const sqlite = openAt0018WithDamage()
    sqlite.exec(readFileSync(CONTRACT, 'utf8'))

    expect(() => insertLegacyAssignee(sqlite, 't1', 'x')).toThrow(/NOT NULL/i)
    expect(() => insertAssignee(sqlite, 'org-b', 't1', 'x')).toThrow(/FOREIGN KEY/i)
    expect(() => insertLink(sqlite, 'org-b', 'lx', 't1', 't3')).toThrow(/FOREIGN KEY/i)
    expect(() =>
      sqlite.prepare("UPDATE kit_tasks SET org_id = 'org-b' WHERE id = 't1'").run(),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('cascades from kit_tasks to the rebuilt children', () => {
    const sqlite = openAt0018WithDamage()
    sqlite.exec(readFileSync(CONTRACT, 'utf8'))
    sqlite.prepare("DELETE FROM kit_tasks WHERE id = 't1'").run()
    expect(rows(sqlite, "SELECT user_id FROM kit_task_assignees WHERE task_id = 't1'")).toEqual([])
    expect(rows(sqlite, 'SELECT id FROM kit_task_links')).toEqual([])
  })
})
