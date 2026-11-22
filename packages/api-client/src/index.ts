import type { ApiErrorBody, ErrorCodeName, FieldErrors, ValidationDetails } from '@kit/types'

/** An HTTP response outside the 2xx range, including non-Kit responses. */
export class HttpError extends Error {
  readonly status: number
  declare readonly upstreamCode?: string

  constructor(status: number, message = `HTTP ${status}`, upstreamCode?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (upstreamCode !== undefined) this.upstreamCode = upstreamCode
  }
}

export class ApiError extends HttpError {
  readonly code: string
  readonly requestId: string | undefined
  readonly details?: unknown

  constructor(status: number, body: Omit<ApiErrorBody, 'requestId'> & { requestId?: string }) {
    super(status, body.error.message)
    this.name = 'ApiError'
    this.code = body.error.code
    this.requestId = body.requestId
    this.details = body.error.details
  }
}

/** True when `details` is kit {@link ValidationDetails} (`{ fieldErrors }`). */
export function isValidationDetails(details: unknown): details is ValidationDetails {
  if (!details || typeof details !== 'object') return false
  if (!('fieldErrors' in details)) return false
  const fe = (details as ValidationDetails).fieldErrors
  return fe != null && typeof fe === 'object' && !Array.isArray(fe)
}

/**
 * Extract wire `details.fieldErrors` from a kit {@link ApiError}.
 * Returns null when absent / wrong shape (message-only or free-form details).
 */
export function apiErrorFieldErrors(err: unknown): FieldErrors | null {
  if (!(err instanceof ApiError)) return null
  if (!isValidationDetails(err.details)) return null
  return err.details.fieldErrors
}

/**
 * First message per field — handy for TanStack Form `fields: { name: string }`.
 * Skips empty arrays / undefined lists.
 */
export function fieldErrorsFirstMessages(
  fieldErrors: FieldErrors,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, msgs] of Object.entries(fieldErrors)) {
    const first = msgs?.find((m) => typeof m === 'string' && m.length > 0)
    if (first) out[key] = first
  }
  return out
}

export type ApiClientOptions = {
  baseUrl?: string
  /** Default `'include'` for cookie sessions. */
  credentials?: RequestCredentials
  fetch?: typeof fetch
  defaultHeaders?: HeadersInit
  /** Called once on every HTTP 401 before rejection. Callback failures do not replace the HTTP error. */
  onUnauthorized?: (err: HttpError) => void | Promise<void>
}

/**
 * RequestInit plus optional parse-on-read. `parse` is never forwarded to fetch.
 * Without `parse`, JSON is trusted as `T` (compile-time only).
 */
export type ApiFetchInit<T = unknown> = RequestInit & {
  parse?: (data: unknown) => T
}

export type ApiFetch = <T>(path: string, init?: ApiFetchInit<T>) => Promise<T>

function parseResponseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Invalid JSON response')
  }
}

function httpError(status: number, data: unknown): HttpError {
  if (data && typeof data === 'object' && 'error' in data) {
    const error = data.error
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error &&
      typeof error.code === 'string' &&
      typeof error.message === 'string'
    ) {
      const requestId =
        'requestId' in data && typeof data.requestId === 'string' ? data.requestId : undefined
      return new ApiError(status, {
        error: {
          code: error.code as ErrorCodeName,
          message: error.message,
          ...('details' in error ? { details: error.details } : {}),
        },
        requestId,
      })
    }
  }
  if (
    data &&
    typeof data === 'object' &&
    'code' in data &&
    'message' in data &&
    typeof data.code === 'string' &&
    typeof data.message === 'string'
  ) {
    return new HttpError(status, undefined, data.code)
  }
  return new HttpError(status)
}

function parseOkBody<T>(data: unknown, parse?: (value: unknown) => T): T {
  if (!parse) return data as T
  try {
    return parse(data)
  } catch (cause) {
    throw new Error('Invalid API response', { cause })
  }
}

async function rejectHttpResponse(
  res: Response,
  onUnauthorized?: ApiClientOptions['onUnauthorized'],
): Promise<never> {
  let data: unknown = null
  try {
    data = parseResponseBody(await res.text())
  } catch {
    // Unreadable or non-JSON error bodies are never exposed.
  }
  const error = httpError(res.status, data)
  if (res.status === 401 && onUnauthorized) {
    try {
      await onUnauthorized(error)
    } catch {
      // Preserve the HTTP failure even if session cleanup fails.
    }
  }
  throw error
}

export function createApiClient(opts: ApiClientOptions = {}): { apiFetch: ApiFetch } {
  const baseUrl = opts.baseUrl ?? ''
  const credentials = opts.credentials ?? 'include'
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const apiFetch: ApiFetch = async <T>(path: string, init?: ApiFetchInit<T>): Promise<T> => {
    const { parse, ...fetchInit } = init ?? {}
    const headers = new Headers(opts.defaultHeaders)
    if (fetchInit.headers) {
      new Headers(fetchInit.headers).forEach((value, key) => {
        headers.set(key, value)
      })
    }
    if (typeof fetchInit.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }

    const res = await fetchFn(`${baseUrl}${path}`, {
      ...fetchInit,
      credentials,
      headers,
    })
    if (!res.ok) return rejectHttpResponse(res, opts.onUnauthorized)
    return parseOkBody(parseResponseBody(await res.text()), parse)
  }

  return { apiFetch }
}

/** One-shot helper; prefer `createApiClient` when sharing options across calls. */
export function apiFetch<T>(
  path: string,
  init?: ApiFetchInit<T>,
  opts?: ApiClientOptions,
): Promise<T> {
  return createApiClient(opts).apiFetch<T>(path, init)
}

export type ApiErrorMessageOptions = {
  fallback: string
  /** ErrorCode → user string; app owns i18n — package never hardcodes FR/EN. */
  messages?: Partial<Record<ErrorCodeName, string>>
}

/**
 * Map API / unknown errors to a user-facing string.
 * Prefer catalog[ErrorCode] → wire message → fallback.
 */
export function apiErrorToMessage(
  err: unknown,
  opts: ApiErrorMessageOptions | string = 'Error',
): string {
  const fallback = typeof opts === 'string' ? opts : opts.fallback
  const messages = typeof opts === 'string' ? undefined : opts.messages

  if (err instanceof ApiError) {
    const fromCatalog = messages?.[err.code as ErrorCodeName]
    if (fromCatalog) return fromCatalog
    return err.message || err.code || fallback
  }
  if (err instanceof Error && err.message) {
    return err.message
  }
  return fallback
}
