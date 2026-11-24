import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const serverSubpaths: Record<string, readonly string[]> = {
  'better-auth': ['.', './minimal'],
  '@kit/auth': ['./factory'],
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
  const subpaths = Object.hasOwn(serverSubpaths, name) ? serverSubpaths[name] : undefined
  if (!subpaths) return
  const fields = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {}
  const hasSubpaths = Object.keys(fields).some((key) => key.startsWith('.'))
  const files = new Set<string>()
  for (const subpath of subpaths) {
    const target = subpath === '.' && !hasSubpaths ? manifest.exports : fields[subpath]
    collectTargets(dir, target, files)
  }
  return files
}

export function indexServerEntrypoints() {
  const directories = new Map<string, Set<string> | undefined>()
  function packageEntries(dir: string): Set<string> | undefined {
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
    isServerEntry(path: string) {
      if (!existsSync(path)) return false
      const file = realpathSync(path)
      return packageEntries(dirname(file))?.has(file) ?? false
    },
  }
}
