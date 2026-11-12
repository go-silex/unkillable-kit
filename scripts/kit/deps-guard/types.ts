/** Shared shapes of the dependency supply-chain guard (docs/kit/security-dependabot.md). */

export type ReasonCode =
  | 'PROVENANCE_DOWNGRADE'
  | 'PUBLISHER_CHANGE'
  | 'NEW_INSTALL_SCRIPT'
  | 'NEW_PACKAGE_INSTALL_SCRIPT'
  | 'TOO_YOUNG'
  | 'NON_REGISTRY'
  | 'INTEGRITY_CHANGED'
  | 'ADVISORY'
  | 'METADATA_UNAVAILABLE'
  | 'REGENERATE_TYPES'
  | 'ACTION_IMPOSTOR'
  | 'ACTION_UNPINNED'
  | 'WORKFLOW_BEYOND_PINS'
  | 'UNEXPECTED_FILE'
  | 'FOREIGN_COMMIT'
  | 'OWNERSHIP_UNAVAILABLE'
  | 'KIT_PATH'

export type Reason = { code: ReasonCode; subject: string; detail: string }

export type Verdict = { verdict: 'PASS' | 'WITHHOLD'; reasons: Reason[]; checked: string[] }

/** Lifecycle scripts that run on install (npm `scripts`). */
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const

/** What the registry says about one published version. */
export type VersionMeta = {
  /** ISO publish time from the packument `time` map; undefined when the registry gave none. */
  published: string | undefined
  /** `_npmUser.name` ('GitHub Actions' for trusted publishing). */
  publisher: string | undefined
  /** `_npmUser.trustedPublisher.oidcConfigId` — which repo/workflow config published. */
  oidcConfig: string | undefined
  /** `dist.attestations` present (npm provenance). */
  attested: boolean
  /** Normalized `host/owner/repo` of the packument `repository` field (version's, else the package's). */
  repository: string | undefined
  /** The preinstall/install/postinstall commands of the version. */
  installScripts: Record<string, string>
}

export type Advisory = { id: string; url: string; title: string; severity: string; range: string }

/** Source repository an npm provenance attestation names; `why` says what is missing otherwise. */
type Provenance = { repo: string; why: undefined } | { repo: undefined; why: string }

export interface Registry {
  /** undefined = the registry has no such name/version (or the call failed after retries). */
  version(name: string, version: string): Promise<VersionMeta | undefined>
  /** Source repository of the version's provenance attestation. Never throws: a failure is `why`. */
  provenance(name: string, version: string): Promise<Provenance>
  /** Advisories (any severity) matching at least one of the queried versions, per package. */
  advisories(pkgs: ReadonlyMap<string, readonly string[]>): Promise<Map<string, Advisory[]>>
}

/** One resolved package instance of bun.lock. */
export type LockPackage = {
  key: string
  name: string
  version: string
  /** Why this entry is not a plain default-registry package; undefined when it is one. */
  nonRegistry: string | undefined
  integrity: string | undefined
}
