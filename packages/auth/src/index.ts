export {
  allowPublicSignup,
  assertAuthSecret,
  assertBetterAuthConfigured,
  assertTrustedOrigins,
  type BetterAuthEnvSlice,
  betterAuthBaseURL,
  corsAllowlist,
  environmentName,
  getBetterAuthSecret,
  isDevLikeEnvironment,
  sessionCookieNameFromEnv,
  useSecureCookie,
} from './better-auth-env'
export { type SessionCookieNameOpts, sessionCookieName } from './cookie-name'
export {
  createFirstSessionAfterHook,
  type FirstSessionHandler,
} from './first-session-hook'
export {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  parseBearer,
  timingSafeEqualHex,
  verifyApiKey,
} from './keys'
export {
  accessAllows,
  grantsDominate,
  isAssignableRoleKey,
  isModuleAccess,
  MODULE_ACCESS_LEVELS,
  type ModuleAccess,
  type ModuleOp,
  systemRoleDefaultAccess,
  systemRoleGrantSeed,
} from './module-grants'
export {
  canInviteRole,
  INVITABLE_ORG_ROLES,
  type InvitableOrgRole,
  isInvitableOrgRole,
  isOrgRoleKey,
  isPlatformRole,
  normalizeEmail,
  ORG_KINDS,
  ORG_ROLE_KEYS,
  ORG_STATUSES,
  type OrgCapability,
  type OrgKind,
  type OrgRoleKey,
  type OrgStatus,
  PLATFORM_ROLES,
  type PlatformRole,
  roleAtLeast,
  roleHasCapability,
} from './org-roles'
export { isBaOrganizationRoute } from './org-route-deny'
export {
  AUTH_CHANGE_PASSWORD_PATH,
  AUTH_REQUEST_PASSWORD_RESET_PATH,
  AUTH_RESET_PASSWORD_PATH,
  type ChangePasswordValues,
  changePasswordSchema,
  type ForgotPasswordValues,
  forgotPasswordSchema,
  type ResetPasswordValues,
  resetPasswordSchema,
} from './password-schemas'
export {
  type ApiKeyAuthIdentity,
  type ApiKeyScope,
  type AuthIdentity,
  parseApiKeyScopes,
  type SessionAuthIdentity,
} from './require-auth'
export { parseCookie, parseSessionCookie, SESSION_COOKIE } from './session'
