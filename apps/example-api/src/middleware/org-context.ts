import type { RequestAuthorization } from '@kit/auth/hono'
import type { AppEnv } from '../types'
import { authorization } from './authorization'

type Guards = RequestAuthorization<AppEnv>

// Explicit types keep these exports nameable through `@kit/auth/hono` (TS2883 under TS 7.1).
export const requireOrgContext: Guards['requireOrgContext'] = authorization.requireOrgContext
export const requireOrgCapability: Guards['requireOrgCapability'] =
  authorization.requireOrgCapability
export const requirePlatformRole: Guards['requirePlatformRole'] = authorization.requirePlatformRole
export const requireModule: Guards['requireModule'] = authorization.requireModule
