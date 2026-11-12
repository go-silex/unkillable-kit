#!/usr/bin/env node
'use strict'

const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, lstatSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

try {
  const root = resolve(__dirname, '../..')
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const zones = JSON.parse(readFileSync(join(root, 'config/kit/zero-edit-zones.json'), 'utf8'))
  const marker = JSON.parse(readFileSync(join(root, zones.inheritance_file), 'utf8'))
  const mergeHead = git('rev-parse', '--git-path', 'MERGE_HEAD')
  if (existsSync(resolve(root, mergeHead)))
    throw new Error('finish and commit the merge before generating')
  const committedMarker = git('show', `HEAD:${zones.inheritance_file}`)
  if (
    committedMarker !== readFileSync(join(root, zones.inheritance_file), 'utf8').trim() ||
    git('diff', '--cached', '--name-only', '--', zones.inheritance_file)
  )
    throw new Error('commit the inheritance marker before generating')
  let origin = ''
  try {
    origin = git('remote', 'get-url', 'origin')
      .replace(/\.git$/, '')
      .replace(/^git@github\.com:/, '')
      .replace(/^https:\/\/github\.com\//, '')
  } catch {}
  const identity = (process.env.GITHUB_REPOSITORY || origin).trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(identity) || zones.kit_origin_allowlist.includes(identity))
    throw new Error('real non-Kit Product repository identity required')
  const env = {
    ...process.env,
    ZERO_EDIT_MODE: '',
    ZERO_EDIT_HARNESS_SENTINEL: '',
    ZERO_EDIT_ROOT: root,
    ZERO_EDIT_ZONES_FILE: 'config/kit/zero-edit-zones.json',
  }
  execFileSync(
    'bash',
    [join(root, 'scripts/kit/check-zero-edit-zones.sh'), '--product-dependabot-preflight'],
    { cwd: root, env, stdio: 'inherit' },
  )
  const {
    productManifestDirectories,
    renderProductDependabot,
  } = require('./lib/product-dependabot.cjs')
  const base = marker.upstreamCommit.trim()
  const protectedManifest = (p) =>
    p === 'package.json' ||
    ((zones.protected_files.includes(p) || zones.protected_prefixes.some((x) => p.startsWith(x))) &&
      p.endsWith('/package.json'))
  const paths = new Set()
  for (const args of [
    ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'],
    ['diff', '--no-renames', '--name-only', '-z', 'HEAD'],
    ['diff', '--no-renames', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    for (const p of execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0'))
      if (p) paths.add(p)
  }
  if ([...paths].some(protectedManifest))
    throw new Error('protected Kit manifests must match the inherited baseline')
  const target = join(root, '.github/dependabot.yml')
  for (const p of [join(root, '.github'), target]) {
    const stat = lstatSync(p)
    if (stat.isSymbolicLink() || (p === target ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('Dependabot path must be a regular file in a regular directory')
  }
  const entry = git('ls-files', '--stage', '--', '.github/dependabot.yml')
  if (!/^100644 [0-9a-f]+ 0\t\.github\/dependabot\.yml$/.test(entry))
    throw new Error('Dependabot file must be tracked as a regular file')
  writeFileSync(target, renderProductDependabot(productManifestDirectories(root, zones)))
  console.log('Generated .github/dependabot.yml; review the whole shared bun.lock on every update.')
} catch (error) {
  console.error(`configure-product-dependabot: ${error.message}`)
  process.exitCode = 1
}
