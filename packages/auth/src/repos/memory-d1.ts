/**
 * SQLite-backed D1-compatible handle for @kit/auth repo tests.
 * Table DDL is local (column names from tenancy-schema + better-auth-schema).
 */

import { createSqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/d1'
import { onTestFinished } from 'vitest'
import { baMember, baOrganization, kitAuthSchema } from '../better-auth-schema'
import type { KitRepoDb } from './db-type'

function closeAfterTest(sqlite: Database.Database): () => void {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    sqlite.close()
  }
  onTestFinished(close)
  return close
}

const AUTH_REPO_DDL = `
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE kit_modules (
  id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE user_platform_roles (
  user_id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE organization (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'client',
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE member (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_limit_buckets (
  bucket_key TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start_ms)
);
CREATE TABLE invitation (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  inviter_id TEXT NOT NULL
);
CREATE TABLE organization_roles (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE organization_role_module_grants (
  role_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  access TEXT NOT NULL,
  PRIMARY KEY (role_id, module_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, actor_user_id TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, org_id TEXT, ip TEXT, meta_json TEXT
);
CREATE TABLE impersonation_role_permissions (
  role TEXT PRIMARY KEY NOT NULL CHECK (role IN ('staff', 'super_admin')),
  read INTEGER NOT NULL DEFAULT 0, write INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE impersonation_sessions (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL, subject_user_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')), created_at INTEGER NOT NULL,
  CHECK (actor_user_id <> subject_user_id)
);

`

type MemoryD1Binding = Parameters<typeof drizzle>[0] & { close(): void }

/** The D1-shaped binding alone: two handles on one binding share rows, like two isolates. */
export function createMemoryD1Binding(): MemoryD1Binding {
  const sqlite = new Database(':memory:')
  const close = closeAfterTest(sqlite)
  sqlite.pragma('foreign_keys = OFF')
  sqlite.exec(AUTH_REPO_DDL)
  return Object.assign(createSqliteD1(sqlite), { close }) as MemoryD1Binding
}

export type MemoryD1 = KitRepoDb & { close(): void }

export function createMemoryD1(binding: MemoryD1Binding = createMemoryD1Binding()): MemoryD1 {
  return Object.assign(
    drizzle(binding, {
      schema: { ...kitAuthSchema, organization: baOrganization, member: baMember },
    }),
    { close: binding.close },
  ) as MemoryD1
}
