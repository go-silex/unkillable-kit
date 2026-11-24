import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { type ModuleExportName, type Program, parseSync, Visitor } from 'oxc-parser'
import { namespaceUsesFactory } from './root-gate-better-auth-namespace.ts'

export const adapterName = 'createBetterAuth'
export const kitFactory = '@kit/auth/factory'
export const runtimeExtension = /\.[cm]?[jt]sx?$/
export const generatedDirectory = /(^|\/)(?:dist|build)\//

export function isWithin(path: string) {
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

const serverFactoryExports: Record<string, string> = {
  [kitFactory]: adapterName,
  'better-auth': 'betterAuth',
  'better-auth/minimal': 'betterAuth',
}

function exportName(node: ModuleExportName) {
  return node.type === 'Identifier' ? node.name : node.value
}

export function importsServerFactory(
  program: Program,
  resolveFactory: (source: string) => string | undefined = (source) =>
    Object.hasOwn(serverFactoryExports, source) ? serverFactoryExports[source] : undefined,
) {
  let found = false
  const namespaces = new Map<string, string>()
  function check(source: string, exported?: string) {
    const factory = resolveFactory(source)
    found ||= factory !== undefined && (exported === undefined || exported === factory)
  }
  new Visitor({
    ImportDeclaration(node) {
      const factory = resolveFactory(node.source.value)
      if (!factory || node.importKind === 'type') return
      for (const item of node.specifiers) {
        if (item.type === 'ImportNamespaceSpecifier') {
          namespaces.set(item.local.name, factory)
        } else if (item.type === 'ImportSpecifier') {
          found ||= item.importKind !== 'type' && exportName(item.imported) === factory
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.exportKind === 'type' || !node.source) return
      for (const item of node.specifiers) {
        if (item.exportKind !== 'type') check(node.source.value, exportName(item.local))
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
  return found || namespaceUsesFactory(program, namespaces)
}
