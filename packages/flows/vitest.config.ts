import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: makeCoverage('flows', {
      statements: 80,
      lines: 80,
      branches: 70,
      functions: 80,
    }),
  },
})
