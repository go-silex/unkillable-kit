#!/usr/bin/env bun
/**
 * Real stdio smoke against mcp-example entry: list tools + call ping + whoami.
 * Expected tool set = app catalogue.names (REGISTERED_TOOL_NAMES) — single SSOT.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { whoamiResultSchema } from '@kit/mcp'
import { REGISTERED_TOOL_NAMES } from '../src/index.ts'

const root = dirname(fileURLToPath(import.meta.url))
const entry = join(root, '../src/index.ts')

const child = spawn('bun', ['run', entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_KEY: process.env.API_KEY || 'sk_stdio_smoke_test_key_abcdef',
  },
})

let buf = ''
const lines = []
const transcript = []

function send(msg) {
  const line = `${JSON.stringify(msg)}\n`
  transcript.push({ dir: 'out', msg })
  child.stdin.write(line)
}

function onLine(line) {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    transcript.push({ dir: 'in-raw', line })
    return
  }
  transcript.push({ dir: 'in', msg })
  lines.push(msg)
}

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  while (true) {
    const idx = buf.indexOf('\n')
    if (idx < 0) break
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    onLine(line)
  }
})

child.stderr.on('data', (chunk) => {
  transcript.push({ dir: 'stderr', text: chunk.toString('utf8') })
})

function waitFor(pred, timeoutMs = 5000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = lines.find(pred)
      if (hit) return resolve(hit)
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `timeout waiting for MCP response: ${JSON.stringify(transcript).slice(0, 2000)}`,
          ),
        )
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

function toolText(result) {
  const content = result?.content
  if (!Array.isArray(content)) return null
  const text = content.find((c) => c?.type === 'text')?.text
  return typeof text === 'string' ? text : null
}

async function main() {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio-smoke', version: '0.0.1' },
    },
  })
  await waitFor((m) => m.id === 1)

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const listed = await waitFor((m) => m.id === 2)
  const tools = (listed.result?.tools?.map((t) => t.name) ?? []).slice().sort()
  // SSOT: example catalogue.names — not orphan hardcode / package-only twin
  const expected = [...REGISTERED_TOOL_NAMES].slice().sort()
  if (JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error(
      `expected exact tools ${JSON.stringify(expected)}, got ${JSON.stringify(tools)}`,
    )
  }

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ping', arguments: {} },
  })
  const ping = await waitFor((m) => m.id === 3)
  if (ping.error) throw new Error(`ping failed: ${JSON.stringify(ping.error)}`)

  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  })
  const who = await waitFor((m) => m.id === 4)
  if (who.error) throw new Error(`whoami failed: ${JSON.stringify(who.error)}`)

  const whoText = toolText(who.result)
  if (!whoText) throw new Error(`whoami missing text content: ${JSON.stringify(who.result)}`)
  if (whoText.includes('sk_')) {
    throw new Error('whoami result leaked sk_ material')
  }
  let whoBody
  try {
    whoBody = JSON.parse(whoText)
  } catch {
    throw new Error(`whoami text not JSON: ${whoText.slice(0, 200)}`)
  }
  const parsed = whoamiResultSchema.safeParse(whoBody)
  if (!parsed.success) {
    throw new Error(`whoami body failed schema: ${JSON.stringify(parsed.error.issues)}`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools,
        expectedFrom: 'REGISTERED_TOOL_NAMES',
        ping: ping.result,
        whoami: who.result,
        whoamiParsed: parsed.data,
        transcript,
      },
      null,
      2,
    ),
  )

  child.kill('SIGTERM')
  process.exit(0)
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err), transcript }, null, 2))
  child.kill('SIGTERM')
  process.exit(1)
})
