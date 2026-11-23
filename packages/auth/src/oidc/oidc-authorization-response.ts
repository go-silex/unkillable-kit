import type { KitD1Database } from '@kit/db'
import { APIError } from 'better-auth/api'

const noStore = { 'cache-control': 'no-store' }
const restartBody = {
  code: 'OIDC_RESTART_REQUIRED',
  message: 'Restart authorization from the client.',
}

type PendingResponse = {
  identifiers: string[]
  denied: boolean
  restart?: true
}

export function trackAuthorizationResponses(db: KitD1Database) {
  const responses = new WeakMap<Request, PendingResponse>()

  function pendingResponse(request: Request) {
    let response = responses.get(request)
    if (!response) {
      response = { identifiers: [], denied: false }
      responses.set(request, response)
    }
    return response
  }

  function restart(request?: Request) {
    if (request) pendingResponse(request).restart = true
    return new APIError('CONFLICT', restartBody)
  }

  function deny(request?: Request) {
    const response = request && responses.get(request)
    if (response) response.denied = true
  }

  function trackMint(request: Request, identifier: string) {
    const response = pendingResponse(request)
    if (response.denied || response.restart) return false
    response.identifiers.push(identifier)
    return true
  }

  async function protectResponse(request: Request, next: (request: Request) => Promise<Response>) {
    let result: Response
    try {
      result = await next(request)
    } catch (error) {
      if (!responses.has(request)) throw error
      deny(request)
      result = new Response(null, { status: 500, headers: noStore })
    }
    const pending = responses.get(request)
    responses.delete(request)
    if (!pending || (!(pending.denied || pending.restart) && result.status < 400)) return result
    return rejectResponse(pending, result.status)
  }

  async function rejectResponse(pending: PendingResponse, status: number) {
    // Replace any provisional auth headers and remove codes tracked for this request.
    try {
      for (const identifier of pending.identifiers) {
        await db.prepare('DELETE FROM verification WHERE identifier = ?').bind(identifier).run()
      }
    } catch {
      return new Response(null, { status: 500, headers: noStore })
    }
    if (status >= 500) return new Response(null, { status: 500, headers: noStore })
    if (pending.restart) return Response.json(restartBody, { status: 409, headers: noStore })
    return Response.json({ error: 'invalid_request' }, { status: 400, headers: noStore })
  }

  return {
    deny,
    restart,
    trackMint,
    hasTrackedMint: (request: Request) => !!responses.get(request)?.identifiers.length,
    protectResponse,
  }
}
