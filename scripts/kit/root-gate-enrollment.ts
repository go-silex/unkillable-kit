import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function kitAppPrefixes(root: string): Set<string> {
  const path = 'config/kit/zero-edit-zones.json'
  const zones = JSON.parse(readFileSync(join(root, path), 'utf8')) as {
    protected_prefixes?: unknown
  }
  if (!Array.isArray(zones?.protected_prefixes))
    throw new Error(`${path} must define protected_prefixes`)

  const apps = new Set<string>()
  for (const prefix of zones.protected_prefixes) {
    if (typeof prefix !== 'string')
      throw new Error(`${path} contains a non-string protected prefix`)
    if (/^apps\/[^/]+\/$/.test(prefix)) apps.add(prefix)
  }
  return apps
}

function requireAppScripts(manifest: string, workspace: string) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  for (const script of ['typecheck', 'test:coverage']) {
    const command = pkg?.scripts?.[script]
    if (typeof command !== 'string' || command.trim() === '')
      throw new Error(`${workspace} must declare a non-empty ${script} script`)
  }
}

export function productAppWorkspaces(root: string): string[] {
  const kitApps = kitAppPrefixes(root)
  const appsDir = join(root, 'apps')
  if (!existsSync(appsDir)) return []

  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: unknown
  }
  // Coverage discovery accepts `<base>/*`; only `apps/*` yields canonical direct App paths.
  const discoversApps =
    Array.isArray(rootManifest?.workspaces) && rootManifest.workspaces.includes('apps/*')
  const workspaces: string[] = []
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const workspace = `apps/${entry.name}`
    if (kitApps.has(`${workspace}/`)) continue
    const manifest = join(root, workspace, 'package.json')
    if (!existsSync(manifest)) continue
    if (!discoversApps)
      throw new Error(
        `${workspace} is outside root workspace discovery (missing apps/* in package.json workspaces)`,
      )

    requireAppScripts(manifest, workspace)
    workspaces.push(workspace)
  }
  return workspaces.sort()
}
