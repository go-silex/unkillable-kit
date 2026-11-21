import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

export default defineConfig({
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: makeCoverage('db', {
      statements: 70,
      lines: 70,
      branches: 50,
      functions: 50,
    }),
  },
})
