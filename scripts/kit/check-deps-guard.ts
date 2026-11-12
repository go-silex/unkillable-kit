#!/usr/bin/env bun
/**
 * check-deps-guard — supply-chain guard for auto-merged Dependabot PRs.
 *
 *   --repo owner/name --pr N --repository-id ID --pull-request-id ID
 *     --head SHA --base SHA --base-ref REF   judge that captured PR snapshot through GitHub.
 *   --pr-evaluate                   emit one bounded machine JSON line; no head code is run.
 *   --base-lock F --head-lock G     judge two bun.lock files (npm rules only; no GitHub access).
 *   --cooldown-seconds N            default: `[install] minimumReleaseAge` of bunfig.toml (SSoT).
 *   --json FILE / --markdown FILE   write the verdict / the PR comment body.
 *
 * Human mode exit: 0 PASS · 2 WITHHOLD · 1 error. Machine mode: 0 for a verdict, 1 for error.
 * Launch with `bun --no-env-file --config=config/kit/bunfig.gates.toml` like every kit gate.
 * Rules and rationale: docs/kit/security-dependabot.md § Auto-merge guard.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitHubApi } from './deps-guard/github.ts'
import { at } from './deps-guard/json.ts'
import { evaluateLockChange } from './deps-guard/npm-rules.ts'
import { evaluatePr, type PrVerdict } from './deps-guard/pr.ts'
import { createNpmRegistry } from './deps-guard/registry.ts'
import { renderComment, renderText } from './deps-guard/report.ts'
import type { Verdict } from './deps-guard/types.ts'

const ROOT = join(import.meta.dirname, '../..')

function fail(message: string): never {
  console.error(`check-deps-guard: ${message}`)
  process.exit(1)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

function bunfigCooldownSeconds(): number {
  const age = at(
    Bun.TOML.parse(readFileSync(join(ROOT, 'bunfig.toml'), 'utf8')),
    'install',
    'minimumReleaseAge',
  )
  if (typeof age !== 'number' || !(age > 0))
    fail('bunfig.toml has no positive [install] minimumReleaseAge')
  return age
}
function emitMachineVerdict(result: PrVerdict): never {
  const report = renderComment(result, result.snapshot.headSha).slice(0, 8000)
  console.log(
    JSON.stringify({
      verdict: result.verdict === 'PASS' ? 'ALLOW' : 'WITHHOLD',
      ...result.snapshot,
      report,
    }),
  )
  process.exit(0)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cooldownArg = flag(args, '--cooldown-seconds')
  const cooldownSeconds = cooldownArg === undefined ? bunfigCooldownSeconds() : Number(cooldownArg)
  if (!(cooldownSeconds >= 0)) fail('--cooldown-seconds must be a number >= 0')
  const registry = createNpmRegistry()
  const now = new Date()

  const repo = flag(args, '--repo')
  const pr = flag(args, '--pr')
  const baseLock = flag(args, '--base-lock')
  const headLock = flag(args, '--head-lock')
  let verdict: Verdict
  let headSha: string | undefined
  if (repo && pr) {
    const api = createGitHubApi(process.env.GITHUB_TOKEN)
    const required = (name: string) =>
      flag(args, name) ?? fail(`${name} is required for PR evaluation`)
    const snapshot = {
      repositoryId: Number(required('--repository-id')),
      pullRequestId: Number(required('--pull-request-id')),
      pullRequest: Number(pr),
      headSha: required('--head'),
      baseSha: required('--base'),
      baseRef: required('--base-ref'),
    }
    const result = await evaluatePr({
      repo,
      snapshot,
      cooldownSeconds,
      now,
      registry,
      api,
      readOwnershipPolicy: () =>
        readFileSync(join(ROOT, 'config/kit/zero-edit-zones.json'), 'utf8'),
    })
    verdict = result
    headSha = result.snapshot.headSha
    if (args.includes('--pr-evaluate')) emitMachineVerdict(result)
  } else if (baseLock && headLock) {
    if (args.includes('--pr-evaluate')) fail('--pr-evaluate requires a PR snapshot')
    verdict = await evaluateLockChange(
      readFileSync(baseLock, 'utf8'),
      readFileSync(headLock, 'utf8'),
      {
        registry,
        cooldownSeconds,
        now,
      },
    )
  } else {
    fail('usage: --repo owner/name --pr N  |  --base-lock FILE --head-lock FILE')
  }

  console.log(renderText(verdict))
  const json = flag(args, '--json')
  if (json) writeFileSync(json, `${JSON.stringify(verdict, null, 2)}\n`)
  const markdown = flag(args, '--markdown')
  if (markdown) writeFileSync(markdown, `${renderComment(verdict, headSha)}\n`)
  process.exit(verdict.verdict === 'PASS' ? 0 : 2)
}

main().catch((e: unknown) => fail((e as Error).stack ?? String(e)))
