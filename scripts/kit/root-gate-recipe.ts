/**
 * The Bun flags of a gate launch: Bun loads no cwd `.env` and reads the empty gates config
 * instead of the tree's `bunfig.toml`, so neither file can set a variable, run a preload or
 * change how a script runs. The runner and its dispatch of each task use them, because every task
 * inherits their environment: otherwise either file could re-point a gate scanner through its
 * `*_ROOT` override (go-silex/unkillable-kit#242).
 */
export const gateFlags = ['--no-env-file', '--config=config/kit/bunfig.gates.toml']

/** The launch every lane recipe (`validate:full`, `validate:tooling`) starts with. */
export const rootGateLaunch = `bun ${gateFlags.join(' ')} run scripts/kit/root-gate.ts`

/**
 * The environment of a task. Bun reads `BUN_OPTIONS` in every runtime, so `--no-env-file` there
 * keeps a cwd `.env` out of every Bun runtime that the task starts with its inherited environment,
 * whatever the launch. `ROOT_GATE_INVOKER_BUN_OPTIONS` keeps the invoker's own value, for a script
 * that must resolve something exactly as the invoker's own Bun would (`check-lock-ranges.ts`).
 */
export function gateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const invoker = env.ROOT_GATE_INVOKER_BUN_OPTIONS ?? env.BUN_OPTIONS ?? ''
  return {
    ...env,
    ROOT_GATE_INVOKER_BUN_OPTIONS: invoker,
    BUN_OPTIONS: [invoker, '--no-env-file'].filter(Boolean).join(' '),
  }
}

/** The tasks of a lane recipe: the words after the runner script, whatever launch precedes it. */
export function recipeTasks(source: string): string[] {
  const words = source.split(' ')
  const runner = words.indexOf('scripts/kit/root-gate.ts')
  return runner === -1 ? [] : words.slice(runner + 1)
}
