import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerTarget } from './root-gate-better-auth-worker'

export type BundleInputs = Record<
  string,
  { imports: { original?: string; path: string; external?: boolean }[] }
>
export type BundleOutputs = Record<string, { inputs: Record<string, { bytesInOutput: number }> }>

export function bundleInputContributions(outputs: BundleOutputs) {
  // A linked barrel can contribute zero bytes; absence means the whole input was shaken out.
  const contributions = new Map<string, boolean>()
  for (const output of Object.values(outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (!contributions.get(input)) contributions.set(input, bytesInOutput > 0)
    }
  }
  return contributions
}

export function bundleWorker(
  node: string,
  wrangler: string,
  dir: string,
  target: WorkerTarget,
  scratch: string,
  hook?: string,
) {
  const build = join(scratch, 'build')
  const upload = join(scratch, 'release.multipart')
  const metafile = join(scratch, 'bundle.json')
  const emptyEnv = join(scratch, 'empty.env')
  mkdirSync(build)
  writeFileSync(emptyEnv, '')
  const bundled = spawnSync(
    node,
    [
      ...(hook ? ['--require', hook] : []),
      wrangler,
      'deploy',
      '--dry-run',
      '--no-autoconfig',
      '--config',
      target.config,
      '--env-file',
      emptyEnv,
      ...(target.env ? ['--env', target.env] : []),
      '--outdir',
      build,
      '--outfile',
      upload,
      '--metafile',
      metafile,
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      },
    },
  )
  if (bundled.error) throw bundled.error
  const label = `${target.config}${target.env ? ` --env ${target.env}` : ''}`
  assert.equal(
    bundled.status,
    0,
    `Wrangler could not build release entrypoint ${label}:\n${bundled.stdout}${bundled.stderr}`,
  )
  assert.ok(existsSync(upload), `Wrangler did not emit the release upload for ${label}`)
  if (target.noBundle) return { build, upload, emptyEnv, inputs: undefined, outputs: undefined }
  assert.ok(existsSync(metafile), `Wrangler did not report the release input graph for ${label}`)
  const { inputs, outputs }: { inputs: BundleInputs; outputs: BundleOutputs } = JSON.parse(
    readFileSync(metafile, 'utf8'),
  )
  return { build, upload, emptyEnv, inputs, outputs }
}
