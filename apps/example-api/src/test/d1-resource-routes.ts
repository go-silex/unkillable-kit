import { baMember } from '@kit/auth/schema'
import { expect, onTestFinished } from 'vitest'
import { resetIdentityTickets } from '../services/mcp-identity-ticket'
import { createRouteFixture, type Probe } from './d1-route-fixture'

async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

export async function measureResources(record: Set<string>) {
  const { db, env, probe } = await createRouteFixture(record)
  const jobs: unknown[] = []
  Object.assign(env, {
    EMAIL_TRANSPORT: 'log',
    PRESIGN_MODE: 'mock',
    DEMO_QUEUE: {
      async send(message: unknown) {
        jobs.push(message)
      },
    },
  })
  const orgId = 'org_team'
  await db.insert(baMember).values({
    id: 'budget-member',
    organizationId: orgId,
    userId: 'user_demo',
    role: 'member',
    createdAt: new Date(),
  })
  const { id, key } = await responseJson<{ id: string; key: string }>(
    await probe('POST /api/keys', 7, {
      body: { name: 'Budget key', organizationId: orgId, scopes: ['read', 'write'] },
    }),
  )
  await measureDualResources(probe, 'session')
  const keyProbe: Probe = (route, ceiling, options) =>
    probe(route, ceiling, {
      ...options,
      variant: 'api-key',
      headers: { authorization: `Bearer ${key}`, 'X-Org-Id': orgId },
    })
  await measureDualResources(keyProbe, 'api-key')
  expect(jobs).toMatchObject([
    { type: 'demo.ping', subject: 'user_demo' },
    { type: 'demo.ping', subject: 'user_demo' },
  ])
  await probe('DELETE /api/keys/:id', 3, { path: `/api/keys/${id}` })

  onTestFinished(resetIdentityTickets)
  const resume = 'http://127.0.0.1:8788/authorize?client_id=c1&state=s1'
  const minted = await probe('GET /api/mcp-identity/ticket', 1, {
    path: `/api/mcp-identity/ticket?resume=${encodeURIComponent(resume)}`,
    status: 302,
  })
  const ticket = new URL(minted.headers.get('location')!).searchParams.get('mcp_identity_ticket')
  expect(ticket).toBeTruthy()
  const redeemed = await probe('POST /api/mcp-identity/ticket/redeem', 1, {
    headers: { cookie: '' },
    body: { ticket },
  })
  expect(await redeemed.json()).toMatchObject({ userId: 'user_demo' })
}

async function measureDualResources(probe: Probe, credential: 'session' | 'api-key') {
  const profile = await probe('GET /api/me', 3)
  expect(await profile.json()).toMatchObject({
    subject: 'user_demo',
    authMethod: credential === 'session' ? 'session' : 'api_key',
  })
  await probe('GET /api/keys', 2)
  await probe('GET /api/notes', 2)
  const { note } = await responseJson<{ note: { id: string } }>(
    await probe('POST /api/notes', 2, {
      body: { title: 'Budget note', attachmentText: 'Fixture attachment' },
      status: 201,
    }),
  )
  await probe('GET /api/notes/:id', 2, { path: `/api/notes/${note.id}` })
  await probe('DELETE /api/notes/:id', 3, { path: `/api/notes/${note.id}` })
  await probe('GET /api/items', 2)
  const { item } = await responseJson<{ item: { id: string } }>(
    await probe('POST /api/items', 3, {
      body: { code: 'budget-item', label: 'Budget item' },
      status: 201,
    }),
  )
  const itemPath = `/api/items/${item.id}`
  await probe('GET /api/items/:id', 2, { path: itemPath })
  await probe('PATCH /api/items/:id', 4, { path: itemPath, body: { label: 'Updated' } })
  await probe('DELETE /api/items/:id', 3, { path: itemPath })
  const upload = await responseJson<{ uploadId: string; key: string }>(
    await probe('POST /api/uploads/presign', 1, {
      body: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 },
      status: 201,
    }),
  )
  await probe('POST /api/uploads/:uploadId/complete', 1, {
    path: `/api/uploads/${upload.uploadId}/complete`,
    body: { key: upload.key },
  })
  const job = await probe('POST /api/jobs/ping', 1, { status: 202 })
  expect(await job.json()).toMatchObject({ enqueued: true })
  await probe('POST /api/demo/email', 3)
}
