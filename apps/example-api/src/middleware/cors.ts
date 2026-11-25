import { cors } from 'hono/cors'
import { corsAllowlist } from '../lib/session-env'

export const corsMiddleware = cors({
  origin: (origin, c) => {
    const list = corsAllowlist(c.env)
    if (!origin) return list[0]
    return list.includes(origin) ? origin : null
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'X-Org-Id', 'X-Impersonation-Id'],
  // SPA must be able to read Retry-After on 429 (credentials + expose).
  exposeHeaders: ['x-request-id', 'Retry-After'],
})
