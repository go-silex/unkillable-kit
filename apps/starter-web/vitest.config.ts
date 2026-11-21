import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../../packages/config/vitest-coverage.mts'
import { ciMaxWorkers } from '../../packages/config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Smoke tests cover authentication transitions; the browser entry remains unexercised.
    coverage: makeCoverage('starter-web', {
      statements: 50,
      lines: 50,
      branches: 40,
      functions: 50,
    }),
  },
})
