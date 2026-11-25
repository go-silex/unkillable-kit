import { isIdentifier } from './core-rows'

export type HostedPrincipalInput = Readonly<{ userId: string; grantId?: string; clientId?: string }>
const principalBrand: unique symbol = Symbol()
export type HostedPrincipal = HostedPrincipalInput & { readonly [principalBrand]: true }
const admitted = new WeakSet<HostedPrincipal>()

export function readHostedPrincipal(input: HostedPrincipalInput): HostedPrincipalInput | null {
  const { userId, grantId, clientId } = input
  if (!isIdentifier(userId)) return null
  if (grantId === undefined && clientId === undefined) return { userId }
  return isIdentifier(grantId) && isIdentifier(clientId) ? { userId, grantId, clientId } : null
}

export function sealHostedPrincipal(input: HostedPrincipalInput): HostedPrincipal {
  const principal = Object.freeze({ ...input, [principalBrand]: true as const })
  admitted.add(principal)
  return principal
}

export function isHostedPrincipal(value: HostedPrincipal): boolean {
  return admitted.has(value)
}
