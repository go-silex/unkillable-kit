import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const authRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = resolve(authRoot, '../..')

function linkPackage(root: string, name: string, source: string): void {
  const destination = join(root, 'node_modules', name)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(source, destination, 'dir')
}

describe('factory without the optional OIDC peer', () => {
  it('typechecks and loads in an isolated consumer', () => {
    const project = mkdtempSync(join(tmpdir(), 'kit-auth-consumer-'))
    try {
      const auth = join(project, 'node_modules/@kit/auth')
      mkdirSync(auth, { recursive: true })
      cpSync(join(authRoot, 'package.json'), join(auth, 'package.json'))
      cpSync(join(authRoot, 'src'), join(auth, 'src'), { recursive: true })

      for (const name of ['core', 'db', 'email']) {
        linkPackage(project, `@kit/${name}`, join(repoRoot, 'packages', name))
      }
      for (const name of ['better-auth', 'drizzle-orm', 'zod']) {
        linkPackage(project, name, join(authRoot, 'node_modules', name))
      }

      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ private: true, type: 'module' }),
      )
      writeFileSync(
        join(project, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022', 'DOM'],
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
          },
          files: ['consumer.ts'],
        }),
      )
      writeFileSync(
        join(project, 'consumer.ts'),
        `import { createBetterAuth, type CreateBetterAuthOpts } from '@kit/auth/factory'
const factory: (options: CreateBetterAuthOpts) => unknown = createBetterAuth
if (typeof factory !== 'function') throw new Error('factory did not load')
`,
      )
      // Probe from the copied package itself, not just the consumer. This catches
      // accidental lookup through an ancestor node_modules in either resolver.
      writeFileSync(
        join(auth, 'src/peer-probe.ts'),
        `import type {} from '@better-auth/oauth-provider'
`,
      )
      writeFileSync(
        join(project, 'probe-tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.json',
          files: ['node_modules/@kit/auth/src/peer-probe.ts'],
        }),
      )
      const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
      const env = { ...process.env, NODE_PATH: '', BUN_INSTALL_AUTO: 'disable' }
      const probe = spawnSync(process.execPath, [tsc, '-p', 'probe-tsconfig.json'], {
        cwd: project,
        env,
        encoding: 'utf8',
      })
      expect(probe.status).not.toBe(0)
      expect(probe.stdout + probe.stderr).toContain(
        "Cannot find module '@better-auth/oauth-provider'",
      )
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
        cwd: project,
        env,
        stdio: 'pipe',
      })

      writeFileSync(
        join(auth, 'src/peer-probe-runtime.ts'),
        `try {
  Bun.resolveSync('@better-auth/oauth-provider', import.meta.dir)
  throw new Error('optional provider unexpectedly resolves')
} catch (error) {
  if (!(error instanceof Error) || error.message === 'optional provider unexpectedly resolves') throw error
}
`,
      )
      execFileSync('bun', ['--no-install', 'run', join(auth, 'src/peer-probe-runtime.ts')], {
        cwd: project,
        env,
        stdio: 'pipe',
      })
      execFileSync('bun', ['--no-install', 'run', 'consumer.ts'], {
        cwd: project,
        env,
        stdio: 'pipe',
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
