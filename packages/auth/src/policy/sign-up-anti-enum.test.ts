import { describe, expect, it } from 'vitest'
import { isEmailSignUpPath, normalizeEmailSignUpResponse } from './sign-up-anti-enum'

function req(path: string, method = 'POST') {
  return new Request(`http://localhost${path}`, { method })
}

describe('normalizeEmailSignUpResponse', () => {
  it('only targets POST /api/auth/sign-up/email', () => {
    expect(isEmailSignUpPath('/api/auth/sign-up/email')).toBe(true)
    expect(isEmailSignUpPath('/api/auth/sign-up/email/')).toBe(true)
    expect(isEmailSignUpPath('/api/auth/sign-in/email')).toBe(false)
  })

  it('passes through success and rate-limit (cookies intact)', async () => {
    const ok = new Response('{}', { status: 200, headers: { 'set-cookie': 'session=1' } })
    const outOk = await normalizeEmailSignUpResponse(req('/api/auth/sign-up/email'), ok, 'req_1')
    expect(outOk).toBe(ok)
    expect(outOk.headers.get('set-cookie')).toBe('session=1')

    const rl = new Response('slow down', { status: 429 })
    expect(await normalizeEmailSignUpResponse(req('/api/auth/sign-up/email'), rl, 'req_2')).toBe(rl)
  })

  it('maps BA disabled to 403 FORBIDDEN kit (no Set-Cookie)', async () => {
    const raw = new Response(JSON.stringify({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' }), {
      status: 400,
      headers: { 'set-cookie': 'should-not-leak=1' },
    })
    const out = await normalizeEmailSignUpResponse(req('/api/auth/sign-up/email'), raw, 'req_d')
    expect(out.status).toBe(403)
    const body = (await out.json()) as { error: { code: string }; requestId: string }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.requestId).toBe('req_d')
    expect(out.headers.get('set-cookie')).toBeNull()
  })

  it('collapses 422 exists and 400 validation to the same 400 kit envelope', async () => {
    const exists = new Response(JSON.stringify({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }), {
      status: 422,
    })
    const short = new Response(JSON.stringify({ code: 'PASSWORD_TOO_SHORT' }), { status: 400 })
    const a = await normalizeEmailSignUpResponse(req('/api/auth/sign-up/email'), exists, 'req_a')
    const b = await normalizeEmailSignUpResponse(req('/api/auth/sign-up/email'), short, 'req_b')
    expect(a.status).toBe(400)
    expect(b.status).toBe(400)
    const bodyA = (await a.json()) as { error: { code: string; message: string } }
    const bodyB = (await b.json()) as { error: { code: string; message: string } }
    expect(bodyA.error).toEqual(bodyB.error)
    expect(bodyA.error.code).toBe('VALIDATION_ERROR')
    expect(a.headers.get('set-cookie')).toBeNull()
  })

  it('does not rewrite sign-in', async () => {
    const res = new Response('x', { status: 400 })
    const out = await normalizeEmailSignUpResponse(req('/api/auth/sign-in/email'), res, 'req_x')
    expect(out).toBe(res)
  })
})
