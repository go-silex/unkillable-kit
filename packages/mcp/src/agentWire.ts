/**
 * Agent / MCP wire SSoT — env keys, budgets, status enum, public tool error codes.
 * Import from here (or package barrel); do not re-declare stringly constants in apps.
 */

/** Env keys read by kit MCP handlers / example. */
export const MCP_ENV_KEYS = {
  AUTHORIZATION: 'AUTHORIZATION',
  API_KEY: 'API_KEY',
  API_BASE_URL: 'API_BASE_URL',
  MCP_ALLOWED_HOSTS: 'MCP_ALLOWED_HOSTS',
} as const

/** Machine credential header convention: Authorization: Bearer sk_… */
export const MCP_BEARER_HEADER = 'Authorization' as const
export const MCP_BEARER_PREFIX = 'Bearer ' as const

/**
 * Whoami **domain** status channel (tool succeeds with JSON body).
 * Not the same as public tool error codes (infra channel).
 */
export const WHOAMI_STATUS = [
  'ok',
  'missing_key',
  'missing_identity',
  'unauthorized',
  'unreachable',
  'invalid_response',
  'bad_config',
] as const

export type WhoamiStatus = (typeof WHOAMI_STATUS)[number]

/** Public tool error codes — infra channel only (budget / wrap / unexpected). */
export const PUBLIC_TOOL_ERROR_CODES = [
  'INVALID_ARGUMENTS',
  'UNAUTHORIZED',
  'BAD_CONFIG',
  'UNREACHABLE',
  'UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type PublicToolErrorCode = (typeof PUBLIC_TOOL_ERROR_CODES)[number]

/** Fixed agent-facing messages (≤ ~200 chars). Never use raw exception.message. */
export const PUBLIC_TOOL_ERROR_MESSAGES: Record<PublicToolErrorCode, string> = {
  INVALID_ARGUMENTS: 'Tool input failed validation or size limits.',
  UNAUTHORIZED: 'Missing or invalid API credentials for this tool.',
  BAD_CONFIG: 'Server configuration is incomplete or invalid for this tool.',
  UNREACHABLE: 'Upstream service was unreachable.',
  UNAVAILABLE: 'Authorization is temporarily unavailable.',
  INTERNAL_ERROR: 'Internal tool error.',
}

/** Input budget defaults (fail-closed before handler body). */
export const INPUT_BUDGET = {
  maxDepth: 32,
  maxVisitedValues: 10_000,
  maxArrayLength: 1_000,
  maxKeyLength: 256,
} as const

/**
 * Kit demo tool names for docs/kit/tests only — **not** the smoke expected-set.
 * Product apps own their catalogue; mcp-example exports catalogue.names for smoke.
 */
export const DEFAULT_EXAMPLE_TOOL_NAMES = ['ping', 'whoami'] as const
export type DefaultExampleToolName = (typeof DEFAULT_EXAMPLE_TOOL_NAMES)[number]
