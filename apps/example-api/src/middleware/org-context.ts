import { authorization } from './authorization'

export const { requireOrgContext, requireOrgCapability, requirePlatformRole, requireModule } =
  authorization
