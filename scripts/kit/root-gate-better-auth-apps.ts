import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { type Program, Visitor } from 'oxc-parser'
import { dependency } from './root-gate-better-auth-lock'
import {
  adapterName,
  kitFactory,
  parseProgram,
  shippingSource,
  verifyWorkerWiring,
  type WorkerTarget,
} from './root-gate-better-auth-worker'

export type BetterAuthApp = {
  workspace: string
  dir: string
  composition: string
  targets: WorkerTarget[]
}
const serverFactoryExports = new Map([
  [kitFactory, adapterName],
  [dependency, 'betterAuth'],
  [`${dependency}/minimal`, 'betterAuth'],
])
const runtimeSources = new Bun.Glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}')

function importsServerFactory(program: Program) {
  let found = false
  function check(source: string, exported?: string) {
    const factory = serverFactoryExports.get(source)
    found ||= factory !== undefined && (exported === undefined || exported === factory)
  }
  new Visitor({
    ImportDeclaration(node) {
      if (node.importKind === 'type') return
      for (const item of node.specifiers) {
        if (item.type === 'ImportNamespaceSpecifier') check(node.source.value)
        else if (item.type === 'ImportSpecifier' && item.importKind !== 'type') {
          const name =
            item.imported.type === 'Identifier' ? item.imported.name : item.imported.value
          check(node.source.value, name)
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.exportKind === 'type' || !node.source) return
      for (const item of node.specifiers) {
        if (item.exportKind !== 'type') {
          const name = item.local.type === 'Identifier' ? item.local.name : item.local.value
          check(node.source.value, name)
        }
      }
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== 'type') check(node.source.value)
    },
    ImportExpression(node) {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string')
        check(node.source.value)
    },
    CallExpression(node) {
      const arg = node.arguments[0]
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        arg?.type === 'Literal' &&
        typeof arg.value === 'string'
      )
        check(arg.value)
    },
  }).visit(program)
  return found
}

function returnsKitInstance(program: Program) {
  const kitNames = new Set<string>()
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      statement.source.value !== kitFactory
    )
      continue
    for (const item of statement.specifiers) {
      if (
        item.type === 'ImportSpecifier' &&
        item.importKind !== 'type' &&
        item.imported.type === 'Identifier' &&
        item.imported.name === adapterName
      )
        kitNames.add(item.local.name)
    }
  }
  let factoryCalls = 0
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && kitNames.has(node.callee.name)) factoryCalls++
    },
  }).visit(program)
  if (factoryCalls !== 1) return false
  return program.body.some((node) => {
    if (
      node.type !== 'ExportNamedDeclaration' ||
      node.declaration?.type !== 'FunctionDeclaration' ||
      node.declaration.id?.name !== adapterName
    )
      return false
    const returnValue = node.declaration.body?.body.at(-1)
    return (
      returnValue?.type === 'ReturnStatement' &&
      returnValue.argument?.type === 'CallExpression' &&
      returnValue.argument.callee.type === 'Identifier' &&
      kitNames.has(returnValue.argument.callee.name)
    )
  })
}

function installedVersion(from: string) {
  const entry = Bun.resolveSync(dependency, from)
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) continue
    const manifest: { name?: string; version?: string } = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest.name === dependency && manifest.version) return manifest.version
  }
  throw new Error(`${from}: could not read the resolved ${dependency} version`)
}

function discoverComposition(root: string, path: string): BetterAuthApp | undefined {
  const workspace = dirname(path)
  const dir = join(root, workspace)
  const manifest: { dependencies?: Record<string, string>; kitBetterAuth?: unknown } = JSON.parse(
    readFileSync(join(root, path), 'utf8'),
  )
  const runtime = [...runtimeSources.scanSync({ cwd: dir })].filter(shippingSource).sort()
  const factories = runtime.flatMap((file) => {
    const fullPath = join(dir, file)
    const code = readFileSync(fullPath, 'utf8')
    if (!(code.includes(dependency) || code.includes(kitFactory))) return []
    const program = parseProgram(fullPath, code)
    return importsServerFactory(program) ? [{ file, program }] : []
  })
  if (!factories.length && manifest.kitBetterAuth === undefined) return
  if (!manifest.dependencies?.[dependency]) {
    throw new Error(
      `${workspace}: shipping Better Auth composition must declare ${dependency} directly in dependencies`,
    )
  }
  const factory = factories[0]
  if (
    factories.length !== 1 ||
    !factory ||
    manifest.kitBetterAuth !== factory.file ||
    !returnsKitInstance(factory.program)
  ) {
    throw new Error(
      `${workspace}: kitBetterAuth must name the sole shipping createBetterAuth export that returns the Kit factory instance (runtime modules: ${factories.map(({ file }) => file).join(', ') || 'none'})`,
    )
  }
  const composition = realpathSync(join(dir, factory.file))
  const normalized = relative(dir, composition)
  if (isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`${workspace}: shipping Better Auth composition must be App-local`)
  }
  try {
    return { workspace, dir, composition, targets: verifyWorkerWiring(dir, composition) }
  } catch (cause) {
    throw new Error(`${workspace}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function verifyInstalledVersions(app: BetterAuthApp, lockedVersion: string | undefined) {
  const appVersion = installedVersion(app.dir)
  const kitEntry = Bun.resolveSync(kitFactory, dirname(app.composition))
  const referenceVersion = installedVersion(dirname(kitEntry))
  if (appVersion !== referenceVersion || appVersion !== lockedVersion) {
    throw new Error(
      `${app.workspace}: Better Auth versions differ (App ${appVersion}, reference ${referenceVersion}, lock ${lockedVersion ?? 'unresolved'})`,
    )
  }
}

export function discoverBetterAuthApps(root: string, lockedVersion: string | undefined) {
  const pkg: { workspaces?: string[] } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  )
  const manifests = new Set<string>()
  for (const pattern of pkg.workspaces ?? []) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      if (path.startsWith('apps/')) manifests.add(path)
    }
  }
  return [...manifests].sort().flatMap((path) => {
    const app = discoverComposition(root, path)
    if (!app) return []
    verifyInstalledVersions(app, lockedVersion)
    return [app]
  })
}
