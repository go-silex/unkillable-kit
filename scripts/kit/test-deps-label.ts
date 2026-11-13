#!/usr/bin/env bun
// Eligibility belongs to the immutable guard, not a label workflow expression.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { dependencyEligibility } from './deps-guard/metadata.ts'

const header = 'Update dependencies\n\n---\nupdated-dependencies:\n'
const patch = '- dependency-name: hono\n  update-type: version-update:semver-patch\n'
const minor = '- dependency-name: vite\n  update-type: version-update:semver-minor\n'
const end = '...\n'
assert.equal(dependencyEligibility([header + patch + minor + end]), undefined)
for (const bad of [
  `${header}${patch}- dependency-name: vite\n  update-type: version-update:semver-major\n${end}`,
  `${header}${patch}- dependency-name: wrangler\n  update-type: version-update:semver-minor\n${end}`,
  `${header}${patch}- dependency-name: vite\n  update-type: unknown\n${end}`,
  `${header}[]\n${end}`,
  'not metadata',
  `${header}- dependency-name: [invalid\n${end}`,
])
  assert.ok(dependencyEligibility([bad]))
assert.ok(dependencyEligibility([]))
console.log('test-deps-label: immutable metadata eligibility OK')
const offline = Bun.spawnSync([
  process.execPath,
  join(import.meta.dirname, 'check-deps-guard.ts'),
  '--pr-evaluate',
  '--base-lock',
  'unused-base',
  '--head-lock',
  'unused-head',
])
assert.notEqual(offline.exitCode, 0, 'lock-only mode cannot authorize a PR')
