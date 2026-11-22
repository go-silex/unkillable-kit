import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainRef = 'refs/remotes/origin/main'
const marker = '<!-- kit-release-proposal -->'
const changelog = 'CHANGELOG.md'
const productChangelog = 'docs/product/CHANGELOG.md'
const inheritancePath = 'config/product/inheritance.json'
const shaPattern = /^[a-f0-9]{40}$/
const requiredWorkflows = ['.github/workflows/ci.yml', '.github/workflows/secret-scan.yml']
const workflowPath = /^\.github\/workflows\/[\w.-]+\.yml(?![\s\S])/
// Cover the repository's close-linked-issues workflow as well as GitHub's URL references.
const issueClosing =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:(?:[\w.-]+\/[\w.-]+)?#\d+|(?:\[[^\]\n]*\]\()?https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/(?:issues|pulls?)\/\d+)/i
const actionMarker = '- **Product action:**'
const actionPrefix = `${actionMarker} `
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const releaseHeading = /^([0-9]+\.[0-9]+\.[0-9]+) — [0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/
const newline = '\n'
const invalidWhitespace = /[^\S ]|\p{Cc}/u
const characterReference = /&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/
const repoPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/
const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const https = /^https:\/\/[^/?#]+/i
const linkDestination = /\(([^ ()<>"'\\[\]]+)\)/y

type Version = readonly [bigint, bigint, bigint]
type Base = { tag: string; sha: string; version: Version }
type Product = { pin: string; kitComponent: string }
type Source = {
  sha: string
  component: string
  path: string
  gates: string[]
  product: Product | undefined
}
type Heading = { start: number; end: number }
type ReleaseHeading = Heading & { tag: string; version: Version; text: string }
type LineKind = 'blank' | 'heading' | 'item' | 'continuation' | 'plain'
const bareBlock = /^(?:#{1,}|[-*+](?: |$)|\d+[.)](?: |$)|[<>|])/
const fence = /^(?:`{3,}|~{3,})/
type ReleaseSection = {
  prefix: string
  body: string
  rest: string
  headings: ReleaseHeading[]
  actions: string[]
  actionSpans: { start: number; end: number }[]
}
type Proposal = {
  branch: string
  path: string
  sha: string
  tag: string
  title: string
  body: string
  text: string
}

function output(text: string): void {
  // Keep multiline dry-run Markdown readable without handing runner commands to Actions.
  console.log(
    text
      .replace(/\r\n/g, '\n')
      .replace(/[\p{Cc}\u2028\u2029]/gu, (ch) =>
        ch === '\n' || ch === '\t' ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
      .replace(/::/g, ':\\:')
      .replace(/##\[/g, '#\\#['),
  )
}

type CommandTimeout = { ms: number; message: string }

class InvalidUtf8 extends Error {}

function command(
  cmd: string,
  args: string[],
  input?: string,
  extra?: NodeJS.ProcessEnv,
  timeout?: CommandTimeout,
): string {
  const env = { ...process.env, ...extra }
  delete env.RELEASE_WRITE_TOKEN
  const { status, stdout, stderr, error } = spawnSync(cmd, args, {
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeout?.ms,
    killSignal: 'SIGKILL',
  })
  if (timeout && error && 'code' in error && error.code === 'ETIMEDOUT')
    throw new Error(timeout.message)
  if (status !== 0) {
    throw new Error(`${cmd} ${args[0]} failed: ${error?.message ?? stderr.toString().trim()}`)
  }
  // Fail closed rather than round-trip an invalid UTF-8 changelog with altered bytes.
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout)
  } catch (cause) {
    throw new InvalidUtf8(`${cmd} ${args[0]} returned invalid UTF-8`, { cause })
  }
}

function git(args: string[], input?: string, extra?: NodeJS.ProcessEnv): string {
  return command('git', args, input, { GIT_NO_LAZY_FETCH: '1', ...extra })
}

function grammarError(line: number, rule: string): never {
  throw new Error(`CHANGELOG.md line ${line}: ${rule}`)
}

function rejectBlock(content: string, number: number, inItem = false): void {
  if (fence.test(content)) grammarError(number, 'code fences are not allowed')
  if (/^[-*_= :|]+$/.test(content))
    grammarError(number, 'thematic breaks, setext underlines and table delimiters are not allowed')
  if (!inItem && content.startsWith('['))
    grammarError(
      number,
      'lines starting with [ are not allowed because they can define a link reference',
    )
  if (content.startsWith('<!--')) grammarError(number, 'HTML comments are not allowed')
  if (/^[<>|]/.test(content)) grammarError(number, 'HTML, blockquotes and tables are not allowed')
}

function continuation(content: string, previous: LineKind, number: number): LineKind {
  if (!/^ {2}\S/.test(content)) grammarError(number, 'indentation must be exactly two spaces')
  if (/^ {2}(?:[-*+#<>|]|\d+[.)])/.test(content))
    grammarError(number, 'a continuation cannot start with a block marker')
  if (previous !== 'item' && previous !== 'continuation')
    grammarError(number, 'a continuation must immediately follow its list item or continuation')
  return 'continuation'
}

function validateItem(item: string, number: number): void {
  if (!/^\S/.test(item)) grammarError(number, 'list items must start with one space after -')
  rejectBlock(item, number, true)
  if (bareBlock.test(item))
    grammarError(number, 'a list item cannot start with a nested block marker')
}

function isProductAction(content: string, number: number): boolean {
  if (content.startsWith(actionPrefix) && /^\S/.test(content.slice(actionPrefix.length)))
    return true
  if (content.startsWith(actionMarker) || /product action/i.test(content.slice(0, 40))) {
    grammarError(
      number,
      'a Product action marker must be - **Product action:** followed by one space and text',
    )
  }
  return false
}

function parseVersion(text: string): Version | undefined {
  const parsed = semver.exec(text)
  return parsed ? [BigInt(parsed[1]!), BigInt(parsed[2]!), BigInt(parsed[3]!)] : undefined
}

function compareVersions(a: Version, b: Version): number {
  const difference = a.findIndex((value, index) => value !== b[index])
  return difference < 0 ? 0 : a[difference]! > b[difference]! ? 1 : -1
}

function lineKind(content: string, previous: LineKind, number: number): LineKind {
  if (number === 1) {
    if (content !== '# Changelog') grammarError(number, 'the first line must be # Changelog')
    return 'heading'
  }
  if (invalidWhitespace.test(content))
    grammarError(
      number,
      'only ASCII space and LF are allowed as whitespace; controls are forbidden',
    )
  if (/^ {0,3}$/.test(content)) return 'blank'
  const trimmed = content.trimStart()
  rejectBlock(trimmed, number)
  if (content !== trimmed) return continuation(content, previous, number)
  if (/^#{2,3} \S/.test(content)) return 'heading'
  if (content.startsWith('#'))
    grammarError(number, 'only ## and ### headings are allowed after line 1')
  if (content.startsWith('- ')) {
    validateItem(content.slice(2), number)
    return 'item'
  }
  if (bareBlock.test(content)) grammarError(number, 'list items must start with - at column 0')
  if (previous === 'item' || previous === 'continuation')
    grammarError(number, 'a plain paragraph cannot immediately follow a list item or continuation')
  return 'plain'
}

function parseReleaseHeading(
  content: string,
  component: string,
  previous: ReleaseHeading | undefined,
  number: number,
): Pick<ReleaseHeading, 'tag' | 'version' | 'text'> {
  const prefix = `## ${component}/v`
  const label = content.startsWith(prefix)
    ? releaseHeading.exec(content.slice(prefix.length))?.[1]
    : undefined
  const version = label && parseVersion(label)
  if (!version)
    grammarError(number, `expected canonical ## ${component}/vMAJOR.MINOR.PATCH — YYYY-MM-DD`)
  if (previous) {
    const order = compareVersions(previous.version, version)
    if (order === 0) grammarError(number, 'duplicate release version')
    if (order < 0) grammarError(number, 'release versions must be strictly descending')
  }
  return { tag: `${component}/v${label}`, version, text: content }
}

function parseSectionHeading(
  content: string,
  heading: Heading,
  unreleased: Heading | undefined,
  releases: ReleaseHeading[],
  component: string,
  number: number,
): Heading {
  if (content === '## Unreleased') {
    if (unreleased) grammarError(number, 'duplicate ## Unreleased heading')
    return heading
  }
  if (!unreleased) grammarError(number, 'the first ## heading must be exactly ## Unreleased')
  releases.push({ ...heading, ...parseReleaseHeading(content, component, releases.at(-1), number) })
  return unreleased
}

function releaseSection(text: string, component: string): ReleaseSection {
  let unreleased: Heading | undefined
  const headings: ReleaseHeading[] = []
  const actions: { start: number; end: number }[] = []
  let action: (typeof actions)[number] | undefined
  let previous: LineKind = 'blank'
  let offset = 0
  let number = 0
  for (const content of text.split(newline)) {
    number++
    const kind = lineKind(content, previous, number)
    inlineLinks(content, number)
    const end = offset + content.length
    if (kind === 'heading' && content.startsWith('## ')) {
      unreleased = parseSectionHeading(
        content,
        { start: offset, end: Math.min(end + 1, text.length) },
        unreleased,
        headings,
        component,
        number,
      )
    }
    if (kind !== 'continuation') action = undefined
    if (kind === 'item' && isProductAction(content, number)) {
      action = { start: offset, end }
      actions.push(action)
    }
    if (action) action.end = end
    previous = kind
    offset = end + 1
  }
  if (!unreleased) grammarError(1, 'missing ## Unreleased section')
  const start = unreleased.end
  const end = headings[0]?.start ?? text.length
  return {
    prefix: text.slice(0, start),
    body: text.slice(start, end),
    rest: text.slice(end),
    headings,
    actionSpans: actions,
    actions: actions
      .filter((action) => action.start >= start && action.start < end)
      .map((action) => text.slice(action.start, action.end)),
  }
}

function relativeDestination(target: string, number: number): boolean {
  if (target.startsWith('#')) return false
  if (https.test(target) && URL.canParse(target)) return false
  if (scheme.test(target) || /^[?/]/.test(target))
    grammarError(number, 'link destination must be an HTTPS URL, a fragment, or a relative path')
  return true
}

function validateRelativePath(target: string, number: number): void {
  const path = target.split(/[?#]/, 1)[0]!
  if (path.split('/').includes(''))
    grammarError(number, `use a relative path without doubled or trailing slashes: ${target}`)
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /%(?:2f|5c|2e|25)/i.test(path))
    grammarError(
      number,
      `use a repository-root-relative path without . or .. segments or encoded /, backslash, . or %: ${target}`,
    )
}

function codeSpanEnd(line: string, opening: string, after: number, number: number): number {
  const runs = /`+/g
  runs.lastIndex = after
  for (let run = runs.exec(line); run; run = runs.exec(line)) {
    if (run[0].length === opening.length) return runs.lastIndex
  }
  grammarError(number, 'inline code must close with the same backtick run on the same line')
}

function rejectInline(marker: string, number: number): never {
  if (marker === '<!--') grammarError(number, 'HTML comments are not allowed')
  if (marker === '<')
    grammarError(number, '< is not allowed outside inline code; write `a < b` or `<component>`')
  if (marker === '\\') grammarError(number, 'backslashes are not allowed outside inline code')
  if (marker.startsWith('&')) grammarError(number, 'HTML character references are not allowed')
  grammarError(number, 'bare URLs are not allowed; use [text](destination)')
}

function readDestination(line: string, after: number, number: number): string {
  linkDestination.lastIndex = after
  const match = linkDestination.exec(line)
  if (!match)
    grammarError(number, 'expected [text](destination) with a non-empty destination and no title')
  const target = match[1]!
  if (characterReference.test(target))
    grammarError(number, 'HTML character references are not allowed')
  return target
}

function pinnedDestination(target: string, number: number, root?: string): string {
  if (!relativeDestination(target, number)) return target
  validateRelativePath(target, number)
  return root ? root + target : target
}

/** Validate one line and, for proposal rendering only, replace relative destinations. */
function inlineLinks(line: string, number: number, root?: string): string {
  const tokens =
    /`+|<!--|[<\\[\]]|&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);|https?:\/\/|www\.|mailto:/gi
  let label = false
  let copied = 0
  let result = ''
  for (let token = tokens.exec(line); token; token = tokens.exec(line)) {
    const marker = token[0]
    switch (marker[0]) {
      case '`':
        tokens.lastIndex = codeSpanEnd(line, marker, tokens.lastIndex, number)
        break
      case '[':
        if (label) grammarError(number, 'nested link labels are not allowed')
        label = true
        break
      case ']': {
        if (!label) grammarError(number, 'unexpected ] outside inline code')
        label = false
        const start = tokens.lastIndex + 1
        const target = readDestination(line, tokens.lastIndex, number)
        tokens.lastIndex = linkDestination.lastIndex
        const pinned = pinnedDestination(target, number, root)
        if (pinned === target) break
        result += line.slice(copied, start) + pinned
        copied = start + target.length
        break
      }
      default:
        rejectInline(marker, number)
    }
  }
  if (label) grammarError(number, 'unclosed link label (link reference syntax is not allowed)')
  return result + line.slice(copied)
}

function renderNotes(text: string, root: string | undefined): string {
  if (!root) return text
  return text
    .split(newline)
    .map((line, index) => inlineLinks(line, index + 1, root))
    .join(newline)
}

function nextRelease(section: ReleaseSection, component: string, base: Base | undefined): string {
  let nextVersion: Version = [0n, 1n, 0n]
  if (base) {
    const [major, minor, patch] = base.version
    const { actions } = section
    nextVersion = actions.length > 0 ? [major, minor + 1n, 0n] : [major, minor, patch + 1n]
  }
  const tag = `${component}/v${nextVersion.join('.')}`
  const latest = section.headings[0]
  if (latest && compareVersions(nextVersion, latest.version) <= 0) {
    throw new Error(
      `proposed tag ${tag} must be newer than the latest CHANGELOG release ${latest.tag}`,
    )
  }
  return tag
}

function publication(tag: string, gates: string[]): string {
  const checks =
    gates === requiredWorkflows
      ? 'CI and Secret scan push runs'
      : `push runs of ${gates.map((path) => `\`${path}\``).join(', ')}`
  return (
    `### Manual publication\n\n- [ ] Merge this pull request after review.\n- [ ] Wait for successful ${checks} on the merge commit.\n` +
    `- [ ] Create the annotated tag \`${tag}\` on that merge commit. Never move an existing tag.\n` +
    '- [ ] Publish the GitHub Release from the new CHANGELOG section, with Product actions first.'
  )
}

function propose(
  source: Source,
  base: Base | undefined,
  count: string | undefined,
  section: ReleaseSection,
  date: string,
  repo: string | undefined,
  update: string | undefined,
): Proposal {
  const { component, sha, path, gates } = source
  const closingReference = issueClosing.exec(section.body)
  if (closingReference) {
    const before = section.prefix + section.body.slice(0, closingReference.index)
    const line = before.split(newline).length
    throw new Error(`rephrase ${path} line ${line}: release notes must not close issues`)
  }
  const tag = nextRelease(section, component, base)
  const header = `## ${tag} — ${date}`
  const directory = path.slice(0, path.lastIndexOf('/') + 1)
  const root = repo ? `https://github.com/${repo}/blob/${sha}/${directory}` : undefined
  const baseline = base ? `\`${base.tag}\` (\`${base.sha}\`)` : 'None (first Product release)'
  const range = count === undefined ? '' : `  \nCommits in range: ${count}`
  const body = [
    `Proposed tag: \`${tag}\`  \nBase tag: ${baseline}  \nSource SHA: \`${sha}\`${range}`,
    publication(tag, gates),
    `### Product actions\n\n${renderNotes(section.actions.join(newline), root) || 'None.'}`,
    ...(update ? [`### Kit update\n\n${update}`] : []),
    `${header}\n${renderNotes(section.body, root)}`,
  ].join('\n\n')
  return {
    branch: `release/${component}`,
    path,
    sha,
    tag,
    title: `chore(release): ${tag}`,
    body,
    text: `${section.prefix}\n${header}\n${section.body}${section.rest}`,
  }
}

function releaseComponent(text: string): string {
  const config = Bun.YAML.parse(text) as {
    release?: { component?: unknown }
  } | null
  const value = config?.release?.component
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error('invalid release.component in .dev/stack.yml')
  }
  return value
}

function sourceFile(sha: string, path: string): string {
  return git(['show', '--no-textconv', `${sha}:${path}`])
}

function sourceDate(sha: string): string {
  const seconds = git(['show', '-s', '--format=%ct', sha]).trim()
  return new Date(Number(seconds) * 1_000).toISOString().slice(0, 10)
}

function readPin(text: string): string | undefined {
  try {
    const { upstreamCommit } = JSON.parse(text)
    const pin = typeof upstreamCommit === 'string' ? upstreamCommit.toLowerCase() : ''
    if (shaPattern.test(pin)) return pin
  } catch {
    // A malformed marker does not identify a pin.
  }
}

function isLocalCommit(pin: string): boolean {
  return git(['cat-file', '--batch-check=%(objecttype)'], `${pin}\n`).trim() === 'commit'
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return git(['rev-list', '--count', '-n', '1', ancestor, `^${descendant}`]).trim() === '0'
}

function isInheritedTip(pin: string): boolean {
  // Match the inherited-tip check in check-zero-edit-zones.sh.
  const added = git([
    'log',
    '--full-history',
    '--root',
    '-m',
    '--no-renames',
    '--diff-filter=A',
    '-1',
    '--format=%H',
    pin,
    '--',
    inheritancePath,
  ]).trim()
  return added === ''
}

function inheritancePin(text: string, sha: string): string {
  const pin = readPin(text)
  if (pin && isLocalCommit(pin) && isAncestor(pin, sha)) return pin
  throw new Error(
    'invalid Product inheritance pin: expected a commit that is an ancestor of the source SHA',
  )
}

function hasInheritanceMarker(sha: string): boolean {
  return Boolean(git(['ls-tree', sha, '--', inheritancePath]).trim())
}

function markerPin(commit: string): string | undefined {
  if (regularModeAt(commit, inheritancePath)) return readPin(sourceFile(commit, inheritancePath))
}

function productAt(text: string, sha: string, component: string): Product {
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true')
    throw new Error('shallow clone; cannot verify Product inheritance lineage')
  const pin = inheritancePin(text, sha)
  if (!isInheritedTip(pin))
    throw new Error('Product inheritance pin must point at an inherited Kit or mirror tip')
  const kitComponent = releaseComponent(sourceFile(pin, '.dev/stack.yml'))
  if (component === kitComponent)
    throw new Error('Product release.component must differ from the inherited Kit component')
  return { pin, kitComponent }
}

type KitRelease = { tag: string; heading: string; anchor: string; actions: string[] }

function uniqueKitAnchor(title: string, used: Map<string, number>): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replaceAll(' ', '-')
  let anchor = slug
  let suffix = used.get(slug) ?? 0
  while (used.has(anchor)) anchor = `${slug}-${++suffix}`
  used.set(slug, suffix)
  if (anchor !== slug) used.set(anchor, 0)
  return anchor
}

function kitTopicTitle(heading: string): string {
  // Slug visible text, not link destinations or emphasis delimiters.
  const plain = (text: string) => text
  return Bun.markdown.render(heading, {
    heading: plain,
    text: plain,
    link: plain,
    image: () => '',
    codespan: plain,
    emphasis: plain,
    strong: plain,
    strikethrough: plain,
  })
}

function kitAnchors(text: string): Map<number, string> {
  const offsets = new Map<number, string>()
  const used = new Map<string, number>()
  for (const heading of text.matchAll(/^#{1,3} (.+)$/gm)) {
    const title = heading[0].startsWith('### ') ? kitTopicTitle(heading[0]) : heading[1]!
    offsets.set(heading.index, uniqueKitAnchor(title, used))
  }
  return offsets
}

function kitReleases(pin: string, component: string): KitRelease[] | undefined {
  if (!regularModeAt(pin, changelog)) return undefined
  let text: string
  try {
    text = sourceFile(pin, changelog)
  } catch (error) {
    if (error instanceof InvalidUtf8) return undefined
    throw error
  }
  let section: ReleaseSection
  try {
    section = releaseSection(text, component)
  } catch {
    return undefined
  }
  const anchors = kitAnchors(text)
  const { headings, actionSpans } = section
  let actionIndex = 0
  return headings.map(({ start, end, tag }, index) => {
    const limit = headings[index + 1]?.start ?? text.length
    const actions: string[] = []
    for (; actionIndex < actionSpans.length; actionIndex++) {
      const action = actionSpans[actionIndex]!
      if (action.start >= limit) break
      if (action.start >= end) actions.push(text.slice(action.start, action.end))
    }
    return {
      tag,
      heading: text.slice(start + 3, end).trimEnd(),
      anchor: anchors.get(start)!,
      actions,
    }
  })
}

function kitReleaseLabel(release: KitRelease, root: string | undefined): string {
  return root ? `[${release.heading}](${root}${changelog}#${release.anchor})` : release.heading
}

function kitReleaseNotes(release: KitRelease, root: string | undefined): string {
  const label = `- ${kitReleaseLabel(release, root)}`
  const { actions } = release
  if (actions.length === 0) return `${label}\n  - No Product action`
  if (actions.some((action) => issueClosing.test(action))) return label
  const notes = renderNotes(actions.join(newline), root).replace(/^/gm, '  ')
  return `${label}\n${notes}`
}

function legacyKitChangelog(pin: string): string {
  return `Kit changelog at \`${pin}\` predates the strict grammar`
}

function kitBaseline(pin: string, component: string, root: string | undefined): string {
  const releases = kitReleases(pin, component)
  const latest = releases?.[0]
  const summary = `Kit baseline: \`${pin}\``
  if (latest) return `${summary}\n\n- ${kitReleaseLabel(latest, root)}`
  return releases ? summary : `${summary}; ${legacyKitChangelog(pin)}.\n\n${kitChangelogLink(root)}`
}

function kitChangelogLink(root: string | undefined): string {
  return root ? `[Kit CHANGELOG](${root}${changelog})` : 'Kit CHANGELOG'
}

function comparableKitComponent(pin: string): string | undefined {
  if (!regularModeAt(pin, '.dev/stack.yml')) return undefined
  const text = sourceFile(pin, '.dev/stack.yml')
  try {
    return releaseComponent(text)
  } catch {
    return undefined
  }
}

function kitMoveNotes(oldPin: string, pin: string, component: string, root?: string): string {
  const moved = `Kit pin moved from \`${oldPin}\` to \`${pin}\``
  const fallback = (reason: string) => `${moved}; ${reason}.\n\n${kitChangelogLink(root)}`
  if (!isAncestor(oldPin, pin)) return fallback('not a forward update')
  const oldComponent = comparableKitComponent(oldPin)
  if (!oldComponent) return fallback(legacyKitChangelog(oldPin))
  if (oldComponent !== component) return fallback('Kit component changed')
  const previous = kitReleases(oldPin, oldComponent)
  if (!previous) return fallback(legacyKitChangelog(oldPin))
  const current = kitReleases(pin, component)
  if (!current) return fallback(legacyKitChangelog(pin))
  return addedKitNotes(previous, current, oldPin, pin, root)
}

function addedKitNotes(
  previous: KitRelease[],
  current: KitRelease[],
  oldPin: string,
  pin: string,
  root: string | undefined,
): string {
  const previousTags = new Set(previous.map(({ tag }) => tag))
  const added = current.filter(({ tag }) => !previousTags.has(tag))
  const summary = `Kit updated from \`${oldPin}\` to \`${pin}\``
  return added.length
    ? `${summary}.\n\n${added.map((release) => kitReleaseNotes(release, root)).join(newline)}`
    : `${summary}; no Kit release in range.`
}

function kitUpdate(product: Product, base: Base | undefined, repo?: string): string | undefined {
  const { pin, kitComponent } = product
  const root = repo ? `https://github.com/${repo}/blob/${pin}/` : undefined
  if (!base) return kitBaseline(pin, kitComponent, root)
  const oldPin = markerPin(base.sha)
  if (!(oldPin && isLocalCommit(oldPin)))
    return `Previous Kit pin unavailable; current Kit pin: \`${pin}\`.\n\n${kitChangelogLink(root)}`
  if (oldPin !== pin) return kitMoveNotes(oldPin, pin, kitComponent, root)
}

function productTagCommit(tag: string): string | undefined {
  try {
    return git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim()
  } catch {
    return undefined
  }
}

function assertProductBaseHeading(
  commit: string,
  component: string,
  heading: ReleaseHeading,
): void {
  const context = `Product base tag ${heading.tag} target ${productChangelog}`
  if (!regularModeAt(commit, productChangelog)) throw new Error(`${context} is not a regular file`)
  let actual: ReleaseHeading | undefined
  try {
    actual = releaseSection(sourceFile(commit, productChangelog), component).headings[0]
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${context} cannot be read as a strict Product changelog: ${reason}`, { cause })
  }
  if (actual?.text !== heading.text)
    throw new Error(`${context} must have ${heading.text} as its newest released heading`)
}

function productBaseAt(
  sha: string,
  component: string,
  heading: ReleaseHeading | undefined,
): Base | undefined {
  if (!heading) return undefined
  const { tag, version } = heading
  const commit = productTagCommit(tag)
  if (!commit) throw new Error(`Product base tag ${tag} does not point to a commit`)
  if (!regularModeAt(commit, inheritancePath))
    throw new Error(`Product base tag ${tag} does not point to a Product commit`)
  if (!isAncestor(commit, sha))
    throw new Error(`Product base tag ${tag} is not an ancestor of the source SHA`)
  assertProductBaseHeading(commit, component, heading)
  return { tag, version, sha: commit }
}

function baseAt(sha: string, component: string): Base | undefined {
  const prefix = `${component}/v`
  const tags = git([
    'for-each-ref',
    `--merged=${sha}`,
    '--format=%(refname:lstrip=2)',
    `refs/tags/${prefix}*`,
  ]).split('\n')
  let best: { tag: string; version: Version } | undefined
  for (const tag of tags) {
    const version = parseVersion(tag.slice(prefix.length))
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version }
  }
  if (best) return { ...best, sha: git(['rev-parse', `refs/tags/${best.tag}^{commit}`]).trim() }
}

function proposalAt(
  source: Source,
  section: ReleaseSection,
  repo: string | undefined,
): Proposal | 'unpublished' | null {
  const { sha, component, product } = source
  const tags = new Set(
    git(['for-each-ref', '--format=%(refname:lstrip=2)', `refs/tags/${component}/v*`]).split('\n'),
  )
  const unpublished = !product && section.headings.find(({ tag }) => !tags.has(tag))?.tag
  if (unpublished) {
    console.log(`::warning::${unpublished} already has a CHANGELOG section; publish its tag first.`)
    return 'unpublished'
  }
  const base = product ? productBaseAt(sha, component, section.headings[0]) : baseAt(sha, component)
  if (!(base || product))
    throw new Error(`no ${component}/vX.Y.Z tag is an ancestor of the source SHA`)
  if (!section.body.trim()) return null
  const count = product ? undefined : git(['rev-list', '--count', `${base!.sha}..${sha}`]).trim()
  const proposal = propose(
    source,
    base,
    count,
    section,
    sourceDate(sha),
    repo,
    product && kitUpdate(product, base, repo),
  )
  if (tags.has(proposal.tag))
    throw new Error(`tag ${proposal.tag} already exists; will not prepare or move it`)
  return proposal
}

type Pull = {
  number: number
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } | null }
  title: string
  body: string | null
  state: string
}
type Comment = { id: number; body: string; user: { id: number } | null }
type WorkflowRun = {
  id: number
  path: string
  head_sha: string
  head_branch: string
  event: string
  conclusion: string | null
}
type Ref = { ref: string; object: { sha: string } }

type Bot = { id: number; login: string; email: string }

class GitHub {
  constructor(readonly repo: string) {}

  private api<T>(
    path: string,
    options?: {
      pages?: boolean
      method?: string
      body?: Record<string, string>
      timeout?: CommandTimeout
    },
  ): T {
    const args = ['api', `repos/${this.repo}/${path}`]
    if (options?.pages) args.push('--paginate', '--slurp')
    if (options?.method) args.push('--method', options.method, '--input', '-')
    const write = options?.method !== undefined
    const token = write ? process.env.RELEASE_WRITE_TOKEN : process.env.GH_TOKEN
    if (!token) throw new Error(`missing ${write ? 'RELEASE_WRITE_TOKEN' : 'GH_TOKEN'}`)
    return JSON.parse(
      command(
        'gh',
        args,
        write ? JSON.stringify(options.body) : undefined,
        { GH_TOKEN: token },
        options?.timeout,
      ),
    ) as T
  }

  tip(): string {
    return this.api<Ref>('git/ref/heads/main').object.sha
  }

  green(sha: string, gates: string[]): boolean {
    const runs = this.api<{ workflow_runs: WorkflowRun[] }[]>(
      `actions/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
      { pages: true },
    )
      .flatMap((page) => page.workflow_runs)
      .filter(
        (item) => item.head_sha === sha && item.head_branch === 'main' && item.event === 'push',
      )
    return gates.every(
      (path) =>
        runs.filter((item) => item.path === path).sort((a, b) => b.id - a.id)[0]?.conclusion ===
        'success',
    )
  }

  bot(): Bot {
    const id = Number(process.env.RELEASE_BOT_USER_ID)
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error('set RELEASE_BOT_USER_ID to the CI App bot user ID')
    if (!process.env.GH_TOKEN) throw new Error('missing GH_TOKEN')
    const user = JSON.parse(command('gh', ['api', `user/${id}`])) as {
      id: number
      login: string
      type: string
    }
    if (user.id !== id || user.type !== 'Bot' || !/^[a-zA-Z0-9-]+\[bot\]$/.test(user.login))
      throw new Error('invalid CI App bot identity')
    return { id, login: user.login, email: `${id}+${user.login}@users.noreply.github.com` }
  }

  head(branch: string): string | null {
    const ref = `refs/heads/${branch}`
    const found = this.api<Ref[]>(`git/matching-refs/heads/${branch}`).find(
      (entry) => entry.ref === ref,
    )
    if (found && !shaPattern.test(found.object.sha)) throw new Error('invalid proposal branch SHA')
    return found?.object.sha ?? null
  }

  private pull(branch: string): Pull | undefined {
    const owner = this.repo.split('/')[0]
    const pulls = this.api<Pull[][]>(
      `pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      { pages: true },
    )
      .flat()
      .filter((pull) => pull.head.repo?.full_name === this.repo && pull.head.ref === branch)
    if (pulls.length > 1) throw new Error('multiple open proposals on the release branch')
    if (pulls[0]) this.assertPullBase(pulls[0])
    return pulls[0]
  }

  proposalState(branch: string): { pull: Pull | undefined; head: string | null } {
    const pull = this.pull(branch)
    const head = this.head(branch)
    if (!pull) return { pull, head }
    if (!head) throw new Error('proposal branch changed; rerun release preparation')
    const synced = this.waitForPullHead(pull, head)
    if (this.head(branch) !== head)
      throw new Error('proposal branch changed; rerun release preparation')
    return { pull: synced, head }
  }

  private assertPullTarget(current: Pull, previous: Pull, target: string): void {
    const { sha, ref, repo } = current.head
    if (
      current.state !== 'open' ||
      ref !== previous.head.ref ||
      repo?.full_name !== this.repo ||
      (sha !== previous.head.sha && sha !== target)
    )
      throw new Error('proposal changed; rerun release preparation')
    this.assertPullBase(current)
  }

  private assertPullBase(current: Pull): void {
    if (current.base?.ref !== 'main' || current.base.repo?.full_name !== this.repo)
      throw new Error(
        'proposal no longer targets main in this repository; rerun release preparation',
      )
  }

  private waitForPullHead(pull: Pull, target: string): Pull {
    const deadline = performance.now() + 30_000
    const message =
      'proposal PR head did not sync; rerun release preparation via workflow_dispatch without sha'
    // The fake-GitHub tests can skip sleeps; no override can extend the polling window.
    const pollMs = process.env.KIT_RELEASE_TEST_POLL_MS === '0' ? 0 : 2_000
    for (let retry = 0; retry <= 15; retry++) {
      const ms = Math.ceil(deadline - performance.now())
      if (ms <= 0) break
      const current = this.api<Pull>(`pulls/${pull.number}`, { timeout: { ms, message } })
      this.assertPullTarget(current, pull, target)
      if (current.head.sha === target) return current
      if (retry === 15 || performance.now() + pollMs >= deadline) break
      if (pollMs) Bun.sleepSync(pollMs)
    }
    throw new Error(message)
  }

  comment(pull: Pull, bot: Bot): Comment | undefined {
    return this.api<Comment[][]>(`issues/${pull.number}/comments?per_page=100`, { pages: true })
      .flat()
      .find((comment) => comment.user?.id === bot.id && comment.body.startsWith(`${marker}\n`))
  }

  updateComment(pull: Pull, previous: Comment | undefined, body: string): void {
    const path = previous ? `issues/comments/${previous.id}` : `issues/${pull.number}/comments`
    this.api(path, { method: previous ? 'PATCH' : 'POST', body: { body } })
  }

  updatePull(pull: Pull | undefined, proposal: Proposal, head: string): void {
    if (this.head(proposal.branch) !== head)
      throw new Error('proposal branch changed; rerun release preparation')
    const { title, body, branch } = proposal
    if (pull) {
      const current = this.waitForPullHead(pull, head)
      if (this.head(branch) !== head)
        throw new Error('proposal branch changed; rerun release preparation')
      // The lease protects the branch update, not the subsequent title and body write.
      if (current.title !== title || current.body !== body)
        this.api(`pulls/${pull.number}`, { method: 'PATCH', body: { title, body } })
    } else {
      this.api('pulls', { method: 'POST', body: { title, body, head: branch, base: 'main' } })
    }
  }
}

function authenticatedGit(args: string[], token: string | undefined): void {
  if (!token) throw new Error('missing GitHub token for git transport')
  git(
    ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args],
    undefined,
    {
      GH_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0',
    },
  )
}

function regularModeAt(sha: string, path: string): string | undefined {
  return /^(100644|100755) blob /.exec(git(['ls-tree', sha, '--', path]))?.[1]
}

function modeAt(sha: string, path: string): string {
  const mode = regularModeAt(sha, path)
  if (!mode) throw new Error(`${path} is not a regular file`)
  return mode
}

function sameCommit(head: string, proposal: Proposal): boolean {
  const { path } = proposal
  if (
    git(['rev-list', '--parents', '-n', '1', head]).trim() !== `${head} ${proposal.sha}` ||
    git(['show', '-s', '--format=%s', head]).trimEnd() !== proposal.title ||
    git(['diff', '--no-textconv', '--no-ext-diff', '--name-only', proposal.sha, head]).trimEnd() !==
      path
  )
    return false
  return (
    modeAt(head, path) === modeAt(proposal.sha, path) &&
    git(['rev-parse', `${head}:${path}`]).trim() ===
      git(['hash-object', '--stdin'], proposal.text).trim()
  )
}

function createCommit(proposal: Proposal, bot: Bot): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-release-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const mode = modeAt(proposal.sha, proposal.path)
    const blob = git(['hash-object', '-w', '--stdin'], proposal.text).trim()
    git(['read-tree', proposal.sha], undefined, env)
    git(['update-index', '--cacheinfo', `${mode},${blob},${proposal.path}`], undefined, env)
    const tree = git(['write-tree'], undefined, env).trim()
    return git(
      ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', proposal.sha, '-m', proposal.title],
      undefined,
      {
        GIT_AUTHOR_NAME: bot.login,
        GIT_COMMITTER_NAME: bot.login,
        GIT_AUTHOR_EMAIL: bot.email,
        GIT_COMMITTER_EMAIL: bot.email,
      },
    ).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function hasMaintainerCommit(head: string, sha: string, bot: Bot): boolean {
  // Read precisely the observed head; no checkout or local ref is changed by the fetch.
  authenticatedGit(
    ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', head],
    process.env.GH_TOKEN,
  )
  const actual = git(['log', '--format=%an%x00%ae%x00%cn%x00%ce', `${sha}..${head}`]).trimEnd()
  const expected = [bot.login, bot.email, bot.login, bot.email].join('\0')
  return actual.split('\n').some((identity) => identity !== '' && identity !== expected)
}

function maintainerNotice(
  github: GitHub,
  proposal: Proposal,
  pull: Pull | undefined,
  head: string,
  bot: Bot,
  apply: boolean,
): string | null {
  if (!pull)
    throw new Error(
      'release branch contains maintainer commits but has no open proposal; restore or rename it manually',
    )
  const { sha, branch } = proposal
  // A maintainer commit alone does not make the proposal stale while it is based on the tip.
  if (git(['merge-base', sha, head]).trim() === sha) return null
  const message = `${marker}\nThis release proposal is behind main at \`${sha}\`. Refresh it manually to preserve maintainer commits.`
  const comment = github.comment(pull, bot)
  if (comment?.body === message) return null
  if (apply) {
    if (github.tip() !== sha || github.head(branch) !== head) return null
    github.updateComment(pull, comment, message)
  }
  return 'maintainer commits: comment on the stale proposal'
}

function pushProposal(
  github: GitHub,
  proposal: Proposal,
  observed: string | null,
  bot: Bot,
): string | null {
  const ref = `refs/heads/${proposal.branch}`
  const target = createCommit(proposal, bot)
  if (github.tip() !== proposal.sha) return null
  authenticatedGit(
    ['push', `--force-with-lease=${ref}:${observed ?? ''}`, 'origin', `${target}:${ref}`],
    process.env.RELEASE_WRITE_TOKEN,
  )
  return target
}

function reconcile(github: GitHub, proposal: Proposal, apply: boolean): string | null {
  const { branch, sha, title, body } = proposal
  const { pull, head } = github.proposalState(branch)
  const bot = github.bot()
  if (head && hasMaintainerCommit(head, sha, bot)) {
    return maintainerNotice(github, proposal, pull, head, bot, apply)
  }
  const same = head !== null && sameCommit(head, proposal)
  if (same && pull?.title === title && pull.body === body) return null
  if (apply) {
    if (github.tip() !== sha) return null
    const target = same ? head : pushProposal(github, proposal, head, bot)
    if (!target) return null
    github.updatePull(pull, proposal, target)
  }
  return pull ? 'refresh the release proposal' : 'open the release proposal'
}

function releaseMode(arg: string | undefined) {
  switch (arg) {
    case '--check-changelog':
    case '--dry-run':
    case '--plan':
    case '--apply':
      return arg
    default:
      throw new Error(
        'usage: release-prepare.ts (--check-changelog | (--dry-run|--plan|--apply) [--sha <commit>] [--gate <workflow path>]...) [--product]',
      )
  }
}

function requireGate(gate: string | undefined, gates: string[]): string {
  if (!(gate && workflowPath.test(gate)))
    throw new Error('--gate requires a .github/workflows/<name>.yml path')
  if (gates.includes(gate)) throw new Error(`duplicate --gate ${gate}`)
  return gate
}

function readFlags(args: string[], product: boolean) {
  let rev: string | undefined
  const gates: string[] = []
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--product':
        if (product) throw new Error('duplicate --product')
        product = true
        break
      case '--sha':
        if (rev) throw new Error('duplicate --sha')
        rev = args[++i]
        if (!rev || rev.startsWith('--')) throw new Error('--sha requires a commit')
        break
      case '--gate':
        gates.push(requireGate(args[++i], gates))
        break
      default:
        throw new Error(`unexpected argument: ${args[i]}`)
    }
  }
  return { rev, product, gates: gates.length ? gates : requiredWorkflows }
}

function readArgs(args: string[]) {
  const offset = args[0] === '--product' ? 1 : 0
  const mode = releaseMode(args[offset])
  const flags = readFlags(args.slice(offset + 1), offset === 1)
  if (mode === '--check-changelog' && (flags.rev || flags.gates !== requiredWorkflows))
    throw new Error('--check-changelog does not accept --sha or --gate')
  return { mode, ...flags }
}

function resolveSourceSha(rev: string = mainRef): string {
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim()
  if (!shaPattern.test(sha)) throw new Error('invalid source SHA')
  return sha
}

function originGithubRepository(): string | undefined {
  try {
    const remote = git(['remote', 'get-url', 'origin']).trim()
    return /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    )?.[1]
  } catch {
    return undefined
  }
}

function dryRun(source: Source, section: ReleaseSection, repo?: string): void {
  const proposal = proposalAt(source, section, repo)
  const eligibility = 'eligibility: not checked (dry-run)'
  if (proposal === 'unpublished') {
    output(eligibility)
    return
  }
  if (proposal && !repo)
    output('release-prepare: cannot identify a GitHub repository; relative links are unchanged')
  const detail = proposal ? `${proposal.title}\n\n${proposal.body}` : 'No unreleased changes.'
  output(`${eligibility}\n\n${detail}`)
}

function changelogPath(product: boolean): string {
  return product ? productChangelog : changelog
}

function requireProductMarker(): never {
  throw new Error(`--product requires ${inheritancePath}`)
}

function productChangelogPresent(): boolean {
  for (const directory of ['docs', 'docs/product']) {
    const entry = lstatSync(directory, { throwIfNoEntry: false })
    if (!entry) return false
    if (!entry.isDirectory()) throw new Error(`${directory} is not a real directory`)
  }
  const entry = lstatSync(productChangelog, { throwIfNoEntry: false })
  if (!entry) return false
  if (!entry.isFile()) throw new Error(`${productChangelog} is not a regular file`)
  return true
}

function checkChangelog(product: boolean): void {
  const hasMarker = existsSync(inheritancePath)
  if (product && !hasMarker) requireProductMarker()
  if (!product && hasMarker) return
  const path = changelogPath(product)
  if (product && !productChangelogPresent()) {
    output('release-prepare: Product CHANGELOG.md is absent; skipped')
    return
  }
  const component = releaseComponent(readFileSync('.dev/stack.yml', 'utf8'))
  if (product) productAt(readFileSync(inheritancePath, 'utf8'), resolveSourceSha('HEAD'), component)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path))
  releaseSection(text, component)
  output('release-prepare: CHANGELOG grammar OK')
}

function readSource(sha: string, product: boolean, gates: string[]): Source | undefined {
  const hasMarker = hasInheritanceMarker(sha)
  if (product && !hasMarker) requireProductMarker()
  if (!product && hasMarker) return undefined
  const component = releaseComponent(sourceFile(sha, '.dev/stack.yml'))
  const path = changelogPath(product)
  if (product) modeAt(sha, inheritancePath)
  const productInfo = product
    ? productAt(sourceFile(sha, inheritancePath), sha, component)
    : undefined
  if (product) modeAt(sha, path)
  return {
    sha,
    component,
    path,
    gates,
    product: productInfo,
  }
}

function main(): void {
  const { mode, rev, product, gates } = readArgs(process.argv.slice(2))
  if (mode === '--check-changelog') {
    checkChangelog(product)
    return
  }
  const source = readSource(resolveSourceSha(rev), product, gates)
  if (!source) {
    output('release-prepare: Product tree; skipped')
    return
  }
  const { sha, path, component } = source
  const section = releaseSection(sourceFile(sha, path), component)
  const repo = process.env.GITHUB_REPOSITORY
  if (repo !== undefined && !repoPattern.test(repo))
    throw new Error('set GITHUB_REPOSITORY to owner/repo')
  if (mode === '--dry-run') {
    dryRun(source, section, repo ?? originGithubRepository())
    return
  }
  reconcileSource(source, section, repo, mode === '--apply')
}

function reconcileSource(
  source: Source,
  section: ReleaseSection,
  repo: string | undefined,
  apply: boolean,
): void {
  if (!repo) throw new Error('set GITHUB_REPOSITORY to owner/repo')
  const { sha, gates } = source
  const github = new GitHub(repo)
  const tip = github.tip()
  if (!shaPattern.test(tip)) throw new Error('invalid main SHA from GitHub')
  if (sha !== tip) {
    output('release-prepare: source is not the current first-parent tip of main; skipped')
    return
  }
  if (!github.green(sha, gates)) {
    output(
      gates === requiredWorkflows
        ? 'release-prepare: CI and Secret scan are not both green for this main push; skipped'
        : 'release-prepare: required workflow gates are not all green for this main push; skipped',
    )
    return
  }
  const proposal = proposalAt(source, section, repo)
  if (proposal === 'unpublished') return
  const action = proposal && reconcile(github, proposal, apply)
  if (action && !apply && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, 'write=true\n')
  output(
    action ? `release-prepare: ${action}` : 'release-prepare: unchanged or no unreleased changes',
  )
}

try {
  main()
} catch (error) {
  output(`release-prepare: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
