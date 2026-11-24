import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLock } from './deps-guard/lock'

export const dependency = 'better-auth'

type Edges = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalPeers?: string[]
}

type Workspace = Edges & { name?: string }
type Lock = {
  workspaces: Record<string, Workspace>
  packages: Record<string, [string, string?, Edges?]>
}

export function readBetterAuthLock(root: string) {
  const text = readFileSync(join(root, 'bun.lock'), 'utf8')
  const parsed = parseLock(text)
  const lock = Bun.JSONC.parse(text) as Lock
  if (!lock.workspaces?.['']) throw new Error('bun.lock is missing its Root workspace')
  const betterAuth = new Map(
    parsed.filter((pkg) => pkg.name === dependency).map((pkg) => [pkg.key, pkg]),
  )
  const workspacePaths = new Map(Object.entries(lock.workspaces).map(([path, w]) => [w.name, path]))

  // Bun lock keys use package names separated by slashes, including scoped package names.
  function resolveKey(scope: string, name: string) {
    const chain = scope.match(/(?:@[^/]+\/)?[^/]+/g) ?? []
    while (chain.length) {
      const nested = `${chain.join('/')}/${name}`
      if (Object.hasOwn(lock.packages, nested)) return nested
      chain.pop()
    }
    if (Object.hasOwn(lock.packages, name)) return name
  }

  function resolveDependency(scope: string, name: string, edges: Edges, path: string) {
    const key = resolveKey(scope, name)
    if (
      !key &&
      name === dependency &&
      !edges.optionalPeers?.includes(name) &&
      !edges.optionalDependencies?.[name]
    ) {
      throw new Error(`${path}: unresolved ${name} in bun.lock (${scope || 'root'})`)
    }
    return key
  }

  function nestedEdges(key: string) {
    const entry = lock.packages[key]
    const workspacePath = workspacePaths.get(key)
    return workspacePath !== undefined && entry[0].endsWith(`@workspace:${workspacePath}`)
      ? lock.workspaces[workspacePath]
      : entry[2]
  }

  const contexts = new Map<string, Set<string>>()
  function recordResolution(path: string, name: string, key: string) {
    const pkg = betterAuth.get(key)
    if (!pkg) {
      if (name === dependency) throw new Error(`${path}: ${key} does not resolve ${dependency}`)
      return
    }
    if (pkg.nonRegistry) throw new Error(`${path}: ${key}: ${pkg.nonRegistry}`)
    const paths = contexts.get(pkg.version) ?? new Set<string>()
    paths.add(path)
    contexts.set(pkg.version, paths)
  }

  for (const [path, workspace] of Object.entries(lock.workspaces)) {
    const workspaceLabel = path || '<root>'
    const seen = new Set<string>()
    function visit(scope: string, edges: Edges, includeDev: boolean) {
      const all = {
        ...edges.peerDependencies,
        ...edges.optionalDependencies,
        ...edges.dependencies,
        ...(includeDev ? edges.devDependencies : {}),
      }
      for (const name of Object.keys(all)) {
        const key = resolveDependency(scope, name, edges, workspaceLabel)
        if (!key || seen.has(key)) continue
        seen.add(key)
        recordResolution(workspaceLabel, name, key)
        const nested = nestedEdges(key)
        if (nested) visit(key, nested, false)
      }
    }
    visit(workspace.name ?? '', workspace, true)
  }
  if (contexts.size > 1) {
    const report = [...contexts]
      .sort(([a], [b]) => Bun.semver.order(a, b))
      .map(([version, paths]) => `${version}: ${[...paths].sort().join(', ')}`)
      .join('\n')
    throw new Error(`multiple effective ${dependency} versions in bun.lock:\n${report}`)
  }
  return contexts.keys().next().value
}
