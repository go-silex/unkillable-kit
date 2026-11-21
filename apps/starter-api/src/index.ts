import { createSiteFetch } from '@kit/core'
import { createApp } from './app'
import type { Env } from './platform/types'

const app = createApp()

export default {
  fetch: createSiteFetch<Env & { ASSETS?: Fetcher }, ExecutionContext>({
    api: (request, env, ctx) => app.fetch(request, env, ctx),
    assets: (env) => env.ASSETS,
  }),
}
