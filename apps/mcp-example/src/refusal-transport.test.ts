import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createToolCatalogue, toolRefusal } from '@kit/mcp'
import { EdgeFastMCP } from 'fastmcp/edge'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { createExampleCatalogue } from './catalogue'

const payload = { code: 'NOT_READY', details: { pending: ['one'] } }
const ordinary = { ok: false, code: 'ordinary-data' }
type Result = { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
type Pending = { resolve: (value: Result) => void; reject: (error: Error) => void }
type RpcResponse = { id?: number; result?: Result; error?: unknown }

function dispatchResponse(message: RpcResponse, pending: Map<number, Pending>, stderr: string) {
  if (message.id === undefined) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error !== undefined) {
    request.reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}; stderr: ${stderr}`))
  } else if (message.result !== undefined) {
    request.resolve(message.result)
  } else {
    request.reject(new Error(`JSON-RPC response missing result; stderr: ${stderr}`))
  }
}

function assertResults(refusal: Result, success: Result, failure: Result) {
  expect(refusal.isError).toBe(true)
  expect(refusal.structuredContent).toEqual(payload)
  expect(JSON.parse(refusal.content[0].text)).toEqual(payload)
  expect(success.isError).not.toBe(true)
  expect(JSON.parse(success.content[0].text)).toEqual(ordinary)
  expect(failure.isError).toBe(true)
  expect(JSON.stringify(failure)).toContain('Internal tool error.')
  expect(JSON.stringify(failure)).not.toContain('private-internal-marker')
}

async function edgeCall(server: EdgeFastMCP, name: string): Promise<Result> {
  const response = await server.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: {} },
      }),
    }),
  )
  const body = (await response.json()) as { result: Result }
  return body.result
}

describe('native MCP refusal transports', () => {
  it('preserves explicit refusals on the hosted Edge transport', async () => {
    const server = new EdgeFastMCP({
      name: 'example-refusal-test',
      version: '0.0.1',
      mcpPath: '/mcp',
    })
    createExampleCatalogue(async () => toolRefusal(payload)).registerAll(server)
    createToolCatalogue([
      {
        name: 'ordinary',
        description: 'Ordinary domain data',
        input: z.object({}),
        output: z.object({ ok: z.boolean(), code: z.string() }),
        execute: async () => ordinary,
      },
      {
        name: 'failure',
        description: 'Unexpected exception',
        input: z.object({}),
        execute: async () => {
          throw new Error('private-internal-marker')
        },
      },
    ]).registerAll(server)
    assertResults(
      await edgeCall(server, 'whoami'),
      await edgeCall(server, 'ordinary'),
      await edgeCall(server, 'failure'),
    )
  })

  it('preserves explicit refusals on the stdio transport', async () => {
    async function call(mode: string, name: string): Promise<Result> {
      const child = spawn(
        'bun',
        ['run', fileURLToPath(new URL('./refusal-fixture.ts', import.meta.url)), mode],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const lines = createInterface({ input: child.stdout })
      let id = 0
      let stderr = ''
      let stopped: Error | undefined
      const pending = new Map<number, Pending>()
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000)
      })
      const fail = (reason: string) => {
        stopped = new Error(`${reason}; stderr: ${stderr}`)
        for (const request of pending.values()) request.reject(stopped)
        pending.clear()
      }
      child.on('error', (error) => fail(`stdio child error: ${error.message}`))
      child.on('exit', (code, signal) => fail(`stdio child exited: ${code ?? signal}`))
      child.stdin.on('error', (error) => fail(`stdio stdin error: ${error.message}`))
      lines.on('line', (line) => {
        try {
          dispatchResponse(JSON.parse(line) as RpcResponse, pending, stderr)
        } catch (error) {
          fail(`invalid stdio response: ${String(error)}`)
        }
      })
      const request = (method: string, params: object) => {
        if (stopped) return Promise.reject(stopped)
        const { promise, resolve, reject } = Promise.withResolvers<Result>()
        const requestId = ++id
        // A real child can hang independently of fake timers; bound each RPC wait.
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`stdio ${method} timed out; stderr: ${stderr}`))
        }, 5000)
        pending.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
        return promise
      }
      try {
        await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        })
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        )
        return await request('tools/call', { name, arguments: {} })
      } finally {
        lines.close()
        child.kill('SIGTERM')
      }
    }
    assertResults(
      await call('refusal', 'whoami'),
      await call('ordinary', 'ordinary'),
      await call('throw', 'whoami'),
    )
  }, 20000)
})
