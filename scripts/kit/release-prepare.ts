import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainRef = 'refs/remotes/origin/main'
const marker = '<!-- kit-release-proposal -->'
const changelog = 'CHANGELOG.md'
const shaPattern = /^[a-f0-9]{40}$/
const requiredWorkflows = ['.github/workflows/ci.yml', '.github/workflows/secret-scan.yml']
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
type Heading = { start: number; end: number }
type ReleaseHeading = Heading & { tag: string; version: Version }
type LineKind = 'blank' | 'heading' | 'item' | 'continuation' | 'plain'
const bareBlock = /^(?:#{1,}|[-*+](?: |$)|\d+[.)](?: |$)|[<>|])/
const fence = /^(?:`{3,}|~{3,})/
type ReleaseSection = {
  prefix: string
  body: string
  rest: string
  headings: ReleaseHeading[]
  actions: string[]
}
type Proposal = {
  branch: string
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

function command(cmd: string, args: string[], input?: string, extra?: NodeJS.ProcessEnv): string {
  const env = { ...process.env, ...extra }
  delete env.RELEASE_WRITE_TOKEN
  const { status, stdout, stderr, error } = spawnSync(cmd, args, {
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (status !== 0) {
    throw new Error(`${cmd} ${args[0]} failed: ${error?.message ?? stderr.toString().trim()}`)
  }
  // Fail closed rather than round-trip an invalid UTF-8 changelog with altered bytes.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout)
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
): Pick<ReleaseHeading, 'tag' | 'version'> {
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
  return { tag: `${component}/v${label}`, version }
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

/** Pure: only the supplied source data and UTC date can affect the proposal. */
function propose(
  component: string,
  sha: string,
  base: Base,
  count: string,
  section: ReleaseSection,
  date: string,
  repo: string | undefined,
): Proposal | null {
  if (!section.body.trim()) return null
  const closingReference = issueClosing.exec(section.body)
  if (closingReference) {
    const before = section.prefix + section.body.slice(0, closingReference.index)
    const line = before.split(newline).length
    throw new Error(`rephrase CHANGELOG.md line ${line}: release notes must not close issues`)
  }
  const { actions } = section
  const [major, minor, patch] = base.version
  const nextVersion: Version =
    actions.length > 0 ? [major, minor + 1n, 0n] : [major, minor, patch + 1n]
  const tag = `${component}/v${nextVersion.join('.')}`
  const latest = section.headings[0]
  if (latest && compareVersions(nextVersion, latest.version) <= 0) {
    throw new Error(
      `proposed tag ${tag} must be newer than the latest CHANGELOG release ${latest.tag}`,
    )
  }
  const header = `## ${tag} — ${date}`
  const root = repo ? `https://github.com/${repo}/blob/${sha}/` : undefined
  const body = [
    `Proposed tag: \`${tag}\`  \nBase tag: \`${base.tag}\` (\`${base.sha}\`)  \nSource SHA: \`${sha}\`  \nCommits in range: ${count}`,
    '### Manual publication\n\n- [ ] Merge this pull request after review.\n- [ ] Wait for successful CI and Secret scan push runs on the merge commit.\n' +
      `- [ ] Create the annotated tag \`${tag}\` on that merge commit. Never move an existing tag.\n` +
      '- [ ] Publish the GitHub Release from the new CHANGELOG section, with Product actions first.',
    `### Product actions\n\n${renderNotes(actions.join(newline), root) || 'None.'}`,
    `${header}\n${renderNotes(section.body, root)}`,
  ].join('\n\n')
  return {
    branch: `release/${component}`,
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

function baseAt(sha: string, component: string): Base {
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
  if (!best) throw new Error(`no ${prefix}X.Y.Z tag is an ancestor of the source SHA`)
  return { ...best, sha: git(['rev-parse', `refs/tags/${best.tag}^{commit}`]).trim() }
}

function proposalAt(
  sha: string,
  section: ReleaseSection,
  component: string,
  repo: string | undefined,
): Proposal | 'unpublished' | null {
  const tags = new Set(
    git(['for-each-ref', '--format=%(refname:lstrip=2)', `refs/tags/${component}/v*`]).split('\n'),
  )
  const unpublished = section.headings.find(({ tag }) => !tags.has(tag))?.tag
  if (unpublished) {
    console.log(`::warning::${unpublished} already has a CHANGELOG section; publish its tag first.`)
    return 'unpublished'
  }
  const base = baseAt(sha, component)
  const count = git(['rev-list', '--count', `${base.sha}..${sha}`]).trim()
  const proposal = propose(
    component,
    sha,
    base,
    count,
    section,
    new Date().toISOString().slice(0, 10),
    repo,
  )
  if (proposal && tags.has(proposal.tag))
    throw new Error(`tag ${proposal.tag} already exists; will not prepare or move it`)
  return proposal
}

type Pull = {
  number: number
  head: { sha: string; ref: string; repo: { full_name: string } | null }
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
    options?: { pages?: boolean; method?: string; body?: Record<string, string> },
  ): T {
    const args = ['api', `repos/${this.repo}/${path}`]
    if (options?.pages) args.push('--paginate', '--slurp')
    if (options?.method) args.push('--method', options.method, '--input', '-')
    const write = options?.method !== undefined
    const token = write ? process.env.RELEASE_WRITE_TOKEN : process.env.GH_TOKEN
    if (!token) throw new Error(`missing ${write ? 'RELEASE_WRITE_TOKEN' : 'GH_TOKEN'}`)
    return JSON.parse(
      command('gh', args, write ? JSON.stringify(options.body) : undefined, { GH_TOKEN: token }),
    ) as T
  }

  tip(): string {
    return this.api<Ref>('git/ref/heads/main').object.sha
  }

  green(sha: string): boolean {
    const runs = this.api<{ workflow_runs: WorkflowRun[] }[]>(
      `actions/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
      { pages: true },
    )
      .flatMap((page) => page.workflow_runs)
      .filter(
        (item) => item.head_sha === sha && item.head_branch === 'main' && item.event === 'push',
      )
    return requiredWorkflows.every(
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

  pull(branch: string): Pull | undefined {
    const owner = this.repo.split('/')[0]
    const pulls = this.api<Pull[][]>(
      `pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      { pages: true },
    )
      .flat()
      .filter((pull) => pull.head.repo?.full_name === this.repo && pull.head.ref === branch)
    if (pulls.length > 1) throw new Error('multiple open proposals on the release branch')
    return pulls[0]
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
      const current = this.api<Pull>(`pulls/${pull.number}`)
      if (current.state !== 'open' || current.head.sha !== head)
        throw new Error('proposal changed; rerun release preparation')
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

function modeAt(sha: string): string {
  const mode = /^(100644|100755) blob /.exec(git(['ls-tree', sha, '--', changelog]))?.[1]
  if (!mode) throw new Error('CHANGELOG.md is not a regular file')
  return mode
}

function sameCommit(head: string, proposal: Proposal): boolean {
  if (
    git(['rev-list', '--parents', '-n', '1', head]).trim() !== `${head} ${proposal.sha}` ||
    git(['show', '-s', '--format=%s', head]).trimEnd() !== proposal.title ||
    git(['diff', '--no-textconv', '--no-ext-diff', '--name-only', proposal.sha, head]).trimEnd() !==
      changelog
  )
    return false
  return (
    modeAt(head) === modeAt(proposal.sha) &&
    git(['rev-parse', `${head}:${changelog}`]).trim() ===
      git(['hash-object', '--stdin'], proposal.text).trim()
  )
}

function createCommit(proposal: Proposal, bot: Bot): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-release-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const mode = modeAt(proposal.sha)
    const blob = git(['hash-object', '-w', '--stdin'], proposal.text).trim()
    git(['read-tree', proposal.sha], undefined, env)
    git(['update-index', '--cacheinfo', `${mode},${blob},${changelog}`], undefined, env)
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
  const pull = github.pull(branch)
  const head = github.head(branch)
  if (pull && pull.head.sha !== head)
    throw new Error('proposal branch changed; rerun release preparation')
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

function readArgs() {
  const [mode, flag, rev, ...extra] = process.argv.slice(2)
  const usage =
    'usage: release-prepare.ts (--check-changelog | (--dry-run|--plan|--apply) [--sha <commit>])'
  if (mode !== '--dry-run' && mode !== '--plan' && mode !== '--apply') throw new Error(usage)
  if (flag !== undefined && (flag !== '--sha' || !rev || extra.length)) throw new Error(usage)
  const sha = git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${rev ?? mainRef}^{commit}`,
  ]).trim()
  if (!shaPattern.test(sha)) throw new Error('invalid source SHA')
  return { mode, sha }
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

function dryRun(sha: string, section: ReleaseSection, component: string, repo?: string): void {
  const proposal = proposalAt(sha, section, component, repo)
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

function checkChangelog(): void {
  if (existsSync('config/product/inheritance.json')) return
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    readFileSync(changelog),
  )
  releaseSection(text, releaseComponent(readFileSync('.dev/stack.yml', 'utf8')))
  output('release-prepare: CHANGELOG grammar OK')
}

function isChangelogCheck(): boolean {
  if (process.argv[2] !== '--check-changelog') return false
  if (process.argv.length !== 3) throw new Error('usage: release-prepare.ts --check-changelog')
  return true
}

function main(): void {
  const { mode, sha } = readArgs()
  if (git(['ls-tree', sha, '--', 'config/product/inheritance.json']).trim()) {
    output('release-prepare: Product tree; skipped')
    return
  }
  const component = releaseComponent(git(['show', '--no-textconv', `${sha}:.dev/stack.yml`]))
  const section = releaseSection(git(['show', '--no-textconv', `${sha}:${changelog}`]), component)
  const repo = process.env.GITHUB_REPOSITORY
  if (repo !== undefined && !repoPattern.test(repo))
    throw new Error('set GITHUB_REPOSITORY to owner/repo')
  if (mode === '--dry-run') {
    dryRun(sha, section, component, repo ?? originGithubRepository())
    return
  }
  if (!repo) throw new Error('set GITHUB_REPOSITORY to owner/repo')
  const github = new GitHub(repo)
  const tip = github.tip()
  if (!shaPattern.test(tip)) throw new Error('invalid main SHA from GitHub')
  if (sha !== tip) {
    output('release-prepare: source is not the current first-parent tip of main; skipped')
    return
  }
  if (!github.green(sha)) {
    output('release-prepare: CI and Secret scan are not both green for this main push; skipped')
    return
  }
  const proposal = proposalAt(sha, section, component, repo)
  if (proposal === 'unpublished') return
  const action = proposal && reconcile(github, proposal, mode === '--apply')
  if (action && mode === '--plan' && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, 'write=true\n')
  output(
    action ? `release-prepare: ${action}` : 'release-prepare: unchanged or no unreleased changes',
  )
}

try {
  if (isChangelogCheck()) checkChangelog()
  else main()
} catch (error) {
  output(`release-prepare: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
