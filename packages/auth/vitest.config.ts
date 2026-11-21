import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { makeCoverage } from '../config/vitest-coverage.mts'
import { ciMaxWorkers } from '../config/vitest-workers.mts'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kit/ui': path.resolve(rootDir, '../ui/src/index.ts'),
    },
  },
  test: {
    maxWorkers: ciMaxWorkers,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/react/test-setup.ts'],
    coverage: makeCoverage('auth', {
      statements: 80,
      lines: 80,
      branches: 70,
      functions: 70,
    }),
  },
})
