import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import {
  type BundleInputs,
  type BundleOutputs,
  bundleInputContributions,
} from './root-gate-better-auth-build.ts'
import { indexServerEntrypoints } from './root-gate-better-auth-entries.ts'
import type { AttestedCallee } from './root-gate-better-auth-namespace.ts'
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

function readUpload(upload: string) {
  const bytes = readFileSync(upload)
  const end = bytes.indexOf('\r\n')
  const boundary = end > 2 && end <= 72 && bytes.toString('ascii', 0, end).match(/^--([-\w]+)$/)
  if (!boundary) throw new Error('Wrangler did not emit a recognizable multipart Worker upload')
  return new Response(bytes, {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary[1]}` },
  }).formData()
}

function isExecutable(part: string | File): part is File {
  return typeof part !== 'string' && /^application\/javascript(?:\+module)?$/.test(part.type)
}

function assertInspectableModule(app: string, entry: string, module: string, source: string) {
  if (
    existsSync(source) &&
    !generatedDirectory.test(relative(app, source)) &&
    !generatedDirectory.test(relative(app, realpathSync(source)))
  ) {
    return
  }
  throw new Error(
    `Cannot inventory opaque Worker inputs for ${entry}: use transparent modules outside dist/build instead of ${module}`,
  )
}

async function stagedIssuer(module: string, source: File) {
  const languagePath = runtimeExtension.test(module) ? module : `${module}.js`
  if (importsServerFactory(parseProgram(languagePath, await source.text()))) return module
}

export async function inspectStagedModules(
  upload: string,
  build: string,
  app: string,
  target: { entry: string; moduleRoot: string },
  outputs?: BundleOutputs,
) {
  // The dry-run upload classifies modules by executable MIME type, not filename extension.
  const modules = await readUpload(upload)
  const { entry, moduleRoot } = target
  const entryName = basename(entry)
  if (!(outputs || modules.has(entryName))) {
    throw new Error(`Wrangler did not emit the unbundled Worker entrypoint ${entry}`)
  }
  const bundled = new Set(Object.keys(outputs ?? {}).map((file) => resolve(app, file)))
  // Wrangler bundles the main in a temporary directory before copying it to --outdir.
  if (outputs) bundled.add(join(build, `${entryName.replace(runtimeExtension, '')}.js`))
  let firstIssuer: string | undefined
  for (const [module, file] of modules) {
    if (!isExecutable(file) || bundled.has(resolve(build, module))) continue
    const source = outputs || module !== entryName ? resolve(moduleRoot, module) : entry
    assertInspectableModule(app, entry, module, source)
    firstIssuer ??= await stagedIssuer(module, file)
  }
  return firstIssuer
}

export function inspectWranglerInputs(
  app: string,
  workspaceRoots: readonly string[],
  inputs: BundleInputs,
  outputs: BundleOutputs,
  enrolled?: { file: string; callee: AttestedCallee },
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
      !inspectableInput(file, workspaceRoots, contributions.get(input)) ||
      entries.isSDKFile(file)
    ) {
      continue
    }
    if (firstIssuer) continue
    const factories = resolvedFactories(imports)
    if (
      factories.size &&
      importsServerFactory(
        parseProgram(file),
        (source) => factories.get(source),
        enrolled?.file === file ? enrolled.callee : undefined,
      )
    ) {
      firstIssuer = file
    }
  }
  return firstIssuer
}
