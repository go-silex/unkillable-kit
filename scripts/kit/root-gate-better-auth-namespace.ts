import {
  type BindingPattern,
  type MemberExpression,
  type Node,
  type ParamPattern,
  type Program,
  visitorKeys,
} from 'oxc-parser'

function staticMember(node: MemberExpression) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value
  }
}

function writesMember(parent: Node | undefined, field: string | undefined) {
  return (
    (parent?.type === 'AssignmentExpression' && field === 'left') ||
    parent?.type === 'UpdateExpression' ||
    (parent?.type === 'UnaryExpression' && parent.operator === 'delete')
  )
}

function skipsSubtree(node: Node, field?: string) {
  return (
    node.type === 'ImportDeclaration' ||
    (node.type === 'ExportNamedDeclaration' && (node.source || node.exportKind === 'type')) ||
    (node.type === 'ExportSpecifier' && node.exportKind === 'type') ||
    node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration' ||
    node.type === 'TSClassImplements' ||
    field === 'typeAnnotation' ||
    field === 'typeArguments' ||
    field === 'superTypeArguments' ||
    field === 'typeParameters' ||
    field === 'returnType'
  )
}

function childrenSome(node: Node, visit: (child: Node, field: string) => boolean) {
  const fields = node as unknown as Record<string, Node | (Node | null)[] | undefined | null>
  return (visitorKeys[node.type] ?? []).some((key) => {
    const value = fields[key]
    return Array.isArray(value)
      ? value.some((child) => child !== null && visit(child, key))
      : value != null && visit(value, key)
  })
}

type Scope = { parent?: Scope; shadows: Set<string>; vars: Set<string> }
type FactoryLookup = (name: string) => string | undefined

function bindingNames(pattern: BindingPattern | ParamPattern | null, bind: (name: string) => void) {
  switch (pattern?.type) {
    case 'Identifier':
      bind(pattern.name)
      break
    case 'ObjectPattern':
      for (const item of pattern.properties) {
        bindingNames(item.type === 'RestElement' ? item : item.value, bind)
      }
      break
    case 'ArrayPattern':
      for (const item of pattern.elements) bindingNames(item, bind)
      break
    case 'AssignmentPattern':
      bindingNames(pattern.left, bind)
      break
    case 'RestElement':
      bindingNames(pattern.argument, bind)
      break
    case 'TSParameterProperty':
      bindingNames(pattern.parameter, bind)
      break
  }
}

function isFunction(
  node?: Node,
): node is Extract<
  Node,
  { type: 'ArrowFunctionExpression' | 'FunctionDeclaration' | 'FunctionExpression' }
> {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression'
  )
}

const lexicalScopes = new Set<Node['type']>([
  'BlockStatement',
  'CatchClause',
  'ClassDeclaration',
  'ClassExpression',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'StaticBlock',
  'SwitchStatement',
  'TSModuleBlock',
])

function declareSurrounding(node: Node, scope: Scope) {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration':
    case 'TSImportEqualsDeclaration':
      if (node.id?.type === 'Identifier') scope.shadows.add(node.id.name)
      break
    case 'VariableDeclaration': {
      const names = node.kind === 'var' ? scope.vars : scope.shadows
      for (const item of node.declarations) bindingNames(item.id, (name) => names.add(name))
      break
    }
  }
}

function newScope(node: Node, surrounding: Scope, parent?: Node): Scope {
  const shadows = new Set<string>()
  const variableBoundary =
    node.type === 'StaticBlock' ||
    node.type === 'TSModuleBlock' ||
    (node.type === 'BlockStatement' && isFunction(parent))
  const vars = variableBoundary ? shadows : surrounding.vars
  if (node.type === 'CatchClause') bindingNames(node.param, (name) => shadows.add(name))
  if (isFunction(node)) {
    for (const param of node.params) bindingNames(param, (name) => shadows.add(name))
  }
  if (node.type === 'FunctionExpression' || node.type === 'ClassExpression') {
    if (node.id) shadows.add(node.id.name)
  }
  return { parent: surrounding, shadows, vars }
}

function indexScopes(program: Program) {
  const rootNames = new Set<string>()
  const root: Scope = { shadows: rootNames, vars: rootNames }
  const scopes = new WeakMap<Node, Scope>()
  function visit(node: Node, surrounding: Scope, parent?: Node, field?: string) {
    if (skipsSubtree(node, field)) return
    declareSurrounding(node, surrounding)
    const scope =
      isFunction(node) || lexicalScopes.has(node.type)
        ? newScope(node, surrounding, parent)
        : surrounding
    if (scope !== surrounding) scopes.set(node, scope)
    childrenSome(node, (child, key) => {
      const outer = node.type === 'SwitchStatement' && key === 'discriminant' ? surrounding : scope
      visit(child, outer, node, key)
      return false
    })
  }
  visit(program, root)
  return { root, scopes }
}

function isShadowed(scope: Scope, name: string) {
  for (let here: Scope | undefined = scope; here; here = here.parent) {
    if (here.shadows.has(name)) return true
  }
  return false
}

function lookupFactory(bindings: ReadonlyMap<string, string>, scope: Scope, name: string) {
  if (!isShadowed(scope, name)) return bindings.get(name)
}

function isNameOnly(parent: Node | undefined, field: string | undefined) {
  if (field === 'exported') return true
  if (field === 'property' && parent?.type === 'MemberExpression') return !parent.computed
  return (
    field === 'key' &&
    parent !== undefined &&
    'computed' in parent &&
    !parent.computed &&
    (parent.type !== 'Property' || !parent.shorthand)
  )
}

function memberUsesFactory(
  node: Node,
  resolveFactory: FactoryLookup,
  parent?: Node,
  field?: string,
) {
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
    const factory = resolveFactory(node.object.name)
    if (factory) {
      const member = staticMember(node)
      return member === undefined || member === factory || writesMember(parent, field)
    }
  }
  if (node.type === 'JSXMemberExpression' && node.object.type === 'JSXIdentifier') {
    const factory = resolveFactory(node.object.name)
    if (factory) return node.property.name === factory
  }
}

function identifierUsesFactory(
  node: Node,
  resolveFactory: FactoryLookup,
  parent?: Node,
  field?: string,
) {
  if (node.type === 'Identifier' && resolveFactory(node.name)) return !isNameOnly(parent, field)
  if (node.type === 'JSXIdentifier' && field === 'name') {
    return /^[A-Z]/.test(node.name) && resolveFactory(node.name) !== undefined
  }
}

export type AttestedCallee = { name: string; start: number; end: number }

export function factoryBindingEscapes(
  program: Program,
  bindings: ReadonlyMap<string, string>,
  attested?: AttestedCallee,
) {
  if (!(bindings.size || attested)) return false
  const { root, scopes } = indexScopes(program)
  function visit(node: Node, surrounding: Scope, parent?: Node, field?: string): boolean {
    if (skipsSubtree(node, field)) return false
    const scope = scopes.get(node) ?? surrounding
    if (
      attested &&
      node.type === 'Identifier' &&
      node.name === attested.name &&
      !isNameOnly(parent, field) &&
      !isShadowed(scope, node.name)
    ) {
      return node.start !== attested.start || node.end !== attested.end
    }
    const resolveFactory = (name: string) => lookupFactory(bindings, scope, name)
    const use =
      memberUsesFactory(node, resolveFactory, parent, field) ??
      identifierUsesFactory(node, resolveFactory, parent, field)
    if (use !== undefined) return use
    return childrenSome(node, (child, key) => {
      const outer = node.type === 'SwitchStatement' && key === 'discriminant' ? surrounding : scope
      return visit(child, outer, node, key)
    })
  }
  // Only a static read of a known non-factory member is treated as harmless.
  return visit(program, root)
}
