/**
 * The launch every lane recipe (`validate:full`, `validate:tooling`) starts with. Every task
 * inherits the runner's environment, so the runner loads neither a cwd `.env` nor a cwd
 * `bunfig.toml` preload: either could otherwise re-point a gate scanner through its `*_ROOT`
 * override (go-silex/unkillable-kit#242).
 */
export const rootGateLaunch =
  'bun --no-env-file --config=config/kit/bunfig.gates.toml run scripts/kit/root-gate.ts'

/** The tasks of a lane recipe: the words after the runner script, whatever launch precedes it. */
export function recipeTasks(source: string): string[] {
  const words = source.split(' ')
  const runner = words.indexOf('scripts/kit/root-gate.ts')
  return runner === -1 ? [] : words.slice(runner + 1)
}
