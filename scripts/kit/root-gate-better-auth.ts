import { resolve } from 'node:path'
import { discoverBetterAuthApps } from './root-gate-better-auth-apps'
import { runBetterAuthDifferential } from './root-gate-better-auth-fixtures'
import { readBetterAuthLock } from './root-gate-better-auth-lock'

try {
  const root = resolve(import.meta.dirname, '../..')
  const version = readBetterAuthLock(root)
  const apps = await discoverBetterAuthApps(root, version)
  for (const app of apps) {
    await runBetterAuthDifferential(app)
    console.log(`better-auth:check: ${app.workspace} differential fixtures passed (${version})`)
  }
  console.log(`better-auth:check: ${apps.length} shipping App composition(s) checked`)
} catch (error) {
  console.error('better-auth:check:', error)
  process.exitCode = 1
}
