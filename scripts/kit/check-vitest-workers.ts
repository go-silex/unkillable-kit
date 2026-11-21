import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type Node, type ObjectPropertyKind, type Program, parseSync } from 'oxc-parser'
import zones from '../../config/kit/zero-edit-zones.json'

const root = resolve(import.meta.dirname, '../..')
const { workspaces }: { workspaces: string[] } = await Bun.file(join(root, 'package.json')).json()
const shared = join(root, 'packages/config/vitest-workers.mts')
const configs = new Bun.Glob('vitest.config.{ts,mts,cts,js,mjs,cjs}')
const fallbackConfigs = new Bun.Glob('vite.config.{ts,mts,cts,js,mjs,cjs}')

function mayWrite(property: ObjectPropertyKind, name: string): boolean {
  if (property.type === 'SpreadElement') return true
  const { key, computed } = property
  if (key.type === 'Literal') return key.value === name
  return computed || (key.type === 'Identifier' && key.name === name)
}

// Work backwards: a later spread or dynamic key may override the named option.
function option(node: Node | undefined, name: string): Node | undefined {
  if (node?.type !== 'ObjectExpression') return
  for (let i = node.properties.length - 1; i >= 0; i--) {
    const property = node.properties[i]
    if (!(property && mayWrite(property, name))) continue
    if (property.type !== 'Property' || property.kind !== 'init') return
    if (property.computed && property.key.type !== 'Literal') return
    return property.value
  }
}

function importsName(program: Program, name: string, from: (path: string) => boolean): boolean {
  return program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.importKind !== 'type' &&
      from(node.source.value) &&
      node.specifiers.some(
        (item) =>
          item.type === 'ImportSpecifier' &&
          item.importKind !== 'type' &&
          item.imported.type === 'Identifier' &&
          item.imported.name === name &&
          item.local.name === name,
      ),
  )
}

function configObject(program: Program): Node | undefined {
  const exported = program.body.find(
    (node) => node.type === 'ExportDefaultDeclaration',
  )?.declaration
  if (exported?.type !== 'CallExpression') return exported
  if (exported.callee.type !== 'Identifier' || exported.callee.name !== 'defineConfig') return
  if (importsName(program, 'defineConfig', (from) => from === 'vitest/config' || from === 'vite')) {
    return exported.arguments[0]
  }
}

function report(workspace: string, detail: string, config?: string): void {
  const path = config ? join(workspace, config) : workspace
  const ownedByKit = zones.protected_prefixes.some((prefix) => `${workspace}/`.startsWith(prefix))
  console.error(`vitest-workers: ${ownedByKit ? 'error' : 'warning'}: ${path}: ${detail}`)
  if (ownedByKit) process.exitCode = 1
}

// Check the canonical config shape without executing Kit or Product code.
function inspect(path: string): { shared: boolean; fileParallelismDisabled: boolean } {
  const { program, errors } = parseSync(path, readFileSync(path, 'utf8'))
  if (errors.length) throw new Error(errors[0]?.message)
  const test = option(configObject(program), 'test')
  const workers = option(test, 'maxWorkers')
  const parallelism = option(test, 'fileParallelism')
  const sharedOk =
    workers?.type === 'Identifier' &&
    workers.name === 'ciMaxWorkers' &&
    importsName(
      program,
      'ciMaxWorkers',
      (from) => from.startsWith('.') && resolve(dirname(path), from) === shared,
    )
  return {
    shared: sharedOk,
    fileParallelismDisabled: parallelism?.type === 'Literal' && parallelism.value === false,
  }
}

function check(workspace: string, config: string): void {
  const path = join(workspace, config)
  try {
    const { shared: sharedOk, fileParallelismDisabled } = inspect(join(root, path))
    if (!sharedOk) {
      report(
        workspace,
        'import ciMaxWorkers from packages/config/vitest-workers.mts and set test.maxWorkers to it',
        config,
      )
    }
    if (fileParallelismDisabled) {
      report(
        workspace,
        'test.fileParallelism: false forces one worker after maxWorkers resolution',
        config,
      )
    }
  } catch (error) {
    report(
      workspace,
      `cannot read or parse config: ${error instanceof Error ? error.message : String(error)}`,
      config,
    )
  }
}

function usesVitest(manifest: string): boolean {
  const pkg: {
    dependencies?: { vitest?: string }
    devDependencies?: { vitest?: string }
    scripts?: { 'test:coverage'?: string }
  } = JSON.parse(readFileSync(join(root, manifest), 'utf8'))
  return Boolean(
    pkg.dependencies?.vitest || pkg.devDependencies?.vitest || pkg.scripts?.['test:coverage'],
  )
}

for (const pattern of workspaces) {
  const manifests = new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })
  for (const manifest of [...manifests].sort()) {
    const workspace = dirname(manifest)
    const cwd = join(root, workspace)
    const dedicated = [...configs.scanSync({ cwd })]
    const vitest = usesVitest(manifest)
    const candidates =
      dedicated.length > 0 || !vitest ? dedicated : [...fallbackConfigs.scanSync({ cwd })]
    if (vitest && candidates.length === 0) {
      report(workspace, 'no Vitest or Vite config; Vitest defaults to one worker on 2-CPU runners')
      continue
    }
    for (const config of candidates) check(workspace, config)
  }
}
