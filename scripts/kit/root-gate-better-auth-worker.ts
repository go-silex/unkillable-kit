import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type BindingPattern,
  type BindingRestElement,
  type ImportDeclaration,
  type ParamPattern,
  type Program,
  parseSync,
  Visitor,
} from 'oxc-parser'
import { wranglerConfigs } from './lib/wrangler-d1'
import {
  type BundleInputs,
  bundleInputContributions,
  bundleWorker,
} from './root-gate-better-auth-build.ts'
import { indexServerEntrypoints } from './root-gate-better-auth-entries'

export const adapterName = 'createBetterAuth'
export const kitFactory = '@kit/auth/factory'

export type WorkerTarget = { config: string; env?: string; entry: string; noBundle?: boolean }
type WorkerConfig = { main?: unknown; no_bundle?: boolean; build?: { command?: string } }
type DetectFactoryImports = (
  program: Program,
  resolveFactory?: (source: string) => string | undefined,
) => boolean
const runtimeExtension = /\.[cm]?[jt]sx?$/
const generatedDirectory = /(^|\/)(?:dist|build)\//
const installedDirectory = /(^|\/)node_modules\//

function isWithin(path: string) {
  return !(isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
}

export function shippingSource(path: string) {
  return !(
    /(^|\/)(?:node_modules|dist|build|coverage|test|tests|__tests__|__fixtures__|\.wrangler)\//.test(
      path,
    ) || /\.(?:d|test|spec)\.[^.]+$/.test(path)
  )
}

export function parseProgram(path: string, code = readFileSync(path, 'utf8')) {
  const parsed = parseSync(path, code)
  if (parsed.errors.length) throw new Error(`${path}: ${parsed.errors[0]?.message}`)
  return parsed.program
}

function isLocalSource(app: string, file: string) {
  const path = relative(app, file)
  return isWithin(path) && runtimeExtension.test(path) && shippingSource(path)
}

function workerMainFile(app: string, file: string, main: unknown) {
  if (typeof main !== 'string' || !main.trim() || isAbsolute(main)) {
    throw new Error(`${relative(app, file)} must declare a relative Worker main`)
  }
  const path = resolve(app, main)
  if (isLocalSource(app, path)) {
    const resolved = realpathSync(path)
    if (isLocalSource(app, resolved)) return resolved
  }
  throw new Error(`${relative(app, file)} main must be an App-local runtime source, got ${main}`)
}

function assertInspectableWorker(app: string, entry: string, label: string, command?: string) {
  if (!command && existsSync(entry) && isLocalSource(app, realpathSync(entry))) return
  throw new Error(
    `Cannot inventory opaque Worker inputs for ${label}; use an App-local source main outside dist/build without build.command so Better Auth enrollment can be checked`,
  )
}

function workerEntrypoints(app: string, required = true): WorkerTarget[] {
  // Nested Wrangler configs include test Workers. Only App-root configs describe its deploys.
  const configs = wranglerConfigs(app).filter((file) => dirname(file) === app)
  if (required && !configs.length)
    throw new Error('add an App-root Wrangler config with a Worker main')
  const entries: WorkerTarget[] = []
  function addTarget(config: string, { main, no_bundle, build }: WorkerConfig, env?: string) {
    if (!required && main === undefined) return
    const source = resolve(app, String(main))
    if (!required || no_bundle) {
      assertInspectableWorker(app, source, `${config}${env ? ` --env ${env}` : ''}`, build?.command)
    }
    const entry = required ? workerMainFile(app, config, main) : source
    entries.push({ config, env, entry, noBundle: no_bundle })
  }
  for (const file of configs) {
    const text = readFileSync(file, 'utf8')
    const config = (
      file.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)
    ) as WorkerConfig & { env?: Record<string, WorkerConfig> }
    addTarget(file, config)
    for (const [env, options] of Object.entries(config.env ?? {})) {
      addTarget(
        file,
        {
          main: options.main ?? config.main,
          no_bundle: options.no_bundle ?? config.no_bundle,
          build: options.build ?? config.build,
        },
        env,
      )
    }
  }
  return entries
}

function resolveImport(file: string, specifier: string) {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(file)))
  } catch {
    // Worker-native and uninstalled imports have no source in this graph.
  }
}

function localImport(app: string, file: string, specifier: string) {
  const path = resolveImport(file, specifier)
  if (path && isLocalSource(app, path)) return path
}

type Statement = Program['body'][number]
function staticRuntimeSource(node: Statement) {
  if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
    const runtime = node.specifiers.some(
      (item) => item.type !== 'ImportSpecifier' || item.importKind !== 'type',
    )
    if (!node.specifiers.length || runtime) return node.source.value
  }
  if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
    return node.source.value
  }
  if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type' && node.source) {
    const runtime = node.specifiers.some((item) => item.exportKind !== 'type')
    if (!node.specifiers.length || runtime) return node.source.value
  }
}

function unbundledUsesServerFactory(
  build: string,
  entry: string,
  importsFactory: (program: Program) => boolean,
) {
  if (!existsSync(join(build, basename(entry)))) {
    throw new Error(`Wrangler did not emit the unbundled Worker entrypoint ${entry}`)
  }
  return readdirSync(build, { recursive: true, withFileTypes: true }).some((file) => {
    if (!(file.isFile() && runtimeExtension.test(file.name))) return false
    const path = join(file.parentPath, file.name)
    const module = relative(build, path)
    if (generatedDirectory.test(module)) {
      throw new Error(
        `Cannot inventory opaque Worker inputs for ${entry}: use transparent modules outside dist/build instead of ${module}`,
      )
    }
    return importsFactory(parseProgram(path))
  })
}

function inspectableBundleInput(
  file: string,
  workspaceRoots: readonly string[],
  contribution: boolean | undefined,
) {
  if (contribution === undefined || !runtimeExtension.test(file)) return false
  const workspace = workspaceRoots.find((root) => isWithin(relative(root, file)))
  const path = workspace && relative(workspace, file)
  if (!path || installedDirectory.test(path)) return true
  if (generatedDirectory.test(path) && contribution) {
    throw new Error(
      `Cannot inventory opaque Worker inputs: ${file} is a deployed workspace output; use inspectable source outside dist/build`,
    )
  }
  return shippingSource(path)
}

export function workerUsesServerFactory(
  app: string,
  workspaceRoots: readonly string[],
  importsFactory: DetectFactoryImports,
) {
  const targets = workerEntrypoints(app, false)
  if (!targets.length) return false
  const node = Bun.which('node')
  if (!node) throw new Error('Node is required to inspect Wrangler’s release input graph')
  const wrangler = Bun.resolveSync('wrangler', app)
  const entries = indexServerEntrypoints()
  function resolvedFactories(
    imports: BundleInputs[string]['imports'],
    contributions: ReadonlyMap<string, boolean>,
  ) {
    const factories = new Map<string, string>()
    for (const edge of imports) {
      if (edge.external || !contributions.has(edge.path)) continue
      const factory = entries.factoryExport(resolve(app, edge.path))
      if (factory) factories.set(edge.original ?? edge.path, factory)
    }
    return factories
  }
  function isServerInput(
    [input, { imports }]: [string, BundleInputs[string]],
    contributions: ReadonlyMap<string, boolean>,
  ) {
    const path = resolve(app, input)
    if (!existsSync(path)) return false // Wrangler also reports virtual inputs.
    const file = realpathSync(path)
    if (
      !inspectableBundleInput(file, workspaceRoots, contributions.get(input)) ||
      entries.isSDKFile(file)
    ) {
      return false
    }
    // Resolve edges per target: the same source can map to another package in release.
    const factories = resolvedFactories(imports, contributions)
    return (
      factories.size > 0 && importsFactory(parseProgram(file), (source) => factories.get(source))
    )
  }
  for (const target of targets) {
    const scratch = mkdtempSync(resolve(tmpdir(), 'root-better-auth-inputs-'))
    try {
      const { build, inputs, outputs } = bundleWorker(node, wrangler, app, target, scratch)
      if (!inputs) {
        if (unbundledUsesServerFactory(build, target.entry, importsFactory)) return true
        continue
      }
      const contributions = bundleInputContributions(outputs)
      if (Object.entries(inputs).some((input) => isServerInput(input, contributions))) return true
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return false
}

function addFactoryBindings(node: ImportDeclaration, factories: Set<string>) {
  for (const item of node.specifiers) {
    if (
      item.type === 'ImportSpecifier' &&
      item.importKind !== 'type' &&
      item.imported.type === 'Identifier' &&
      item.imported.name === adapterName
    ) {
      factories.add(item.local.name)
    }
  }
}

function inspectModule(app: string, file: string, composition: string) {
  const program = parseProgram(file)
  const sources: string[] = []
  const factories = new Set<string>()
  for (const node of program.body) {
    const specifier = staticRuntimeSource(node)
    if (!specifier) continue
    const source = localImport(app, file, specifier)
    if (!source) continue
    sources.push(source)
    if (source === composition && node.type === 'ImportDeclaration') {
      addFactoryBindings(node, factories)
    }
  }
  return { sources, callsAdapter: unshadowedFactoryCall(program, factories) }
}

function unshadowedFactoryCall(program: Program, factories: Set<string>) {
  if (!factories.size) return false
  const calls = new Set<string>()
  // Reject an ambiguous local name even if the alternate binding is in a different lexical block.
  // The adapter import can be aliased to an unshadowed name instead of guessing at its binding.
  function exclude(pattern: BindingPattern | BindingRestElement | ParamPattern | null) {
    if (!pattern) return
    switch (pattern.type) {
      case 'Identifier':
        factories.delete(pattern.name)
        break
      case 'ObjectPattern':
        for (const item of pattern.properties)
          exclude(item.type === 'RestElement' ? item : item.value)
        break
      case 'ArrayPattern':
        for (const item of pattern.elements) exclude(item)
        break
      case 'AssignmentPattern':
        exclude(pattern.left)
        break
      case 'RestElement':
        exclude(pattern.argument)
        break
      case 'TSParameterProperty':
        exclude(pattern.parameter)
        break
    }
  }
  function excludeFunction(node: { id: BindingPattern | null; params: ParamPattern[] }) {
    exclude(node.id)
    for (const item of node.params) exclude(item)
  }
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === 'Identifier') calls.add(node.callee.name)
    },
    VariableDeclarator: (node) => exclude(node.id),
    FunctionDeclaration: excludeFunction,
    FunctionExpression: excludeFunction,
    ArrowFunctionExpression(node) {
      for (const item of node.params) exclude(item)
    },
    CatchClause: (node) => exclude(node.param),
    ClassDeclaration: (node) => exclude(node.id),
    ClassExpression: (node) => exclude(node.id),
  }).visit(program)
  return [...factories].some((name) => calls.has(name))
}

function reachesAdapter(
  app: string,
  entry: string,
  composition: string,
  parsed: Map<string, { sources: string[]; callsAdapter: boolean }>,
) {
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    let module = parsed.get(file)
    if (!module) {
      module = inspectModule(app, file, composition)
      parsed.set(file, module)
    }
    if (module.callsAdapter) return true
    pending.push(...module.sources)
  }
  return false
}

export function verifyWorkerWiring(app: string, composition: string) {
  const parsed = new Map<string, { sources: string[]; callsAdapter: boolean }>()
  const targets = workerEntrypoints(app)
  for (const { entry } of targets) {
    if (!reachesAdapter(app, entry, composition, parsed)) {
      throw new Error(
        `Wrangler main ${relative(app, entry)} does not reach a runtime call to createBetterAuth imported directly from ${relative(app, composition)}`,
      )
    }
  }
  return targets
}
