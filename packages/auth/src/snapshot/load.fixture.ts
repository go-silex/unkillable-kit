import { createHmac, randomUUID } from 'node:crypto'
import type { KitD1Database } from '@kit/db'
import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { type Mock, onTestFinished, vi } from 'vitest'

const DDL = `
CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, disabled INTEGER);
CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT UNIQUE, user_id TEXT, expires_at INTEGER);
CREATE TABLE api_keys (key_prefix TEXT PRIMARY KEY, key_hash TEXT, subject TEXT,
  organization_id TEXT, scopes TEXT, expires_at INTEGER, revoked_at INTEGER);
CREATE TABLE user_platform_roles (user_id TEXT PRIMARY KEY, role TEXT);
CREATE TABLE organization (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE member (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT, role TEXT);
CREATE TABLE organization_roles (id TEXT PRIMARY KEY, organization_id TEXT, key TEXT);
CREATE TABLE organization_role_module_grants (role_id TEXT, module_id TEXT, access TEXT);
CREATE TABLE organization_modules (organization_id TEXT, module_id TEXT, enabled INTEGER);
CREATE TABLE platform_modules (module_id TEXT PRIMARY KEY, available INTEGER);
CREATE TABLE impersonation_sessions (id TEXT PRIMARY KEY, session_id TEXT UNIQUE, actor_user_id TEXT,
  subject_user_id TEXT, organization_id TEXT, mode TEXT, created_at INTEGER);
CREATE TABLE impersonation_role_permissions (role TEXT PRIMARY KEY, read INTEGER, write INTEGER);
CREATE TABLE product_flags (user_id TEXT, organization_id TEXT, flag TEXT);
CREATE TABLE product_grants (user_id TEXT, grant_id TEXT, client_id TEXT, denied INTEGER);
INSERT INTO user VALUES ('actor', 'Actor', 'actor@example.test', 0), ('target', 'Target', 'target@example.test', 0);
INSERT INTO organization VALUES ('chosen', 'active'), ('other', 'active');
INSERT INTO member VALUES ('ma', 'chosen', 'actor', 'staff_like'), ('mt', 'chosen', 'target', 'reader'),
  ('mo', 'other', 'actor', 'staff_like');
INSERT INTO organization_roles VALUES ('a', 'chosen', 'staff_like'), ('r', 'chosen', 'reader'), ('b', 'other', 'staff_like');
INSERT INTO organization_role_module_grants VALUES ('a', 'calendar', 'write'), ('r', 'calendar', 'read'), ('b', 'calendar', 'disabled');
INSERT INTO platform_modules VALUES ('calendar', 1);
INSERT INTO organization_modules VALUES ('chosen', 'calendar', 1), ('other', 'calendar', 0);
INSERT INTO product_flags VALUES ('actor', 'chosen', 'eligible'), ('target', 'chosen', 'represented'),
  ('target', 'other', 'different organization');
INSERT INTO product_grants VALUES ('actor', 'grant', 'client', 1), ('actor', 'grant', 'another-client', 0),
  ('target', 'grant', 'client', 0), ('actor', 'another-grant', 'client', 0);
`

export const DELEGATION_ROWS = `
INSERT INTO user_platform_roles VALUES ('actor', 'super_admin');
INSERT INTO impersonation_role_permissions VALUES ('super_admin', 1, 0);
INSERT INTO impersonation_sessions VALUES ('delegation', 'session-id', 'actor', 'target', 'chosen', 'read', 1);
`

export function fixture(): {
  sqlite: Database.Database
  db: {
    prepare: Mock<KitD1Database['prepare']>
    batch: Mock<NonNullable<KitD1Database['batch']>>
    withSession: Mock<() => never>
  }
  cookie: { name: string; header: string; secret: string }
  token: string
} {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  sqlite.exec(DDL)
  const token = randomUUID()
  const secret = randomUUID()
  const name = 'product.session'
  const signature = createHmac('sha256', secret).update(token).digest('base64')
  const cookie = { name, secret, header: `${name}=${encodeURIComponent(`${token}.${signature}`)}` }
  sqlite
    .prepare('INSERT INTO session VALUES (?, ?, ?, ?)')
    .run('session-id', token, 'actor', Date.now() + 60_000)
  const primary = createSqliteD1(sqlite)
  const rejectDirectRead = () => {
    throw new Error('Authorization reads must go through the primary batch')
  }
  const direct = {
    first: rejectDirectRead,
    all: rejectDirectRead,
    run: rejectDirectRead,
    raw: rejectDirectRead,
  }
  const db = {
    prepare: vi.fn((query: string) => {
      const statement = primary.prepare(query)
      const bind = statement.bind
      return Object.assign(statement, direct, {
        bind: (...values: unknown[]) => Object.assign(bind(...values), direct),
      })
    }),
    batch: vi.fn(primary.batch),
    withSession: vi.fn(() => {
      throw new Error('This fixture does not permit a replica-capable session')
    }),
  }
  return { sqlite, db, cookie, token }
}
