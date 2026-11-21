import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/hosted/cloudflare-workers-stub.ts', import.meta.url),
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
    coverage: makeCoverage('mcp', {
      statements: 70,
      lines: 70,
      branches: 50,
      functions: 50,
    }),
  },
})
