import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  // Workers runtime modules (`cloudflare:workers`, `cloudflare:workflows`) are not npm
  // packages: knip reads the scheme-stripped specifier as an undeclared dependency
  // `cloudflare`, and declaring the real npm SDK of that name would be wrong. Ignored for
  // EVERY workspace, product apps and packages included, so no product edit is needed.
  // knip 6.38 mechanism: a top-level list merges into the root workspace
  // (ConfigurationChief.getIgnores), and DependencyDeputy.handleIgnoredDependencies falls
  // back to the root manifest's list for an issue in any other workspace, including one
  // with its own literal `workspaces` key (which does not inherit per-key ignores).
  // The hint "Remove from ignoreDependencies" fires only if NO workspace imports a
  // Workers module (today apps/example-api does).
  ignoreDependencies: ['cloudflare'],
  workspaces: {
    '.': {
      // Shell, workflow and spawn entrypoints Knip's script parser cannot see.
      // package.json exports of @kit/* stay entries via each workspace manifest — do not override those.
      entry: [
        'scripts/kit/configure-product-dependabot.cjs',
        'scripts/kit/lib/product-dependabot.cjs',
        'scripts/kit/extract-compose-proof.ts',
        'scripts/kit/extract-residency.ts',
        'scripts/kit/print-coverage-summary.mjs',
        'scripts/kit/resolve-tree-identity.mjs',
        'scripts/kit/lib/merge-gate.cjs',
        'scripts/kit/lib/head-authorization.cjs',
      ],
      // @commitlint/cli is invoked by path from scripts/kit/lefthook-commit-msg.sh;
      // Knip's Lefthook plugin reads only lefthook.yml `run` strings, not that script.
      ignoreDependencies: ['@commitlint/cli'],
    },
    'apps/example-web': {
      // Public client types/constants for the flows console; call sites land with Roxabi/roxabi-boilerplate-cf#288.
      ignoreIssues: {
        'src/lib/flows.ts': ['exports', 'types'],
      },
    },
    'packages/ui': {
      // Typecheck sentinel for `@/*` without baseUrl. Not a runtime export.
      entry: ['src/paths-smoke.ts'],
    },
  },
}

export default config
