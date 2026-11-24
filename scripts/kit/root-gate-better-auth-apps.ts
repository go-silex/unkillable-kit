import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { type Program, Visitor } from 'oxc-parser'
import { dependency } from './root-gate-better-auth-lock'
import {
  adapterName,
  importsServerFactory,
  kitFactory,
  parseProgram,
  shippingSource,
} from './root-gate-better-auth-source'
import {
  verifyWorkerWiring,
  type WorkerTarget,
  workerUsesServerFactory,
} from './root-gate-better-auth-worker'

type BetterAuthComposition = {
  workspace: string
  dir: string
  composition: string
  factoryCallee: { start: number; end: number; hash: string }
  targets: WorkerTarget[]
}
export type BetterAuthApp = BetterAuthComposition & {
  installation: { factoryPath: string; kitRoot: string; betterAuthRoot: string }
  workspaceRoots: readonly string[]
}
const runtimeSources = new Bun.Glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}')

function kitFactoryBindings(program: Program) {
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
  return kitNames
}

function findKitFactoryCallee(program: Program) {
  const kitNames = kitFactoryBindings(program)
  let factoryCalls = 0
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && kitNames.has(node.callee.name)) factoryCalls++
    },
  }).visit(program)
  if (factoryCalls !== 1) return
  for (const node of program.body) {
    if (
      node.type !== 'ExportNamedDeclaration' ||
      node.declaration?.type !== 'FunctionDeclaration' ||
      node.declaration.id?.name !== adapterName
    )
      continue
    const returnValue = node.declaration.body?.body.at(-1)
    if (
      returnValue?.type === 'ReturnStatement' &&
      returnValue.argument?.type === 'CallExpression' &&
      returnValue.argument.callee.type === 'Identifier' &&
      kitNames.has(returnValue.argument.callee.name)
    ) {
      const { start, end } = returnValue.argument.callee
      return { start, end }
    }
  }
}

function installedPackage(name: string, entry: string) {
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) continue
    const manifest: { name?: string; version?: string } = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest.name === name && manifest.version) {
      return { root: realpathSync(dir), version: manifest.version }
    }
  }
  throw new Error(`${entry}: could not read the resolved ${name} manifest`)
}

function discoverComposition(
  root: string,
  path: string,
  workspaceRoots: readonly string[],
): BetterAuthComposition | undefined {
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
    return importsServerFactory(program)
      ? [
          {
            file,
            callee: findKitFactoryCallee(program),
            hash: createHash('sha256').update(code).digest('hex'),
          },
        ]
      : []
  })
  if (
    !factories.length &&
    manifest.kitBetterAuth === undefined &&
    !workerUsesServerFactory(dir, workspaceRoots)
  ) {
    return
  }
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
    !factory.callee
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
    return {
      workspace,
      dir,
      composition,
      factoryCallee: { ...factory.callee, hash: factory.hash },
      targets: verifyWorkerWiring(dir, composition),
    }
  } catch (cause) {
    throw new Error(`${workspace}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function resolveInstallation(app: BetterAuthComposition, lockedVersion: string | undefined) {
  const installed = installedPackage(dependency, Bun.resolveSync(dependency, app.dir))
  const factoryPath = Bun.resolveSync(kitFactory, dirname(app.composition))
  const reference = installedPackage(dependency, Bun.resolveSync(dependency, dirname(factoryPath)))
  if (installed.version !== reference.version || installed.version !== lockedVersion) {
    throw new Error(
      `${app.workspace}: Better Auth versions differ (App ${installed.version}, reference ${reference.version}, lock ${lockedVersion ?? 'unresolved'})`,
    )
  }
  const kit = installedPackage('@kit/auth', factoryPath)
  return { factoryPath, kitRoot: kit.root, betterAuthRoot: reference.root }
}

export function discoverBetterAuthApps(root: string, lockedVersion: string | undefined) {
  const pkg: { workspaces?: string[] } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  )
  const manifests = new Set<string>()
  for (const pattern of pkg.workspaces ?? []) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      manifests.add(path)
    }
  }
  const workspaceRoots = [
    ...new Set([...manifests].map((path) => realpathSync(dirname(join(root, path))))),
  ]
  const apps = [...manifests].filter((path) => path.startsWith('apps/')).sort()
  return apps.flatMap((path) => {
    const app = discoverComposition(root, path, workspaceRoots)
    if (!app) return []
    return [{ ...app, workspaceRoots, installation: resolveInstallation(app, lockedVersion) }]
  })
}
