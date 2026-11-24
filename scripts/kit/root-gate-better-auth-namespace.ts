import { type MemberExpression, type Node, type Program, visitorKeys } from 'oxc-parser'

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
  bindings: ReadonlyMap<string, string>,
  parent?: Node,
  field?: string,
) {
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
    const factory = bindings.get(node.object.name)
    if (factory) {
      const member = staticMember(node)
      return member === undefined || member === factory || writesMember(parent, field)
    }
  }
  if (node.type === 'JSXMemberExpression' && node.object.type === 'JSXIdentifier') {
    const factory = bindings.get(node.object.name)
    if (factory) return node.property.name === factory
  }
}

function identifierUsesFactory(
  node: Node,
  bindings: ReadonlyMap<string, string>,
  parent?: Node,
  field?: string,
) {
  if (node.type === 'Identifier' && bindings.has(node.name)) return !isNameOnly(parent, field)
  if (node.type === 'JSXIdentifier' && field === 'name') {
    return /^[A-Z]/.test(node.name) && bindings.has(node.name)
  }
}

export function namespaceUsesFactory(program: Program, bindings: ReadonlyMap<string, string>) {
  function visit(node: Node, parent?: Node, field?: string): boolean {
    if (skipsSubtree(node, field)) return false
    const use =
      memberUsesFactory(node, bindings, parent, field) ??
      identifierUsesFactory(node, bindings, parent, field)
    if (use !== undefined) return use
    const fields = node as unknown as Record<string, Node | (Node | null)[] | undefined | null>
    return (visitorKeys[node.type] ?? []).some((key) => {
      const value = fields[key]
      return Array.isArray(value)
        ? value.some((child) => child !== null && visit(child, node, key))
        : value != null && visit(value, node, key)
    })
  }
  // Only a static read of a known non-factory member is treated as harmless.
  return bindings.size > 0 && visit(program)
}
