import {
  changePasswordErrorMessage as authChangePasswordErrorMessage,
  isRateLimited as isAuthRateLimited,
} from '@kit/auth/react'
import type { ErrorCodeName } from '@kit/types'
import { describe, expect, it, vi } from 'vitest'
import { en } from '../messages/en'
import {
  changePasswordErrorMessage,
  isRateLimited,
  isServerError,
  loginErrorMessage,
  profileErrorMessage,
  signupErrorMessage,
} from './account-errors'
import { ApiError, apiFetch, HttpError } from './api'

function apiErr(status: number, code: ErrorCodeName): ApiError {
  return new ApiError(status, {
    error: { code, message: 'wire' },
    requestId: 'req_test',
  })
}

describe('flat upstream error classification', () => {
  it.each([
    ['RATE_LIMITED', '/api/auth/request-password-reset'],
    ['UNAUTHORIZED', '/api/auth/change-password'],
  ])('treats flat %s on HTTP 400 as an ordinary bad request', async (code, path) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code, message: 'Bad request' }, { status: 400 })),
    )
    const error = await apiFetch(path, { method: 'POST' }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(HttpError)
    expect(isAuthRateLimited(error)).toBe(false)
    expect(isRateLimited(error)).toBe(false)
    expect(authChangePasswordErrorMessage(error, en, () => en.error)).toBe(en.changePasswordWrong)
  })
})

describe('isRateLimited', () => {
  it('detects HttpError 429 or ApiError RATE_LIMITED', () => {
    expect(isRateLimited(apiErr(429, 'RATE_LIMITED'))).toBe(true)
    expect(isRateLimited(apiErr(429, 'INTERNAL_ERROR'))).toBe(true)
    expect(isRateLimited(apiErr(401, 'RATE_LIMITED'))).toBe(true)
    expect(isRateLimited(new HttpError(429))).toBe(true)
    expect(isRateLimited(new HttpError(401))).toBe(false)
    expect(isRateLimited(apiErr(401, 'UNAUTHORIZED'))).toBe(false)
    expect(isRateLimited(new Error('nope'))).toBe(false)
  })
})

describe('isServerError', () => {
  it('detects empty-body HttpError 500 as server error', () => {
    expect(isServerError(new HttpError(500))).toBe(true)
  })

  it('detects kit ApiError 500 / INTERNAL_ERROR', () => {
    expect(
      isServerError(
        new ApiError(500, {
          error: { code: 'INTERNAL_ERROR', message: 'x' },
          requestId: 'r',
        }),
      ),
    ).toBe(true)
  })

  it('does not treat 429 or 400 as server error', () => {
    expect(isServerError(new HttpError(429))).toBe(false)
    expect(isServerError(new HttpError(400))).toBe(false)
  })

  it('treats status-less failures as fail-closed server error', () => {
    expect(isServerError(new Error('network down'))).toBe(true)
  })

  it('is false for null', () => {
    expect(isServerError(null)).toBe(false)
  })
})

describe('changePasswordErrorMessage', () => {
  it('maps 401 / UNAUTHORIZED → reauth', () => {
    expect(changePasswordErrorMessage(apiErr(401, 'UNAUTHORIZED'), en)).toBe(
      en.changePasswordReauth,
    )
    expect(changePasswordErrorMessage(new HttpError(401), en)).toBe(en.changePasswordReauth)
  })

  it('maps 400 → wrong current password', () => {
    expect(changePasswordErrorMessage(apiErr(400, 'VALIDATION_ERROR'), en)).toBe(
      en.changePasswordWrong,
    )
    expect(changePasswordErrorMessage(new HttpError(400), en)).toBe(en.changePasswordWrong)
  })

  it('maps 403 → reauth (not wrong password)', () => {
    expect(changePasswordErrorMessage(apiErr(403, 'FORBIDDEN'), en)).toBe(en.changePasswordReauth)
    expect(changePasswordErrorMessage(new HttpError(403), en)).toBe(en.changePasswordReauth)
  })

  it('maps 429 → rate limited', () => {
    expect(changePasswordErrorMessage(apiErr(429, 'RATE_LIMITED'), en)).toBe(en.errRateLimited)
    expect(changePasswordErrorMessage(new HttpError(429), en)).toBe(en.errRateLimited)
  })
})

describe('profileErrorMessage', () => {
  it('never returns change-password copy', () => {
    const cases: unknown[] = [
      apiErr(400, 'VALIDATION_ERROR'),
      apiErr(401, 'UNAUTHORIZED'),
      apiErr(403, 'FORBIDDEN'),
      new HttpError(400),
      new HttpError(401),
    ]
    for (const err of cases) {
      const msg = profileErrorMessage(err, en)
      expect(msg).not.toBe(en.changePasswordWrong)
      expect(msg).not.toBe(en.changePasswordReauth)
    }
  })

  it('maps 400 → validation, 401 → unauthorized, 429 → rate limited', () => {
    expect(profileErrorMessage(apiErr(400, 'VALIDATION_ERROR'), en)).toBe(en.errValidation)
    expect(profileErrorMessage(new HttpError(400), en)).toBe(en.errValidation)
    expect(profileErrorMessage(apiErr(401, 'UNAUTHORIZED'), en)).toBe(en.errUnauthorized)
    expect(profileErrorMessage(apiErr(429, 'RATE_LIMITED'), en)).toBe(en.errRateLimited)
    expect(profileErrorMessage(new HttpError(429), en)).toBe(en.errRateLimited)
  })

  it('maps empty-body HTTP 500 and status-less failures to catalog internal copy', () => {
    expect(profileErrorMessage(new HttpError(500), en)).toBe(en.errInternal)
    expect(profileErrorMessage(new Error('network down'), en)).toBe(en.errInternal)
    expect(profileErrorMessage(apiErr(500, 'INTERNAL_ERROR'), en)).toBe(en.errInternal)
  })
})

describe('loginErrorMessage', () => {
  // UI residual collapse for non-kit envelopes; wire anti-enum = example-api sign-in-anti-enum.
  it('maps 400/401/403 ApiError and HttpError → same loginFailed (wire + UI anti-enum)', () => {
    expect(loginErrorMessage(apiErr(401, 'UNAUTHORIZED'), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(new HttpError(401), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(apiErr(400, 'VALIDATION_ERROR'), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(new HttpError(400), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(apiErr(403, 'FORBIDDEN'), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(new HttpError(403), en)).toBe(en.loginFailed)
    expect(loginErrorMessage(apiErr(401, 'UNAUTHORIZED'), en)).not.toBe(en.errUnauthorized)
  })

  it('maps 429 → rate limited only', () => {
    expect(loginErrorMessage(apiErr(429, 'RATE_LIMITED'), en)).toBe(en.errRateLimited)
    expect(loginErrorMessage(new HttpError(429), en)).toBe(en.errRateLimited)
  })

  it('maps 5xx and status-less failures to errInternal (never HTTP 5xx toast)', () => {
    expect(loginErrorMessage(new HttpError(500), en)).toBe(en.errInternal)
    expect(loginErrorMessage(apiErr(503, 'INTERNAL_ERROR'), en)).toBe(en.errInternal)
    expect(loginErrorMessage(new Error('network down'), en)).toBe(en.errInternal)
  })

  it('never returns change-password or session-expired copy on failed sign-in', () => {
    const cases: unknown[] = [
      apiErr(400, 'VALIDATION_ERROR'),
      apiErr(401, 'UNAUTHORIZED'),
      apiErr(403, 'FORBIDDEN'),
      new HttpError(401),
      new HttpError(403),
    ]
    for (const err of cases) {
      const msg = loginErrorMessage(err, en)
      expect(msg).toBe(en.loginFailed)
      expect(msg).not.toBe(en.changePasswordWrong)
      expect(msg).not.toBe(en.changePasswordReauth)
      expect(msg).not.toBe(en.errUnauthorized)
    }
  })
})

describe('signupErrorMessage', () => {
  it('collapses 400/401/409/422 to the same signUpFailed copy', () => {
    expect(signupErrorMessage(apiErr(400, 'VALIDATION_ERROR'), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(new HttpError(400), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(apiErr(409, 'CONFLICT'), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(new HttpError(409), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(apiErr(422, 'VALIDATION_ERROR'), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(new HttpError(422), en)).toBe(en.signUpFailed)
    expect(signupErrorMessage(apiErr(401, 'UNAUTHORIZED'), en)).toBe(en.signUpFailed)
  })

  it('maps 403 → signUpDisabled and 429 → rate limited', () => {
    expect(signupErrorMessage(apiErr(403, 'FORBIDDEN'), en)).toBe(en.signUpDisabled)
    expect(signupErrorMessage(new HttpError(403), en)).toBe(en.signUpDisabled)
    expect(signupErrorMessage(apiErr(429, 'RATE_LIMITED'), en)).toBe(en.errRateLimited)
    expect(signupErrorMessage(new HttpError(429), en)).toBe(en.errRateLimited)
  })

  it('maps 5xx and status-less failures to errInternal (never HTTP 5xx toast)', () => {
    expect(signupErrorMessage(new HttpError(500), en)).toBe(en.errInternal)
    expect(signupErrorMessage(apiErr(502, 'INTERNAL_ERROR'), en)).toBe(en.errInternal)
    expect(signupErrorMessage(new Error('network down'), en)).toBe(en.errInternal)
  })

  it('never uses login or change-password copy', () => {
    const msg = signupErrorMessage(apiErr(400, 'VALIDATION_ERROR'), en)
    expect(msg).not.toBe(en.loginFailed)
    expect(msg).not.toBe(en.changePasswordWrong)
    expect(msg).not.toBe(en.errUnauthorized)
  })
})
