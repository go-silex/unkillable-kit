import type { RequestAuthorization } from '@kit/auth/hono'
import type { AppEnv } from '../types'
import { authorization } from './authorization'

// An explicit type keeps this export nameable through `@kit/auth/hono` (TS2883 under TS 7.1).
export const requireSession: RequestAuthorization<AppEnv>['requireSession'] =
  authorization.requireSession
