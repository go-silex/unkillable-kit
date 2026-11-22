import type { KitD1Database } from '@kit/db'

const noStore = { 'cache-control': 'no-store' }

export function trackAuthorizationResponses(db: KitD1Database) {
  const responses = new WeakMap<Request, { identifiers: string[]; denied: boolean }>()

  function deny(request?: Request) {
    const response = request && responses.get(request)
    if (response) response.denied = true
  }

  function trackMint(request: Request, identifier: string) {
    let response = responses.get(request)
    if (!response) {
      response = { identifiers: [], denied: false }
      responses.set(request, response)
    }
    if (response.denied) return false
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
    if (!pending || (!pending.denied && result.status < 400)) return result
    // Better Auth can retain the first redirect headers after a nested denial.
    // Replace the whole response and delete any earlier code for this request.
    try {
      for (const identifier of pending.identifiers) {
        await db.prepare('DELETE FROM verification WHERE identifier = ?').bind(identifier).run()
      }
    } catch {
      return new Response(null, { status: 500, headers: noStore })
    }
    return result.status >= 500
      ? new Response(null, { status: 500, headers: noStore })
      : Response.json({ error: 'invalid_request' }, { status: 400, headers: noStore })
  }

  return {
    deny,
    trackMint,
    hasTrackedMint: (request: Request) => responses.has(request),
    protectResponse,
  }
}
