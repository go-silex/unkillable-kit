/** Narrow eligibility reader for Dependabot's signed commit metadata. No PR text is authoritative. */
function inferredUpdate(message: string): string | undefined {
  const match = message.match(/^Bumps .* from v?(\d+)\.(\d+)\.(\d+) to v?(\d+)\.(\d+)\.(\d+)\.$/m)
  if (!match) return undefined
  const oldVersion = match.slice(1, 4).map(Number)
  const newVersion = match.slice(4, 7).map(Number)
  if (newVersion[0] > oldVersion[0]) return 'version-update:semver-major'
  if (newVersion[0] === oldVersion[0] && newVersion[1] > oldVersion[1])
    return 'version-update:semver-minor'
  if (
    newVersion[0] === oldVersion[0] &&
    newVersion[1] === oldVersion[1] &&
    newVersion[2] > oldVersion[2]
  )
    return 'version-update:semver-patch'
  return undefined
}

export const BETTER_AUTH_REVIEW_DETAIL =
  'Better Auth requires human review of session cookie signing and getSession before merging'

export function isBetterAuthPackage(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === 'better-auth' || normalized.startsWith('@better-auth/')
}

function entryEligibility(entry: unknown, message: string, single: boolean): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return 'malformed dependency entry'
  const item = entry as Record<string, unknown>
  const name = item['dependency-name']
  if (typeof name !== 'string' || !name.trim() || name !== name.trim())
    return 'unknown dependency name'
  if (name.toLowerCase() === 'wrangler') return 'wrangler requires independent review'
  if (isBetterAuthPackage(name)) return BETTER_AUTH_REVIEW_DETAIL
  let update = item['update-type']
  // Single-dependency commits sometimes omit update-type but contain exact versions in the bump sentence.
  if (update === undefined && single) update = inferredUpdate(message)
  if (update !== 'version-update:semver-patch' && update !== 'version-update:semver-minor')
    return 'unsupported or unknown update type'
  return undefined
}

function messageEligibility(message: string): string | undefined {
  const fragments = [...message.matchAll(/^---\r?\n([\s\S]*?)\r?\n\.\.\.(?:\r?\n|$)/gm)]
  if (fragments.length !== 1) return 'missing or ambiguous dependency metadata'
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(fragments[0][1])
  } catch {
    return 'malformed dependency metadata'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return 'malformed dependency metadata'
  const dependencies = (parsed as Record<string, unknown>)['updated-dependencies']
  if (!Array.isArray(dependencies) || dependencies.length === 0) return 'empty dependency metadata'
  for (const entry of dependencies) {
    const reason = entryEligibility(entry, message, dependencies.length === 1)
    if (reason) return reason
  }
  return undefined
}

export function dependencyEligibility(messages: readonly string[]): string | undefined {
  if (messages.length === 0) return 'no verified commit metadata'
  for (const message of messages) {
    const reason = messageEligibility(message)
    if (reason) return reason
  }
  return undefined
}
