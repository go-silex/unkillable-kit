import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import type { Authorization } from './oidc-fresh-login-provenance'

const authorizePath = '/oauth2/authorize'
const unsupportedPrompt = 'create'

export function supportedPrompts(query: Record<string, unknown>) {
  const prompt =
    typeof query.prompt === 'string'
      ? query.prompt
          .split(' ')
          .map((token) => token.trim())
          .filter(Boolean)
      : []
  if (
    (query.prompt !== undefined && prompt.length === 0) ||
    prompt.includes(unsupportedPrompt) ||
    (prompt.includes('none') && new Set(prompt).size !== 1)
  )
    return
  return prompt
}

export function requiresPasswordSignIn(
  query: Record<string, unknown>,
  authorization: Authorization,
) {
  return (
    authorization.freshness !== null ||
    query.max_age !== undefined ||
    (typeof query.prompt === 'string' &&
      query.prompt.split(' ').some((prompt) => prompt.trim() === 'login'))
  )
}

function rejectSignupPrompt(params: Record<string, unknown> | undefined) {
  const prompt = params?.prompt
  if (
    typeof prompt !== 'string' ||
    !prompt.split(' ').some((token) => token.trim() === unsupportedPrompt)
  )
    return
  // Let Better Auth format the validation error and verify the client's callback.
  return { ...params, prompt: `${unsupportedPrompt}-not-supported` }
}

export const rejectOidcSignupPrompt = {
  matcher: (ctx: { path?: string }) => ctx.path === authorizePath,
  handler: createAuthMiddleware(async (ctx) => {
    // Initial form POSTs use the body; GET and resumed authorization use the query.
    const query = rejectSignupPrompt(ctx.query)
    const body = rejectSignupPrompt(ctx.body)
    if (query || body) return { context: { query, body } }
  }),
}

async function rewriteSuccessfulMetadataResponse(response: Response, method: string) {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  if (method === 'HEAD') {
    return new Response(null, { status: response.status, headers })
  }
  const metadata = (await response.clone().json()) as Record<string, unknown>
  if (!('claims_parameter_supported' in metadata)) return
  metadata.claims_parameter_supported = false
  const prompts = metadata.prompt_values_supported
  if (Array.isArray(prompts)) {
    metadata.prompt_values_supported = prompts.filter((prompt) => prompt !== unsupportedPrompt)
  }
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function withOidcPromptPolicy(
  provider: BetterAuthPlugin,
  capture: (request: Request, baseURL: string) => Promise<{ response: Response } | undefined>,
): BetterAuthPlugin {
  const onRequest = provider.onRequest
  return {
    ...provider,
    onRequest: async (request, ctx) => {
      const result = await onRequest?.(request, ctx)
      if (!(result && 'response' in result)) {
        const current = result && 'request' in result ? result.request : request
        return (await capture(current, ctx.baseURL)) ?? result
      }
      if (!result.response.ok) return result
      const response = await rewriteSuccessfulMetadataResponse(result.response, request.method)
      return response ? { ...result, response } : result
    },
  }
}
