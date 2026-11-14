export type McpExampleEnv = {
  OAUTH_KV: KVNamespace
  DB: D1Database
  API_BASE_URL?: string
  WEB_ORIGIN?: string
  ENVIRONMENT?: string
  MCP_PUBLIC_URL?: string
}
