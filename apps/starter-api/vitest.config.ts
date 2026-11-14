import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../../packages/config/vitest-coverage.mts'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // HTTP integration exercises authentication, tenancy and audit through the shipped app.
    coverage: makeCoverage('starter-api', {
      statements: 70,
      lines: 70,
      branches: 55,
      functions: 70,
    }),
  },
})
