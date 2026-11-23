/**
 * npm half of the guard: judge every package whose resolved version changed or appeared between
 * two bun.lock texts. Pure given a `Registry` — no I/O here.
 *
 * WITHHOLD reasons (any one is enough):
 *   TOO_YOUNG                   published less than the cooldown ago (also covers security updates,
 *                               which Dependabot's cooldown never delays)
 *   PROVENANCE_DOWNGRADE        previous version carried npm provenance, this one does not
 *   PUBLISHER_CHANGE            `_npmUser` (or the trusted-publisher OIDC config) differs from the previous version,
 *                               unless the new version has npm provenance naming the same source repository as
 *                               the previous one (its attestation, else its packument `repository` field)
 *   NEW_INSTALL_SCRIPT          preinstall/install/postinstall absent or different in the previous version
 *   NEW_PACKAGE_INSTALL_SCRIPT  a package new to the lock ships an install script
 *   NON_REGISTRY                resolved from git / tarball / file / a non-default registry
 *   INTEGRITY_CHANGED           same name@version, different integrity hash (tarball swapped under a lock)
 *   ADVISORY                    the registry's advisory database matches the new version and not the one it replaces
 *   REGENERATE_TYPES            `wrangler` changed: agents must regenerate the committed worker-configuration.d.ts
 *   BETTER_AUTH_REVIEW          a Better Auth lock resolution was added or changed
 *   METADATA_UNAVAILABLE        the registry has no record of the version or its publish time (fail closed)
 */
import { diffLocks, type LockChange, parseLock } from './lock.ts'
import { BETTER_AUTH_REVIEW_DETAIL, isBetterAuthPackage } from './metadata.ts'
import type { LockPackage, Reason, Registry, Verdict, VersionMeta } from './types.ts'

export type NpmContext = { registry: Registry; cooldownSeconds: number; now: Date }

const DAY_S = 86_400

function compareReasons(a: Reason, b: Reason): number {
  return a.subject.localeCompare(b.subject) || a.code.localeCompare(b.code)
}

type Judged = { reasons: Reason[]; notes: string[] }

/** The publisher moved (account name or trusted-publisher config). Accepted only when the new version
 *  carries npm provenance naming the SAME source repository as the version it replaces; every other
 *  case is a WITHHOLD whose text says which one applied. */
async function judgePublisherChange(
  id: string,
  prev: VersionMeta,
  next: VersionMeta,
  previousId: string,
  ctx: NpmContext,
): Promise<Judged> {
  const nameChanged = prev.publisher !== undefined && next.publisher !== prev.publisher
  const what = nameChanged
    ? `published by "${next.publisher ?? 'unknown'}", ${previousId} by "${prev.publisher}"`
    : `trusted-publisher config changed (${prev.oidcConfig} -> ${next.oidcConfig})`
  const withhold = (why: string): Judged => ({
    reasons: [{ code: 'PUBLISHER_CHANGE', subject: id, detail: `${what}; ${why}` }],
    notes: [],
  })
  if (!next.attested) {
    return withhold(
      `${id} has no npm provenance, so the new publisher is not tied to a source repository`,
    )
  }
  const [nextProv, prevProv] = await Promise.all([
    ctx.registry.provenance(...splitId(id)),
    prev.attested ? ctx.registry.provenance(...splitId(previousId)) : undefined,
  ])
  if (nextProv.repo === undefined) return withhold(`${id} provenance unreadable: ${nextProv.why}`)
  const prevRepo = prev.attested ? prevProv?.repo : prev.repository
  const prevFrom = prev.attested ? 'its attestation' : 'its packument repository field'
  if (prevRepo === undefined) {
    const why = prev.attested ? prevProv?.why : 'no repository field'
    return withhold(`the source repository of ${previousId} cannot be resolved (${why})`)
  }
  if (prevRepo !== nextProv.repo) {
    return withhold(
      `provenance attests source ${nextProv.repo}, but ${previousId} came from ${prevRepo} (${prevFrom})`,
    )
  }
  return {
    reasons: [],
    notes: [
      `PUBLISHER_CHANGE accepted for ${id}: ${what}; provenance attests ${nextProv.repo}, the same source repository as ${previousId} (${prevFrom})`,
    ],
  }
}

/** `name@version` -> [name, version] (scoped names keep their leading `@`). */
function splitId(id: string): [string, string] {
  const at = id.lastIndexOf('@')
  return [id.slice(0, at), id.slice(at + 1)]
}

async function judgeAgainstPrevious(
  id: string,
  prev: VersionMeta,
  next: VersionMeta,
  previousId: string,
  ctx: NpmContext,
): Promise<Judged> {
  const reasons: Reason[] = []
  const notes: string[] = []
  if (prev.attested && !next.attested) {
    reasons.push({
      code: 'PROVENANCE_DOWNGRADE',
      subject: id,
      detail: `${previousId} was published with npm provenance, ${id} has none`,
    })
  }
  const nameChanged = prev.publisher !== undefined && next.publisher !== prev.publisher
  const oidcChanged =
    prev.oidcConfig !== undefined &&
    next.oidcConfig !== undefined &&
    prev.oidcConfig !== next.oidcConfig
  if (nameChanged || oidcChanged) {
    const j = await judgePublisherChange(id, prev, next, previousId, ctx)
    reasons.push(...j.reasons)
    notes.push(...j.notes)
  }
  for (const [script, cmd] of Object.entries(next.installScripts)) {
    if (prev.installScripts[script] !== cmd) {
      const was = prev.installScripts[script]
      reasons.push({
        code: 'NEW_INSTALL_SCRIPT',
        subject: id,
        detail: `${script}: \`${cmd}\` ${was === undefined ? `(absent in ${previousId})` : `(was \`${was}\`)`}`,
      })
    }
  }
  return { reasons, notes }
}

async function judgeChange(
  head: LockPackage,
  previous: LockPackage | undefined,
  ctx: NpmContext,
): Promise<Judged> {
  const id = `${head.name}@${head.version}`
  if (head.nonRegistry) {
    return { reasons: [{ code: 'NON_REGISTRY', subject: id, detail: head.nonRegistry }], notes: [] }
  }

  const next = await ctx.registry.version(head.name, head.version)
  if (!next) {
    return {
      reasons: [
        {
          code: 'METADATA_UNAVAILABLE',
          subject: id,
          detail: 'the npm registry has no such version',
        },
      ],
      notes: [],
    }
  }
  const reasons: Reason[] = []
  if (next.published === undefined) {
    reasons.push({
      code: 'METADATA_UNAVAILABLE',
      subject: id,
      detail: 'the registry gives no publish time',
    })
  } else {
    const ageS = (ctx.now.getTime() - Date.parse(next.published)) / 1000
    if (!(ageS >= ctx.cooldownSeconds)) {
      reasons.push({
        code: 'TOO_YOUNG',
        subject: id,
        detail: `published ${next.published} (${(ageS / DAY_S).toFixed(1)} d ago), cooldown is ${(ctx.cooldownSeconds / DAY_S).toFixed(1)} d`,
      })
    }
  }

  if (!previous) {
    for (const [script, cmd] of Object.entries(next.installScripts)) {
      reasons.push({
        code: 'NEW_PACKAGE_INSTALL_SCRIPT',
        subject: id,
        detail: `new to the lock and ships ${script}: \`${cmd}\``,
      })
    }
    return { reasons, notes: [] }
  }
  const previousId = `${previous.name}@${previous.version}`
  const prev = await ctx.registry.version(previous.name, previous.version)
  if (!prev) {
    reasons.push({
      code: 'METADATA_UNAVAILABLE',
      subject: id,
      detail: `no registry record of the previous version ${previousId}: cannot compare`,
    })
    return { reasons, notes: [] }
  }
  const j = await judgeAgainstPrevious(id, prev, next, previousId, ctx)
  return { reasons: [...reasons, ...j.reasons], notes: j.notes }
}

const WRANGLER_DETAIL =
  'wrangler: runtime types must be regenerated (`bun run types` in apps/example-api and apps/mcp-example); an operator-approved remediation PR then follows current-head proof, fresh independent review, CI and normal landing. This auto-merge guard remains WITHHOLD, and only a PASS restores automatic label eligibility'

/** An advisory counts only when the bump makes things worse: it matches the new version and did not
 *  already match the version it replaces (a partial fix that stays inside an old range is no regression). */
async function advisoryReasons(changes: LockChange[], ctx: NpmContext): Promise<Reason[]> {
  const queried = new Map<string, string[]>()
  for (const { head, previous } of changes) {
    if (head.nonRegistry) continue
    const versions = [head.version, ...(previous ? [previous.version] : [])]
    queried.set(head.name, [...(queried.get(head.name) ?? []), ...versions])
  }
  const advisories = await ctx.registry.advisories(queried)
  const reasons: Reason[] = []
  for (const { head, previous } of changes) {
    for (const a of advisories.get(head.name) ?? []) {
      const hitsHead = Bun.semver.satisfies(head.version, a.range)
      const hitsPrevious = previous !== undefined && Bun.semver.satisfies(previous.version, a.range)
      if (hitsHead && !hitsPrevious) {
        reasons.push({
          code: 'ADVISORY',
          subject: `${head.name}@${head.version}`,
          detail: `${a.severity} ${a.id} "${a.title}" affects ${a.range} — ${a.url}`,
        })
      }
    }
  }
  return reasons
}

function betterAuthReasons(base: readonly LockPackage[], head: readonly LockPackage[]): Reason[] {
  const baseByKey = new Map<string, LockPackage>()
  for (const pkg of base) if (isBetterAuthPackage(pkg.name)) baseByKey.set(pkg.key, pkg)
  const reasons: Reason[] = []
  for (const pkg of head) {
    if (!isBetterAuthPackage(pkg.name)) continue
    // A different resolution at this key can change the runtime even if the new version was
    // already locked elsewhere and therefore does not appear among the registry checks.
    const previous = baseByKey.get(pkg.key)
    if (previous?.name === pkg.name && previous.version === pkg.version) continue
    reasons.push({
      code: 'BETTER_AUTH_REVIEW',
      subject: `${pkg.name}@${pkg.version}`,
      detail: BETTER_AUTH_REVIEW_DETAIL,
    })
  }
  return reasons
}

export async function evaluateLockChange(
  baseText: string,
  headText: string,
  ctx: NpmContext,
): Promise<Verdict> {
  const base = parseLock(baseText)
  const head = parseLock(headText)
  const { changes, integrityChanged } = diffLocks(base, head)
  const reasons: Reason[] = integrityChanged.map(({ head, base }) => ({
    code: 'INTEGRITY_CHANGED',
    subject: `${head.name}@${head.version}`,
    detail: `integrity ${base.integrity ?? 'none'} -> ${head.integrity ?? 'none'} for an unchanged version`,
  }))
  reasons.push(...betterAuthReasons(base, head))
  for (const { head } of changes.filter((c) => c.head.name === 'wrangler')) {
    reasons.push({
      code: 'REGENERATE_TYPES',
      subject: `${head.name}@${head.version}`,
      detail: WRANGLER_DETAIL,
    })
  }
  const perChange = await Promise.all(changes.map((c) => judgeChange(c.head, c.previous, ctx)))
  for (const j of perChange) reasons.push(...j.reasons)
  reasons.push(...(await advisoryReasons(changes, ctx)))

  reasons.sort(compareReasons)
  const added = changes.filter((c) => !c.previous).length
  return {
    verdict: reasons.length === 0 ? 'PASS' : 'WITHHOLD',
    reasons,
    checked: [
      `bun.lock: ${changes.length} changed/added package(s) (${added} new to the lock)`,
      ...perChange.flatMap((j) => j.notes).sort(),
    ],
  }
}
