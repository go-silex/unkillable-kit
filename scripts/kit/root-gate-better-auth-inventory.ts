import { existsSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  type BundleInputs,
  type BundleOutputs,
  bundleInputContributions,
} from './root-gate-better-auth-build.ts'
import { indexServerEntrypoints } from './root-gate-better-auth-entries.ts'
import {
  generatedDirectory,
  importsServerFactory,
  isWithin,
  parseProgram,
  runtimeExtension,
  shippingSource,
} from './root-gate-better-auth-source.ts'

const installedDirectory = /(^|\/)node_modules\//

function inspectableInput(
  file: string,
  workspaceRoots: readonly string[],
  contribution: boolean | undefined,
) {
  if (contribution === undefined || !runtimeExtension.test(file)) return false
  const workspace = workspaceRoots.find((root) => isWithin(relative(root, file)))
  const path = workspace && relative(workspace, file)
  if (!path || installedDirectory.test(path)) return true
  if (generatedDirectory.test(path) && contribution) {
    throw new Error(
      `Cannot inventory opaque Worker inputs: ${file} is a deployed workspace output; use inspectable source outside dist/build`,
    )
  }
  return shippingSource(path)
}

export function inspectWranglerInputs(
  app: string,
  workspaceRoots: readonly string[],
  inputs: BundleInputs,
  outputs: BundleOutputs,
  enrolled?: string,
) {
  const contributions = bundleInputContributions(outputs)
  const entries = indexServerEntrypoints()
  function resolvedFactories(imports: BundleInputs[string]['imports']) {
    const factories = new Map<string, string>()
    for (const edge of imports) {
      if (edge.external || !contributions.has(edge.path)) continue
      const factory = entries.factoryExport(resolve(app, edge.path))
      if (factory) factories.set(edge.original ?? edge.path, factory)
    }
    return factories
  }
  let firstIssuer: string | undefined
  for (const [input, { imports }] of Object.entries(inputs)) {
    const path = resolve(app, input)
    if (!existsSync(path)) continue // Wrangler also reports virtual inputs.
    const file = realpathSync(path)
    if (
      file === enrolled ||
      !inspectableInput(file, workspaceRoots, contributions.get(input)) ||
      entries.isSDKFile(file)
    ) {
      continue
    }
    if (firstIssuer) continue
    const factories = resolvedFactories(imports)
    if (
      factories.size &&
      importsServerFactory(parseProgram(file), (source) => factories.get(source))
    ) {
      firstIssuer = file
    }
  }
  return firstIssuer
}
