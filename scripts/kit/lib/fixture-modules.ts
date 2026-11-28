import { mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Gives a fixture the packages installed in `installed`, one link per package. A link to the
 * folder itself would send the caches tools keep under `node_modules` (Vitest, Vite) to the
 * checkout, where fixtures that run together would share them.
 */
export function linkModules(installed: string, target: string) {
  mkdirSync(target)
  for (const name of readdirSync(installed)) {
    if (name === '.bin' || !name.startsWith('.'))
      symlinkSync(join(installed, name), join(target, name), 'dir')
  }
}
