#!/usr/bin/env bun
/** Documentation SSoT and local Markdown-link hygiene. No network access. */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = realpathSync(
  resolve(process.env.DOC_HYGIENE_ROOT ?? join(import.meta.dirname, '../..')),
)
const STACK = '.dev/stack.yml'
const INDEX = 'docs/kit/README.md'
const REQUIRED_MARKDOWN = ['AGENTS.md', 'README.md']

const BASELINE = 'config/kit/doc-hygiene-baseline.json'
const LINE_LIMIT = 400
const FILE_LIMIT = 60_000
const REGENERATE =
  'bun --no-env-file --config=config/kit/bunfig.gates.toml --no-install run scripts/kit/check-doc-hygiene.ts --regenerate-baseline'
type Metrics = { overLimitLines: number; maxLineBytes: number; fileBytes: number }
type Baseline = Record<string, Metrics>

type Issue = { file: string; line: number; message: string }
type Link = { line: number; raw: string; target: string }
type Target = { line: number; key: string; value: string }
const issues: Issue[] = []

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/') || '.'
}

function report(file: string, line: number, message: string): void {
  issues.push({ file: file.split(sep).join('/'), line, message })
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isInside(path: string): boolean {
  return path === ROOT || path.startsWith(`${ROOT}${sep}`)
}

function stripYamlComment(value: string): string {
  let quote = ''
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (char === quote && value[i - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return value.slice(0, i).trim()
  }
  return value.trim()
}

function scalar(value: string): string | null {
  const clean = stripYamlComment(value)
  if (!clean) return null
  if (clean.startsWith('"') && clean.endsWith('"')) {
    try {
      return JSON.parse(clean) as string
    } catch {
      return null
    }
  }
  if (clean.startsWith("'") && clean.endsWith("'")) return clean.slice(1, -1).replaceAll("''", "'")
  if (/^[[{]|[\]}]$/.test(clean)) return null
  return clean
}
function ingestStackMapping(
  section: string,
  match: RegExpMatchArray,
  index: number,
  state: { standards: Target[]; docsPath: Target | null },
): void {
  const value = scalar(match[2])
  if (section === 'standards') {
    if (value === null) report(STACK, index + 1, `standard ${match[1]} must have a path`)
    else state.standards.push({ line: index + 1, key: match[1], value })
    return
  }
  if (match[1] === 'path') {
    if (value === null) report(STACK, index + 1, 'docs.path must be a path')
    else state.docsPath = { line: index + 1, key: 'docs.path', value }
  }
}

function ingestStackLine(
  raw: string,
  index: number,
  state: { section: string; standards: Target[]; docsPath: Target | null },
): void {
  const uncommented = stripYamlComment(raw)
  if (!uncommented) return
  const indent = raw.match(/^ */)?.[0].length ?? 0
  if (indent === 0) {
    state.section = uncommented.match(/^([A-Za-z0-9_-]+):\s*$/)?.[1] ?? ''
    return
  }
  if (state.section !== 'standards' && state.section !== 'docs') return
  if (indent !== 2) {
    if (state.section === 'standards') {
      report(STACK, index + 1, 'standards must be a flat key: path mapping')
    }
    return
  }
  const match = uncommented.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
  if (!match) {
    report(STACK, index + 1, `invalid ${state.section} mapping`)
    return
  }
  ingestStackMapping(state.section, match, index, state)
}

function validateStackTargets(standards: Target[], docsPath: Target | null): void {
  if (standards.length === 0) report(STACK, 1, 'standards block is missing or empty')
  if (!docsPath) report(STACK, 1, 'docs.path is missing')
  const targets = docsPath ? [...standards, docsPath] : standards
  for (const target of targets) {
    const absolute = resolve(ROOT, target.value)
    if (!isInside(absolute)) {
      report(STACK, target.line, `${target.key} escapes repository: ${target.value}`)
      continue
    }
    if (!existsSync(absolute)) {
      report(STACK, target.line, `${target.key} target does not exist: ${target.value}`)
    } else if (!isInside(realpathSync(absolute))) {
      report(STACK, target.line, `${target.key} resolves outside repository: ${target.value}`)
    }
  }
}

function parseStack(): Target[] {
  const path = join(ROOT, STACK)
  if (!existsSync(path)) {
    report(STACK, 1, 'missing stack manifest')
    return []
  }
  const state: { section: string; standards: Target[]; docsPath: Target | null } = {
    section: '',
    standards: [],
    docsPath: null,
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    ingestStackLine(lines[index], index, state)
  }
  validateStackTargets(state.standards, state.docsPath)
  return state.standards
}

function walkMarkdown(dir: string, output: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walkMarkdown(path, output)
    else if (stat.isFile() && name.endsWith('.md')) output.push(path)
  }
}
function toggleFence(fence: string, marker: string): string {
  if (!marker) return fence
  if (!fence) return marker
  if (marker[0] === fence[0] && marker.length >= fence.length) return ''
  return fence
}

function collectLineLinks(line: string, lineNo: number, links: Link[]): void {
  const found = new Set<string>()
  const add = (raw: string): void => {
    if (found.has(raw)) return
    found.add(raw)
    const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
    links.push({ line: lineNo, raw, target })
  }
  for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+[^)]*)?\)/g)) {
    add(match[1])
  }
  const definition = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/)
  if (definition) add(definition[1])
}

function markdownLinks(path: string): Link[] {
  const links: Link[] = []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let fence = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? ''
    if (marker) {
      fence = toggleFence(fence, marker)
      continue
    }
    if (fence) continue
    collectLineLinks(line, index + 1, links)
  }
  return links
}

function ignoredLink(link: Link): boolean {
  const target = link.target.trim()
  if (
    !target ||
    /^(?:https?:|mailto:)/i.test(target) ||
    target.startsWith('#') ||
    target.startsWith('~')
  ) {
    return true
  }
  if (/\.\.\.|…|<[^>]+>|\{[^}]*\}|\$[A-Za-z_{]|\[[^\]]+\]|[*]/.test(target)) return true
  return link.raw.startsWith('<') && !/[/.]/.test(target)
}

function resolveLink(source: string, link: Link, diagnose: boolean): string | null {
  if (ignoredLink(link)) return null
  const pathPart = link.target.split('#', 1)[0].split('?', 1)[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    if (diagnose) report(rel(source), link.line, `invalid URL encoding in link: ${link.target}`)
    return null
  }
  const absolute = resolve(dirname(source), decoded)
  if (!isInside(absolute)) {
    if (diagnose) report(rel(source), link.line, `link escapes repository: ${link.target}`)
    return null
  }
  if (!existsSync(absolute)) {
    if (diagnose) report(rel(source), link.line, `broken internal link: ${link.target}`)
    return absolute
  }
  const actual = realpathSync(absolute)
  if (!isInside(actual)) {
    if (diagnose) report(rel(source), link.line, `link resolves outside repository: ${link.target}`)
    return null
  }
  return actual
}
function collectMarkdownFiles(): string[] {
  const markdown: string[] = []
  for (const file of REQUIRED_MARKDOWN) {
    const path = join(ROOT, file)
    if (!existsSync(path)) report(file, 1, 'required Markdown file is missing')
    else markdown.push(path)
  }
  walkMarkdown(join(ROOT, 'docs/kit'), markdown)
  markdown.sort((a, b) => compareText(rel(a), rel(b)))
  return markdown
}
function measureMarkdown(markdown: string[]): Baseline {
  const result: Baseline = {}
  for (const file of markdown) {
    const bytes = readFileSync(file)
    let overLimitLines = 0
    let maxLineBytes = 0
    let lineBytes = 0
    for (const byte of bytes) {
      if (byte === 10) {
        if (lineBytes > LINE_LIMIT) overLimitLines += 1
        maxLineBytes = Math.max(maxLineBytes, lineBytes)
        lineBytes = 0
      } else {
        lineBytes += 1
      }
    }
    if (lineBytes > LINE_LIMIT) overLimitLines += 1
    maxLineBytes = Math.max(maxLineBytes, lineBytes)
    const metrics = { overLimitLines, maxLineBytes, fileBytes: bytes.length }
    result[rel(file)] = metrics
  }
  return result
}

function loadBaseline(): Baseline | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected an object')
    }
    for (const [file, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`invalid entry: ${file}`)
      }
      const metrics = entry as Record<string, unknown>
      if (
        Object.keys(metrics).length !== 3 ||
        !['overLimitLines', 'maxLineBytes', 'fileBytes'].every(
          (key) => Number.isSafeInteger(metrics[key]) && (metrics[key] as number) >= 0,
        )
      ) {
        throw new Error(`invalid metrics: ${file}`)
      }
    }
    return value as Baseline
  } catch (error) {
    report(
      BASELINE,
      1,
      `cannot read baseline: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function compareBudget(file: string, before: Metrics, after: Metrics, mode: string): boolean {
  let improved = false
  for (const metric of ['overLimitLines', 'maxLineBytes', 'fileBytes'] as const) {
    if (after[metric] > before[metric]) {
      report(
        file,
        1,
        `documentation budget worsened: ${metric} ${before[metric]} -> ${after[metric]}`,
      )
    } else if (after[metric] < before[metric]) {
      improved = true
      if (mode !== '--regenerate-baseline') {
        report(
          file,
          1,
          `stale documentation budget baseline: ${metric} ${before[metric]} -> ${after[metric]}; run ${REGENERATE}`,
        )
      }
    }
  }
  return improved
}

function compareBaseline(
  baseline: Baseline,
  measured: Baseline,
  current: Baseline,
  mode: string,
): boolean {
  let improved = false
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[file]
    const after = measured[file]
    if (!before) {
      report(file, 1, 'new documentation budget violation')
      continue
    }
    if (!current[file]) {
      improved = true
      if (mode !== '--regenerate-baseline') {
        report(file, 1, `stale documentation budget baseline: violation removed; run ${REGENERATE}`)
      }
    }
    if (after && compareBudget(file, before, after, mode)) improved = true
  }
  return improved
}

function checkBudget(markdown: string[], mode: string): void {
  const measured = measureMarkdown(markdown)
  const current = Object.fromEntries(
    Object.entries(measured).filter(
      ([, metrics]) => metrics.overLimitLines > 0 || metrics.fileBytes > FILE_LIMIT,
    ),
  )
  const baselinePath = join(ROOT, BASELINE)
  if (mode === '--init-baseline') {
    if (existsSync(baselinePath)) report(BASELINE, 1, 'initial baseline already exists')
    else if (issues.length === 0) {
      writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
      console.log(
        `check-doc-hygiene: initialized ${BASELINE} (${Object.keys(current).length} files)`,
      )
    }
    return
  }
  const baseline = loadBaseline()
  if (!baseline) return
  const improved = compareBaseline(baseline, measured, current, mode)
  if (mode === '--regenerate-baseline' && issues.length === 0 && improved) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`check-doc-hygiene: regenerated ${BASELINE} (${Object.keys(current).length} files)`)
  }
}

function checkAllLinks(markdown: string[]): {
  linksByFile: Map<string, Link[]>
  checkedLinks: number
} {
  const linksByFile = new Map<string, Link[]>()
  let checkedLinks = 0
  for (const file of markdown) {
    const links = markdownLinks(file)
    linksByFile.set(file, links)
    for (const link of links) {
      if (!ignoredLink(link)) checkedLinks += 1
      resolveLink(file, link, true)
    }
  }
  return { linksByFile, checkedLinks }
}

function checkIndexCoverage(markdown: string[], linksByFile: Map<string, Link[]>): void {
  const indexPath = join(ROOT, INDEX)
  if (!existsSync(indexPath)) {
    report(INDEX, 1, 'central documentation index is missing')
    return
  }
  const indexed = new Set(
    (linksByFile.get(indexPath) ?? markdownLinks(indexPath))
      .map((link) => resolveLink(indexPath, link, false))
      .filter((path): path is string => path !== null),
  )
  for (const file of markdown) {
    if (
      rel(file).startsWith('docs/kit/') &&
      rel(file) !== INDEX &&
      !indexed.has(realpathSync(file))
    ) {
      report(rel(file), 1, `document is not referenced by ${INDEX}`)
    }
  }
}

function finishDocHygiene(standards: number, markdown: number, checkedLinks: number): void {
  issues.sort(
    (a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.message, b.message),
  )
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.file}:${issue.line}: ${issue.message}`)
    console.error(`check-doc-hygiene: FAIL (${issues.length} violation(s))`)
    process.exitCode = 1
    return
  }
  console.log(
    `check-doc-hygiene: OK (${standards} standards, ${markdown} Markdown files, ${checkedLinks} internal links)`,
  )
}

function main(): void {
  const mode = process.argv[2] ?? ''
  if (!['', '--init-baseline', '--regenerate-baseline'].includes(mode) || process.argv.length > 3) {
    console.error('Usage: check-doc-hygiene.ts [--init-baseline | --regenerate-baseline]')
    process.exitCode = 1
    return
  }
  const standards = parseStack()
  const markdown = collectMarkdownFiles()
  const { linksByFile, checkedLinks } = checkAllLinks(markdown)
  checkIndexCoverage(markdown, linksByFile)
  checkBudget(markdown, mode)
  finishDocHygiene(standards.length, markdown.length, checkedLinks)
}

main()
