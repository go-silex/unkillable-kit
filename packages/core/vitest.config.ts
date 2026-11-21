import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: makeCoverage('core', {
      statements: 68,
      lines: 69,
      branches: 66,
      functions: 50,
    }),
  },
})
