import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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

export const adapterName = 'createBetterAuth'
export const kitFactory = '@kit/auth/factory'

export type WorkerTarget = { config: string; env?: string; entry: string }

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
  return (
    !(isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) &&
    /\.[cm]?[jt]sx?$/.test(path) &&
    shippingSource(path)
  )
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

function workerEntrypoints(app: string, required = true): WorkerTarget[] {
  // Nested Wrangler configs include test Workers. Only App-root configs describe its deploys.
  const configs = wranglerConfigs(app).filter((file) => dirname(file) === app)
  if (required && !configs.length)
    throw new Error('add an App-root Wrangler config with a Worker main')
  const entries: WorkerTarget[] = []
  function addTarget(config: string, main: unknown, env?: string) {
    if (required || main !== undefined) {
      entries.push({ config, env, entry: workerMainFile(app, config, main) })
    }
  }
  for (const file of configs) {
    const text = readFileSync(file, 'utf8')
    const config = (file.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)) as {
      main?: unknown
      env?: Record<string, { main?: unknown }>
    }
    addTarget(file, config.main)
    for (const [env, options] of Object.entries(config.env ?? {})) {
      addTarget(file, options.main ?? config.main, env)
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

export function workerUsesServerFactory(
  app: string,
  workspaceRoots: readonly string[],
  importsFactory: (program: Program) => boolean,
) {
  const sources = new Set(workerEntrypoints(app, false).map(({ entry }) => entry))
  for (const file of sources) {
    const program = parseProgram(file)
    if (importsFactory(program)) return true
    function follow(specifier: string) {
      const imported = resolveImport(file, specifier)
      if (imported && workspaceRoots.some((root) => isLocalSource(root, imported))) {
        sources.add(imported)
      }
    }
    for (const node of program.body) {
      const specifier = staticRuntimeSource(node)
      if (specifier) follow(specifier)
    }
    new Visitor({
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          follow(node.source.value)
        }
      },
      CallExpression(node) {
        const arg = node.arguments[0]
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          arg?.type === 'Literal' &&
          typeof arg.value === 'string'
        ) {
          follow(arg.value)
        }
      },
    }).visit(program)
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
