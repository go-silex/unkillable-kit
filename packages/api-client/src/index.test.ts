import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ApiClientOptions,
  ApiError,
  type ApiFetchInit,
  apiErrorFieldErrors,
  apiErrorToMessage,
  apiFetch,
  createApiClient,
  fieldErrorsFirstMessages,
  HttpError,
  isValidationDetails,
} from './index'

describe('ApiError', () => {
  it('maps nested envelope', () => {
    const err = new ApiError(401, {
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      requestId: 'req_abc',
    })
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.requestId).toBe('req_abc')
    expect(err.status).toBe(401)
    expect(err.name).toBe('ApiError')
  })
})

describe('apiErrorFieldErrors', () => {
  it('reads details.fieldErrors from kit envelope', () => {
    const err = new ApiError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid note',
        details: { fieldErrors: { title: ['Required'], body: ['Too long'] } },
      },
      requestId: 'req_fe',
    })
    expect(isValidationDetails(err.details)).toBe(true)
    expect(apiErrorFieldErrors(err)).toEqual({ title: ['Required'], body: ['Too long'] })
    expect(fieldErrorsFirstMessages(apiErrorFieldErrors(err)!)).toEqual({
      title: 'Required',
      body: 'Too long',
    })
  })

  it('returns null for non-ApiError, free-form details, or missing fieldErrors', () => {
    expect(apiErrorFieldErrors(new Error('x'))).toBeNull()
    expect(
      apiErrorFieldErrors(
        new ApiError(400, {
          error: { code: 'VALIDATION_ERROR', message: 'bad', details: { max: 5 } },
          requestId: 'req_x',
        }),
      ),
    ).toBeNull()
    expect(
      apiErrorFieldErrors(
        new ApiError(400, {
          error: { code: 'VALIDATION_ERROR', message: 'bad' },
          requestId: 'req_x',
        }),
      ),
    ).toBeNull()
  })

  it('rejects fieldErrors null and array (guards are polar)', () => {
    const nullFe = new ApiError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad',
        details: { fieldErrors: null as unknown as Record<string, string[]> },
      },
      requestId: 'req_null_fe',
    })
    expect(isValidationDetails(nullFe.details)).toBe(false)
    expect(apiErrorFieldErrors(nullFe)).toBeNull()

    const arrFe = new ApiError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad',
        details: { fieldErrors: [] as unknown as Record<string, string[]> },
      },
      requestId: 'req_arr_fe',
    })
    expect(isValidationDetails(arrFe.details)).toBe(false)
    expect(apiErrorFieldErrors(arrFe)).toBeNull()
  })
})

describe('apiErrorToMessage', () => {
  it('prefers wire message without catalog', () => {
    const err = new ApiError(400, {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid note' },
      requestId: 'req_x',
    })
    expect(apiErrorToMessage(err)).toBe('Invalid note')
    expect(apiErrorToMessage(new Error('boom'))).toBe('boom')
    expect(apiErrorToMessage(null, 'fallback')).toBe('fallback')
  })

  it('maps ErrorCode via messages catalog', () => {
    const err = new ApiError(401, {
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      requestId: 'req_x',
    })
    expect(
      apiErrorToMessage(err, {
        fallback: 'Error',
        messages: { UNAUTHORIZED: 'Session expired' },
      }),
    ).toBe('Session expired')
  })
})

describe('apiFetch / createApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults credentials include and parses ok JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const data = await apiFetch<{ ok: boolean }>('/health')
    expect(data.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('prefixes baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    })
    const { apiFetch: clientFetch } = createApiClient({
      baseUrl: 'https://api.example',
      fetch: fetchMock as unknown as typeof fetch,
    })
    await clientFetch('/v1/me')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/v1/me',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('throws ApiError for kit envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
            requestId: 'req_x',
          }),
      }),
    )
    await expect(apiFetch('/api/me')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'UNAUTHORIZED',
      requestId: 'req_x',
      status: 401,
    })
  })

  it('calls onUnauthorized on 401 before throw', async () => {
    const onUnauthorized = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
            requestId: 'req_x',
          }),
      }),
    )
    await expect(apiFetch('/api/me', undefined, { onUnauthorized })).rejects.toBeInstanceOf(
      ApiError,
    )
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized.mock.calls[0]?.[0]).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('parse-on-read maps ok JSON and is not forwarded to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ subject: 'user_1' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const data = await apiFetch<{ subject: string }>('/api/me', {
      parse: (raw) => {
        if (!raw || typeof raw !== 'object' || !('subject' in raw)) throw new Error('bad')
        const subject = (raw as { subject: unknown }).subject
        if (typeof subject !== 'string' || subject.length === 0) throw new Error('bad')
        return { subject }
      },
    })
    expect(data).toEqual({ subject: 'user_1' })
    const init = fetchMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(init).not.toHaveProperty('parse')
  })

  it('parse-on-read fails closed on shape mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ nope: true }),
      }),
    )
    const zodErr = new Error('zod')
    await expect(
      apiFetch('/api/me', {
        parse: () => {
          throw zodErr
        },
      }),
    ).rejects.toMatchObject({ message: 'Invalid API response', cause: zodErr })
  })

  it.each([
    ['JSON outside the envelope', '{"message":"secret"}'],
    ['non-JSON', '<html>secret</html>'],
    ['empty', ''],
    ['malformed envelope', '{"error":{"code":"SECRET"}}'],
  ])('reports a 401 %s once before rejection without leaking its body', async (_label, body) => {
    const onUnauthorized = vi.fn()
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => body })
    const promise = apiFetch('/protected', undefined, { fetch, onUnauthorized })
    const error = await promise.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, message: 'HTTP 401' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith(error)
  })

  it('preserves Kit details without inventing a requestId', async () => {
    const details = { fieldErrors: { title: ['Required'] } }
    const onUnauthorized = vi.fn()
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in', details } }),
    })
    const error = await apiFetch('/protected', undefined, { fetch, onUnauthorized }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in', details })
    expect((error as ApiError).requestId).toBeUndefined()
    expect(apiErrorFieldErrors(error)).toEqual(details.fieldErrors)
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(onUnauthorized).toHaveBeenCalledWith(error)
  })

  it('awaits callback and preserves the HTTP error when callback fails', async () => {
    const callbackFailure = new Error('cleanup failed')
    const onUnauthorized = vi.fn(async () => {
      throw callbackFailure
    })
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' })
    const error = await apiFetch('/protected', undefined, { fetch, onUnauthorized }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401 })
    expect(error).not.toBe(callbackFailure)
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(onUnauthorized).toHaveBeenCalledWith(error)
  })

  it('preserves the HTTP error if a synchronous callback throws', async () => {
    const onUnauthorized = vi.fn(() => {
      throw new Error('cleanup failed')
    })
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' })
    await expect(
      apiFetch('/protected', undefined, { fetch, onUnauthorized }),
    ).rejects.toMatchObject({ status: 401, message: 'HTTP 401' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('calls the callback even if the error response body cannot be read', async () => {
    const onUnauthorized = vi.fn()
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => {
        throw new Error('body read failure')
      },
    })
    const error = await apiFetch('/protected', undefined, { fetch, onUnauthorized }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401, message: 'HTTP 401' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(onUnauthorized).toHaveBeenCalledWith(error)
  })

  it('reports text 429 without exposing the response body', async () => {
    const onUnauthorized = vi.fn()
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'secret rate limit details',
    })
    const error = await apiFetch('/limited', undefined, { fetch, onUnauthorized }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 429, message: 'HTTP 429' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('keeps network errors distinct and does not call the 401 callback', async () => {
    const networkError = new TypeError('network unavailable')
    const fetch = vi.fn().mockRejectedValue(networkError)
    const onUnauthorized = vi.fn()
    await expect(apiFetch('/offline', undefined, { fetch, onUnauthorized })).rejects.toBe(
      networkError,
    )
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('preserves request body and configured credentials', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const body = '{"name":"test"}'
    await expect(
      apiFetch('/test', { method: 'POST', body }, { fetch, credentials: 'omit' }),
    ).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      '/test',
      expect.objectContaining({
        method: 'POST',
        body,
        credentials: 'omit',
      }),
    )
  })

  it('rejects invalid JSON on success', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'not JSON' })
    await expect(apiFetch('/test', undefined, { fetch })).rejects.toThrow('Invalid JSON response')
  })
})

describe('apiFetch body content-type', () => {
  async function requestFromApiFetch(
    init: ApiFetchInit,
    opts: ApiClientOptions = {},
  ): Promise<Request> {
    let captured: Request | undefined
    const fetch = vi.fn(async (input: RequestInfo | URL, fetchInit?: RequestInit) => {
      captured = new Request(input, fetchInit)
      return { ok: true, status: 200, text: async () => 'null' }
    })
    await apiFetch('/upload', init, {
      baseUrl: 'https://api.example',
      ...opts,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    if (!captured) throw new Error('fetch was not called')
    return captured
  }

  it('lets fetch derive multipart/form-data for FormData bodies', async () => {
    const body = new FormData()
    body.append('title', 'report')
    body.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }))
    const request = await requestFromApiFetch({ method: 'POST', body })
    const contentType = request.headers.get('content-type')
    expect(contentType).toMatch(/^multipart\/form-data;\s*boundary=/)
    const formData = await request.formData()
    expect(formData.get('title')).toBe('report')
    const file = formData.get('file')
    expect(file).toBeInstanceOf(File)
    if (!(file instanceof File)) throw new Error('expected File')
    expect(file.name).toBe('hello.txt')
    expect(await file.text()).toBe('hello')
  })

  it('lets fetch derive urlencoded content-type for URLSearchParams', async () => {
    const request = await requestFromApiFetch({
      method: 'POST',
      body: new URLSearchParams({ q: 'kit' }),
    })
    expect(request.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    )
  })

  it('keeps a typed Blob content-type', async () => {
    const request = await requestFromApiFetch({
      method: 'POST',
      body: new Blob(['{"a":1}'], { type: 'application/vnd.kit+json' }),
    })
    expect(request.headers.get('content-type')).toBe('application/vnd.kit+json')
  })

  it('sends binary bodies without a content-type', async () => {
    const request = await requestFromApiFetch({
      method: 'POST',
      body: new TextEncoder().encode('{"a":1}').buffer,
    })
    expect(request.headers.get('content-type')).toBeNull()
    expect(await request.text()).toBe('{"a":1}')
  })

  it('defaults string bodies to application/json', async () => {
    const request = await requestFromApiFetch({ method: 'POST', body: '{"ok":true}' })
    expect(request.headers.get('content-type')).toBe('application/json')
  })

  it('keeps an explicit request content-type', async () => {
    const request = await requestFromApiFetch({
      method: 'POST',
      body: '{"ok":true}',
      headers: { 'content-type': 'application/vnd.custom+json' },
    })
    expect(request.headers.get('content-type')).toBe('application/vnd.custom+json')
  })

  it('keeps defaultHeaders content-type', async () => {
    const request = await requestFromApiFetch(
      { method: 'POST', body: '{"ok":true}' },
      { defaultHeaders: { 'content-type': 'application/vnd.default+json' } },
    )
    expect(request.headers.get('content-type')).toBe('application/vnd.default+json')
  })
})
