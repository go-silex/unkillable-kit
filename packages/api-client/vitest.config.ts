import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: makeCoverage('api-client', {
      statements: 70,
      lines: 70,
      branches: 60,
      functions: 70,
    }),
  },
})
