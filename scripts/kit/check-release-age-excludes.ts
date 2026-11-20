#!/usr/bin/env bun
/** Validate exact Bun release-age exemptions without network access. */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.env.RELEASE_AGE_ROOT ?? join(import.meta.dirname, '../..'))
const fix = 'Use a unique exact package@MAJOR.MINOR.PATCH[-prerelease][+build] entry, or remove it.'
const namePart = '[a-z0-9][a-z0-9._-]*'
const packageName = new RegExp(`^(?:@${namePart}/)?${namePart}$`)
const version =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function fail(message: string): never {
  console.error(`check-release-age-excludes: ${message}`)
  process.exit(1)
}

let config: Record<string, unknown>
try {
  config = Bun.TOML.parse(readFileSync(join(root, 'bunfig.toml'), 'utf8')) as Record<
    string,
    unknown
  >
} catch (error) {
  fail(`cannot read or parse bunfig.toml: ${String(error)}. Fix bunfig.toml.`)
}
const install = config.install
if (
  install !== undefined &&
  (typeof install !== 'object' || install === null || Array.isArray(install))
)
  fail(`[install] is not a table. ${fix}`)
const entries = (install as Record<string, unknown> | undefined)?.minimumReleaseAgeExcludes
if (entries !== undefined && !Array.isArray(entries))
  fail(`minimumReleaseAgeExcludes is ${JSON.stringify(entries)}, not a list. ${fix}`)

const seen = new Set<string>()
for (const [index, entry] of (entries ?? []).entries()) {
  const label = `minimumReleaseAgeExcludes[${index}] ${JSON.stringify(entry)}`
  if (typeof entry !== 'string') fail(`${label} is not a string. ${fix}`)
  const at = entry.lastIndexOf('@')
  const name = entry.slice(0, at)
  if (at <= 0 || name.length > 214 || !packageName.test(name) || !version.test(entry.slice(at + 1)))
    fail(`${label} is not an exact package version. ${fix}`)
  if (seen.has(entry)) fail(`${label} is duplicated. ${fix}`)
  seen.add(entry)
}
console.log(`check-release-age-excludes: OK (${seen.size} exemption(s))`)
