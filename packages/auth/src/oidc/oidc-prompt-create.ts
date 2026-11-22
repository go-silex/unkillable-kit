import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware, NO_STORE_HEADERS } from 'better-auth/api'

const authorizePath = '/oauth2/authorize'
const unsupportedPrompt = 'create'

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

async function rejectDuplicateFormPrompt(
  request: Request,
  baseURL: string,
  skipTrailingSlashes: boolean | undefined,
) {
  if (request.method !== 'POST' || !request.body) return
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') return
  const basePath = new URL(baseURL).pathname.replace(/\/+$/, '')
  const pathname = new URL(request.url).pathname
  const path = skipTrailingSlashes ? pathname.replace(/\/$/, '') : pathname
  if (path !== `${basePath}${authorizePath}`) return

  // Better Call keeps only the last form field. Reject ambiguity before routing,
  // leaving malformed bodies to the normal parser.
  const form = await request
    .clone()
    .formData()
    .catch(() => undefined)
  if (form?.getAll('prompt')[1] === undefined) return
  return {
    response: Response.json(
      { error: 'invalid_request', error_description: 'prompt must not be repeated' },
      { status: 400, headers: NO_STORE_HEADERS },
    ),
  }
}

export function withOidcPromptPolicy(provider: BetterAuthPlugin): BetterAuthPlugin {
  const onRequest = provider.onRequest
  return {
    ...provider,
    onRequest: async (request, ctx) => {
      const result = await onRequest?.(request, ctx)
      if (!(result && 'response' in result)) {
        return (
          (await rejectDuplicateFormPrompt(
            request,
            ctx.baseURL,
            ctx.options.advanced?.skipTrailingSlashes,
          )) ?? result
        )
      }
      const response = result.response
      if (!response.ok) return result
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      if (request.method === 'HEAD') {
        return { ...result, response: new Response(null, { status: response.status, headers }) }
      }
      const metadata = (await response.clone().json()) as Record<string, unknown>
      if (!('claims_parameter_supported' in metadata)) return result
      metadata.claims_parameter_supported = false
      const prompts = metadata.prompt_values_supported
      if (Array.isArray(prompts)) {
        metadata.prompt_values_supported = prompts.filter((prompt) => prompt !== unsupportedPrompt)
      }
      return {
        ...result,
        response: new Response(JSON.stringify(metadata), {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      }
    },
  }
}
