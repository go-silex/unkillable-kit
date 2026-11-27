import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import {
  checkInputBudget,
  createToolCatalogue,
  INPUT_BUDGET,
  PublicToolError,
  toolRefusal,
  WHOAMI_STATUS,
} from './index'

describe('createToolCatalogue', () => {
  const emptyIn = z.object({})

  function registerResult(execute: () => Promise<unknown>, output?: z.ZodTypeAny) {
    const catalogue = createToolCatalogue([
      { name: 'test_result', description: 'test', input: emptyIn, output, execute },
    ])
    let handler: (args: unknown) => Promise<unknown> = async () => {
      throw new Error('tool was not registered')
    }
    catalogue.registerAll({
      addTool(tool) {
        handler = tool.execute
      },
    })
    return () => handler({})
  }

  it('emits explicit refusals before the success output schema and normalizes both channels', async () => {
    const payload = { code: 'NOT_READY', nested: { missing: undefined, date: new Date(0) } }
    const run = registerResult(
      async () => toolRefusal(payload),
      z.object({ success: z.literal(true) }),
    )
    const result = (await run()) as {
      content: { type: string; text: string }[]
      structuredContent: unknown
      isError: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: '{"code":"NOT_READY","nested":{"date":{}}}' },
    ])
    expect(result.structuredContent).toEqual({ code: 'NOT_READY', nested: { date: {} } })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
  })

  it('keeps ordinary false and refusal-lookalike payloads as successes', async () => {
    const values = [
      { ok: false },
      { payload: { code: 'NOT_READY' } },
      { content: [{ type: 'text', text: 'ordinary' }], isError: true },
    ]
    for (const value of values) {
      const result = await registerResult(async () => value)()
      expect(typeof result).toBe('string')
      expect(JSON.parse(result as string)).toEqual(value)
    }
  })

  it('redacts malformed refusal roots and serialization failures', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const values: unknown[] = [null, undefined, [], 'not-an-object', { n: 1n }, cyclic]
    for (const value of values) {
      const run = registerResult(async () => toolRefusal(value as never))
      await expect(run()).rejects.toBeInstanceOf(PublicToolError)
      await expect(run()).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Internal tool error.',
      })
    }
  })

  it('assertExact fails when runtime names drift (planted extra)', () => {
    const catalogue = createToolCatalogue([
      {
        name: 'ping',
        description: 'p',
        input: emptyIn,
        execute: async () => ({ ok: true as const }),
      },
      {
        name: 'whoami',
        description: 'w',
        input: emptyIn,
        execute: async () => ({ status: 'missing_key' }),
      },
    ] as const)

    const runtime: string[] = []
    catalogue.registerAll({
      addTool(t) {
        runtime.push(t.name)
      },
    })
    expect(() => catalogue.assertExact(runtime)).not.toThrow()

    // Plant extra after registerAll — runtime list is the source of truth.
    runtime.push('admin_x')
    expect(() => catalogue.assertExact(runtime)).toThrow(/exactly/)
  })

  it('budget over depth rejects before execute body', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const catalogue = createToolCatalogue([
      {
        name: 'deep',
        description: 'd',
        input: z.unknown(),
        execute,
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })

    let nested: unknown = null
    for (let i = 0; i < INPUT_BUDGET.maxDepth + 5; i++) {
      nested = { a: nested }
    }
    await expect(handler?.(nested)).rejects.toBeInstanceOf(PublicToolError)
    await expect(handler?.(nested)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('invalid input schema → INVALID_ARGUMENTS (not INTERNAL) and skips execute', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const catalogue = createToolCatalogue([
      {
        name: 'need_n',
        description: 'n',
        input: z.object({ n: z.number().int() }),
        execute,
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })

    await expect(handler?.({ n: 'not-a-number' })).rejects.toBeInstanceOf(PublicToolError)
    await expect(handler?.({ n: 'not-a-number' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    })
    await expect(handler?.({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(handler?.(null)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('valid input is passed as parsed.data to execute', async () => {
    const execute = vi.fn(async (input: unknown) => ({ got: input }))
    const catalogue = createToolCatalogue([
      {
        name: 'echo_n',
        description: 'e',
        input: z.object({ n: z.coerce.number() }),
        execute,
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })

    const out = await handler?.({ n: '42' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith({ n: 42 }, expect.any(Object))
    expect(String(out)).toContain('42')
  })

  it('registerAll wrap maps throw with sk_ to INTERNAL_ERROR without secret leak', async () => {
    const secret = 'sk_test_high_entropy_leak_probe_xyz'
    const catalogue = createToolCatalogue([
      {
        name: 'boom',
        description: 'b',
        input: emptyIn,
        execute: async () => {
          throw new Error(`failed for ${secret}`)
        },
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })

    try {
      await handler?.({})
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PublicToolError)
      const pe = err as PublicToolError
      expect(pe.code).toBe('INTERNAL_ERROR')
      expect(pe.message).not.toContain(secret)
      expect(pe.message).not.toMatch(/sk_/)
      expect(JSON.stringify(pe.toJSON())).not.toContain(secret)
    }
  })

  it('does not authorize by effect/auth annotations (SC12)', async () => {
    const execute = vi.fn(async () => ({ ran: true }))
    const catalogue = createToolCatalogue([
      {
        name: 'writey',
        description: 'w',
        input: emptyIn,
        effect: 'write',
        auth: 'none',
        execute,
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })

    const out = await handler?.({})
    expect(execute).toHaveBeenCalledOnce()
    expect(String(out)).toContain('ran')
  })

  it('output schema fail → INTERNAL_ERROR', async () => {
    const catalogue = createToolCatalogue([
      {
        name: 'bad_out',
        description: 'b',
        input: emptyIn,
        output: z.object({ ok: z.literal(true) }),
        execute: async () => ({ ok: false }),
      },
    ] as const)

    let handler: ((args: unknown) => Promise<unknown>) | undefined
    catalogue.registerAll({
      addTool(t) {
        handler = t.execute
      },
    })
    await expect(handler?.({})).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})

describe('checkInputBudget', () => {
  it('rejects oversized arrays', () => {
    const arr = Array.from({ length: INPUT_BUDGET.maxArrayLength + 1 }, () => 1)
    expect(checkInputBudget(arr).ok).toBe(false)
  })

  it('rejects long keys', () => {
    const key = 'k'.repeat(INPUT_BUDGET.maxKeyLength + 1)
    expect(checkInputBudget({ [key]: 1 }).ok).toBe(false)
  })
})

describe('wire SSOT', () => {
  it('whoami status enum is stable SSOT', () => {
    expect(WHOAMI_STATUS).toContain('ok')
    expect(WHOAMI_STATUS).toContain('invalid_response')
    expect(WHOAMI_STATUS).toContain('missing_key')
    expect(WHOAMI_STATUS).toContain('missing_identity')
  })
})
