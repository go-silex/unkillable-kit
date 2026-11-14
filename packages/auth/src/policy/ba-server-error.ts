import { AppError, ErrorCode, toApiErrorBody } from '@kit/core'

/**
 * Replace a Better Auth 5xx body with a kit envelope.
 * Keeps the original status so ops still see 502/503; never forwards BA text.
 */
export function scrubBetterAuthServerError(res: Response, requestId: string): Response {
  if (res.status < 500) return res
  const { body } = toApiErrorBody(
    new AppError(ErrorCode.INTERNAL_ERROR, 'Internal error', res.status),
    requestId,
  )
  const headers = new Headers()
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('x-request-id', requestId)
  return new Response(JSON.stringify(body), { status: res.status, headers })
}
