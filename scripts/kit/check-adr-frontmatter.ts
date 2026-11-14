#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.env.ADR_FRONTMATTER_ROOT ?? join(import.meta.dirname, '../..'))
const directory = join(root, 'docs/kit/architecture/adr')
const indexPath = join(root, 'docs/kit/architecture/index.md')
const start = '<!-- ADR-INDEX:START -->'
const end = '<!-- ADR-INDEX:END -->'
const statuses = ['accepted', 'deprecated', 'proposed', 'rejected', 'superseded']
const isDate = (value: unknown): boolean => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}
const fields: Record<string, (value: unknown) => boolean> = {
  title: (value) => typeof value === 'string' && value.trim().length > 0,
  status: (value) => typeof value === 'string' && statuses.includes(value),
  normative: (value) => typeof value === 'boolean',
  axial: (value) => typeof value === 'boolean',
  summary: (value) => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value),
}
type Adr = {
  name: string
  number: string
  title: string
  status: string
  axial: boolean
  summary: string
  supersedes?: string[]
  superseded_by?: string[]
}

function fail(message: string): never {
  throw new Error(message)
}

function readAdr(name: string): Adr {
  const match = /^(\d{4})-[a-z0-9-]+\.md$/.exec(name)
  if (!match?.[1]) return fail(`Invalid ADR filename: ${name}`)
  const text = readFileSync(join(directory, name), 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!frontmatter?.[1]) return fail(`${name}: missing frontmatter`)
  const data: unknown = Bun.YAML.parse(frontmatter[1])
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return fail(`${name}: expected mapping`)
  const record = data as Record<string, unknown>
  for (const [field, valid] of Object.entries(fields)) {
    if (!valid(record[field])) return fail(`${name}: invalid or missing ${field}`)
  }
  validateAuthority(name, record)
  return { ...record, name, number: match[1] } as Adr
}

function validateAuthority(name: string, record: Record<string, unknown>): void {
  if (record.normative && record.status !== 'accepted')
    fail(`${name}: only accepted ADRs may be normative`)
  if (record.date !== undefined && !isDate(record.date)) fail(`${name}: invalid date`)
  if (record.amended !== undefined && !isDate(record.amended)) fail(`${name}: invalid amended date`)
  if (
    typeof record.amended === 'string' &&
    typeof record.date === 'string' &&
    record.amended < record.date
  ) {
    fail(`${name}: amended date precedes date`)
  }
  for (const key of ['supersedes', 'superseded_by']) {
    const value = record[key]
    if (
      value !== undefined &&
      !(Array.isArray(value) && value.every((item: unknown) => typeof item === 'string'))
    ) {
      fail(`${name}: ${key} must be a list of ADR paths`)
    }
  }
}

function loadAdrs(): Adr[] {
  const names = readdirSync(directory).sort()
  if (names.length === 0) return fail('No ADRs found')
  const adrs = names.map(readAdr)
  if (new Set(adrs.map((adr) => adr.number)).size !== adrs.length)
    return fail('Duplicate ADR number')
  if (adrs.filter((adr) => adr.axial).length !== 1) return fail('Exactly one axial ADR is required')
  const paths = new Set(adrs.map((adr) => `docs/kit/architecture/adr/${adr.name}`))
  for (const adr of adrs) {
    for (const path of [...(adr.supersedes ?? []), ...(adr.superseded_by ?? [])]) {
      if (!paths.has(path) || path.endsWith(`/${adr.name}`))
        return fail(`${adr.name}: broken supersession link ${path}`)
    }
    if (adr.status === 'superseded' && !adr.superseded_by?.length) {
      return fail(`${adr.name}: superseded ADR needs superseded_by`)
    }
  }
  return adrs
}

function render(adrs: Adr[]): string {
  const rows = adrs.map((adr) => {
    const title = adr.summary.replaceAll('|', '\\|')
    const status = adr.status === 'accepted' ? '' : ` (${adr.status})`
    return `| [ADR-${adr.number}](./adr/${adr.name}) | ${title}${status} |`
  })
  return [start, '| ADR | Decision |', '| --- | --- |', ...rows, end].join('\n')
}

function main(): void {
  const adrs = loadAdrs()
  const index = readFileSync(indexPath, 'utf8')
  const begin = index.indexOf(start)
  const finish = index.indexOf(end)
  if (
    begin < 0 ||
    finish < begin ||
    index.indexOf(start, begin + 1) !== -1 ||
    index.indexOf(end, finish + 1) !== -1
  ) {
    fail('Index requires exactly one ordered pair of ADR-INDEX markers')
  }
  const expected = `${index.slice(0, begin)}${render(adrs)}${index.slice(finish + end.length)}`
  if (process.argv.includes('--write')) {
    writeFileSync(indexPath, expected)
  } else if (index !== expected) {
    fail('ADR index is stale; run bun run adr:index')
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
