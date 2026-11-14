import { describe, expect, it } from 'vitest'
import { keyScopeRoutes } from '../middleware/key-scopes'
import { mintApiKey } from '../services/auth'
import { bearerHeaders, createSeededDemoApi } from './api-fixture'

const ORG = 'org_acme'
const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const

describe('API key route contract', () => {
  it('aligns OpenAPI API-key security with the exact scope gate declarations', async () => {
    const { app } = await createSeededDemoApi({ seed: { notes: true, environment: 'test' } })
    const document = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'Example API', version: '1.0.0' },
    })
    const advertised = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      methods.flatMap((method) =>
        item?.[method]?.security?.some((requirement) => 'apiKey' in requirement)
          ? [`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`]
          : [],
      ),
    )
    const declared = keyScopeRoutes.map(({ method, path }) => `${method} ${path}`)
    expect(new Set(declared).size).toBe(declared.length)
    expect(advertised.sort()).toEqual(declared.sort())
  })

  it('permits a read-scoped key to list task links without granting write scope', async () => {
    const { app, env, db } = await createSeededDemoApi({
      seed: { notes: true, environment: 'test' },
    })
    const read = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['read'] })
    const write = await mintApiKey(db, 'user_staff', { organizationId: ORG, scopes: ['write'] })
    expect(
      (await app.request('/api/tasks/links', { headers: bearerHeaders(read.key, ORG) }, env))
        .status,
    ).toBe(200)
    expect(
      (await app.request('/api/tasks/links', { headers: bearerHeaders(write.key, ORG) }, env))
        .status,
    ).toBe(403)
    expect(
      (
        await app.request(
          '/api/jobs/ping',
          { method: 'POST', headers: bearerHeaders(read.key, ORG) },
          env,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          '/api/jobs/ping',
          { method: 'POST', headers: bearerHeaders(write.key, ORG) },
          env,
        )
      ).status,
    ).toBe(200)
  })
})
