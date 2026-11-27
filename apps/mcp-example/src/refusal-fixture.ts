import { createToolCatalogue, toolRefusal } from '@kit/mcp'
import { FastMCP } from 'fastmcp'
import * as z from 'zod'
import { createExampleCatalogue } from './catalogue'

const mode = process.argv[2]
const server = new FastMCP({ name: 'example-refusal-test', version: '0.0.1' })
createExampleCatalogue(async () => {
  if (mode === 'refusal') return toolRefusal({ code: 'NOT_READY', details: { pending: ['one'] } })
  if (mode === 'throw') throw new Error('private-internal-marker')
  return { keyPresent: false, verified: false, subject: null, status: 'missing_key', ok: false }
}).registerAll(server)
createToolCatalogue([
  {
    name: 'ordinary',
    description: 'Ordinary domain data',
    input: z.object({}),
    output: z.object({ ok: z.boolean(), code: z.string() }),
    execute: async () => ({ ok: false, code: 'ordinary-data' }),
  },
]).registerAll(server)
await server.start({ transportType: 'stdio' })
