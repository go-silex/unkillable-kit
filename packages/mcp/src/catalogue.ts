import type * as z from 'zod'
import { checkInputBudget } from './budget'
import { PublicToolError, stableJsonWire, toPublicToolError } from './publicErrors'

/**
 * Descriptive only — NEVER authorization. `registerAll` must not branch on it.
 * Not the flows authority class: `@kit/flows` `ToolGrantClass` (`packages/flows/src/registry.ts`)
 * decides what a Capability Grant may ever allow. Same words, opposite authority status — hence
 * two field names, `effect` here and `grantClass` there (Roxabi/roxabi-boilerplate-cf#243).
 */
export type ToolEffect = 'read' | 'write'

/** Descriptive only — NEVER authorization; real auth stays in handler / API. */
export type ToolAuthHint = 'none' | 'api_key'

export type ToolContext = {
  /** Reserved for app-supplied env-derived data; package does not log secrets. */
  env?: Record<string, string | undefined>
}
const refusalBrand: unique symbol = Symbol('toolRefusal')

/** Explicit domain refusal; its payload is intended for the MCP client. */
export type ToolRefusal<T extends Record<string, unknown> = Record<string, unknown>> = {
  readonly [refusalBrand]: true
  readonly payload: T
}

/** Return a client-safe JSON object as a tool error, not an infrastructure exception. */
export function toolRefusal<T extends Record<string, unknown>>(payload: T): ToolRefusal<T> {
  return { [refusalBrand]: true, payload }
}

/**
 * Typed tool definition for createToolCatalogue.
 * `effect` / `auth` are metadata only — registerAll must not branch on them.
 * Use ZodTypeAny so app ToolDefs are assignable without variance fights.
 */
export type ToolDef = {
  name: string
  description: string
  input: z.ZodTypeAny
  output?: z.ZodTypeAny
  effect?: ToolEffect
  auth?: ToolAuthHint
  /**
   * Handler body. Catalogue always passes Zod-parsed `input` (unknown after ZodTypeAny).
   * Return `toolRefusal(payload)` for an explicit domain refusal.
   * Prefer narrow casts / second parse inside apps if needed — DEBT:fastmcp-zod-boundary.
   */
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>
}

/**
 * Duck-typed FastMCP-like surface — the root barrel takes no fastmcp dependency
 * (only the optional `@kit/mcp/hosted` subpath does).
 * Uses a wide addTool signature so FastMCP (and fakes) are assignable without
 * fighting contravariant parameter checks on Tool.execute / parameters.
 */
export type ToolServer = {
  // biome-ignore lint/suspicious/noExplicitAny: intentional duck-type for FastMCP — DEBT:fastmcp-duck-type
  addTool: (tool: any) => void
}

export type ToolCatalogue = {
  /** Ordered names from ToolDef list (catalogue SSoT). */
  names: readonly string[]
  get: (name: string) => ToolDef | undefined
  /**
   * Assert live registered names match catalogue (order-insensitive).
   * Pass **runtime** names (tools/list / addTool capture) — never a twin of catalogue.names alone.
   */
  assertExact: (runtimeNames: readonly string[]) => void
  /** Sole intended registration path for apps. */
  registerAll: (server: ToolServer, ctx?: ToolContext) => void
  /** Underlying defs (read-only). */
  tools: readonly ToolDef[]
}

/**
 * Assert registered tool names equal an app-supplied allowlist (order-insensitive).
 * Kit purity is enforced by banlist scripts, not product lexicon here.
 */
export function assertToolsMatchAllowlist(names: string[], allowlist: readonly string[]): void {
  const sorted = [...names].sort()
  const expected = [...allowlist].sort()
  if (sorted.length !== expected.length || sorted.some((n, i) => n !== expected[i])) {
    throw new Error(
      `MCP tools must be exactly ${expected.join(',')}; got ${sorted.join(',') || '(none)'}`,
    )
  }
}

/**
 * MCP tool surface: executable tools (Zod input/output + `execute` + server registration).
 *
 * Forked from flows `createToolRegistry` **by decision**, not by drift — ADR-0005 D6 amendment
 * (2026-09-18): that factory owns an authority classification over declarations, this one owns
 * execution. If the fork is ever unified it is a promote that replaces both callers — never a
 * third factory or a helper sitting beside them (M-04).
 */

async function executeRegisteredTool(
  tool: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<
  | string
  | {
      content: { type: 'text'; text: string }[]
      structuredContent: Record<string, unknown>
      isError: true
    }
> {
  // 1) Schema validate first — clear INVALID_ARGUMENTS (not INTERNAL).
  // Catalogue message only (no Zod issue paths / raw input leak).
  const parsedIn = tool.input.safeParse(args)
  if (!parsedIn.success) {
    throw new PublicToolError('INVALID_ARGUMENTS')
  }
  // 2) Budget on accepted payload shape (DoS limits after schema).
  const budget = checkInputBudget(parsedIn.data)
  if (!budget.ok) {
    throw new PublicToolError('INVALID_ARGUMENTS')
  }
  try {
    // 3) Typed-as-unknown parsed data only — never raw args.
    const result = await tool.execute(parsedIn.data, ctx)
    if (
      typeof result === 'object' &&
      result !== null &&
      refusalBrand in result &&
      result[refusalBrand] === true
    ) {
      const payload = (result as ToolRefusal).payload
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new PublicToolError('INTERNAL_ERROR')
      }
      const text = stableJsonWire(payload)
      const structuredContent: unknown = JSON.parse(text)
      if (
        typeof structuredContent !== 'object' ||
        structuredContent === null ||
        Array.isArray(structuredContent)
      ) {
        throw new PublicToolError('INTERNAL_ERROR')
      }
      return {
        content: [{ type: 'text', text }],
        structuredContent: structuredContent as Record<string, unknown>,
        isError: true,
      }
    }
    if (tool.output) {
      const parsedOut = tool.output.safeParse(result)
      if (!parsedOut.success) {
        throw new PublicToolError('INTERNAL_ERROR')
      }
      return stableJsonWire(parsedOut.data)
    }
    if (typeof result === 'string') return result
    return stableJsonWire(result)
  } catch (err) {
    throw toPublicToolError(err)
  }
}

export function createToolCatalogue(tools: readonly ToolDef[]): ToolCatalogue {
  const byName = new Map<string, ToolDef>()
  for (const t of tools) {
    if (byName.has(t.name)) {
      throw new Error(`duplicate tool name in catalogue: ${t.name}`)
    }
    byName.set(t.name, t)
  }
  const names = tools.map((t) => t.name)

  return {
    names,
    tools,
    get(name: string) {
      return byName.get(name)
    },
    assertExact(runtimeNames: readonly string[]) {
      assertToolsMatchAllowlist([...runtimeNames], names)
    },
    registerAll(server: ToolServer, ctx: ToolContext = {}) {
      for (const tool of tools) {
        // Intentionally ignore tool.effect / tool.auth for authorization (SC12).
        void tool.effect
        void tool.auth

        server.addTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.input,
          execute: async (args: unknown) => executeRegisteredTool(tool, args, ctx),
        })
      }
    },
  }
}
