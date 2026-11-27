import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

type ServerPackage = { readonly factory: string; readonly subpaths: readonly string[] }
const serverPackages: Record<string, ServerPackage> = {
  'better-auth': { factory: 'betterAuth', subpaths: ['.', './minimal'] },
  '@kit/auth': { factory: 'createBetterAuth', subpaths: ['./factory'] },
}

/** Whether a bare specifier names a Better Auth entry that exports the server initializer. */
export function isBetterAuthServerSpecifier(specifier: string) {
  return serverPackages['better-auth'].subpaths.some(
    (subpath) => specifier === (subpath === '.' ? 'better-auth' : `better-auth${subpath.slice(1)}`),
  )
}

function collectTargets(dir: string, target: unknown, files: Set<string>) {
  if (typeof target === 'string' && target.startsWith('./')) {
    const path = resolve(dir, target)
    if (existsSync(path)) files.add(realpathSync(path))
  } else if (target && typeof target === 'object') {
    for (const [condition, fallback] of Object.entries(target)) {
      if (!/^types(?:@|$)/.test(condition)) collectTargets(dir, fallback, files)
    }
  }
}

function readServerPackage(dir: string, manifestPath: string) {
  const manifest: { name?: string; exports?: Record<string, unknown> | string } = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  )
  const name = manifest.name ?? ''
  const server = Object.hasOwn(serverPackages, name) ? serverPackages[name] : undefined
  if (!server) return
  const fields = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {}
  const hasSubpaths = Object.keys(fields).some((key) => key.startsWith('.'))
  const files = new Set<string>()
  for (const subpath of server.subpaths) {
    const target = subpath === '.' && !hasSubpaths ? manifest.exports : fields[subpath]
    collectTargets(dir, target, files)
  }
  return { files, factory: server.factory }
}

export function indexServerEntrypoints() {
  type PackageEntries = ReturnType<typeof readServerPackage>
  const directories = new Map<string, PackageEntries>()
  function packageEntries(dir: string): PackageEntries {
    if (directories.has(dir)) return directories.get(dir)
    const manifest = join(dir, 'package.json')
    const parent = dirname(dir)
    const entries = existsSync(manifest)
      ? readServerPackage(dir, manifest)
      : parent === dir
        ? undefined
        : packageEntries(parent)
    directories.set(dir, entries)
    return entries
  }
  return {
    isSDKFile: (realFile: string) => packageEntries(dirname(realFile)) !== undefined,
    factoryExport(path: string) {
      if (!existsSync(path)) return
      const file = realpathSync(path)
      const sdk = packageEntries(dirname(file))
      if (sdk?.files.has(file)) return sdk.factory
    },
  }
}
