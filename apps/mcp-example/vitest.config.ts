import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
import { ciMaxWorkers } from '../../packages/config/vitest-workers.mts'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/cloudflare-workers-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        inline: ['@cloudflare/workers-oauth-provider'],
      },
    },
    coverage: makeCoverage('mcp-example', {
      statements: 50,
      lines: 50,
      branches: 40,
      functions: 0,
    }),
  },
})
