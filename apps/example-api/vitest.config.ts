import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
import { ciMaxWorkers } from '../../packages/config/vitest-workers.mts'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/test/cloudflare-workers-stub.ts', import.meta.url),
      ),
      'cloudflare:workflows': fileURLToPath(
        new URL('./src/test/cloudflare-workflows-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Backend kit bar — keep high; raise further when adding domains.
    coverage: makeCoverage('example-api', {
      statements: 78,
      lines: 80,
      branches: 65,
      functions: 75,
    }),
  },
})
