import * as z from 'zod'
import type { CapabilityGrant } from './authority'
import { MAX_ALLOWED_MODELS, MAX_MODEL_ID_CHARS, MAX_PERMIT_TOOLS } from './constants'

const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)

/**
 * Prototype-shaped keys, rejected at the parse boundary below.
 *
 * `.strict()` does not cover `__proto__`: `JSON.parse` creates it as an own enumerable key that
 * zod does not report as unknown. Nothing leaks either way — zod rebuilds a fresh object, so the
 * key never reaches the output — but the rejection contract should say what it does.
 *
 * Anchored deliberately: `constructor` and `prototype` are rejected as whole keys only, so a
 * legitimate `constructorName` is accepted. `assertArgsShape` in `schema.ts` uses an unanchored
 * variant that over-rejects; converging the two is tracked separately.
 */
const FORBIDDEN_GRANT_KEY = /^__|^(?:constructor|prototype)$/i

function findForbiddenKey(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  return Object.getOwnPropertyNames(input).find((k) => FORBIDDEN_GRANT_KEY.test(k))
}

/**
 * Runtime validation for CapabilityGrant (caller-supplied plain objects).
 *
 * Kept a plain object schema so consumers can still compose it (`extend`, `omit`, `shape`…):
 * it is public API of `@kit/flows`. The prototype-key guard lives in `parseCapabilityGrant`,
 * which is the boundary that documents the rejection contract.
 */
export const capabilityGrantSchema = z
  .object({
    orgId: z.string().min(1).max(256),
    allowedTools: z.array(toolNameSchema).max(MAX_PERMIT_TOOLS),
    registryVersion: z.string().min(1).max(256),
    /** Explicit infer capability — never defaulted to true. */
    allowsInfer: z.boolean(),
    /** Minted model ids — required, never defaulted to allow-all. */
    allowedModels: z.array(z.string().min(1).max(MAX_MODEL_ID_CHARS)).max(MAX_ALLOWED_MODELS),
  })
  .strict()

/**
 * Shape validation only. Grant **provenance** is kit-owned (`mintCapabilityGrant` in
 * `mint.ts`); this parse boundary does not mint and does not claim provenance —
 * ADR-0005 D4 § Authority split.
 *
 * @capability flows-grant-parse
 * @tag security
 * @invariant grant-shape-fully-explicit: a CapabilityGrant is accepted only as a strict object with every field explicit — allowsInfer is never defaulted or coerced, unknown and prototype-shaped keys are rejected — ADR-0005 D4 § Authority split
 */
export function parseCapabilityGrant(
  input: unknown,
): { ok: true; grant: CapabilityGrant } | { ok: false; message: string } {
  const forbidden = findForbiddenKey(input)
  if (forbidden !== undefined) {
    return { ok: false, message: `grant key forbidden: ${forbidden}` }
  }
  const r = capabilityGrantSchema.safeParse(input)
  if (!r.success) {
    return {
      ok: false,
      message: r.error.issues.map((i) => i.message).join('; ') || 'grant invalid',
    }
  }
  return {
    ok: true,
    grant: {
      orgId: r.data.orgId,
      allowedTools: [...r.data.allowedTools],
      registryVersion: r.data.registryVersion,
      allowsInfer: r.data.allowsInfer,
      allowedModels: [...r.data.allowedModels],
    },
  }
}
