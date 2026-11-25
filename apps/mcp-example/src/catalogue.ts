/**
 * Shared ping/whoami tools for stdio FastMCP and Worker EdgeFastMCP. Not authorization.
 */
import {
  createToolCatalogue,
  handlePing,
  pingResultSchema,
  type ToolDef,
  whoamiResultSchema,
} from '@kit/mcp'
import { z } from 'zod'

const emptyInput = z.object({})

const pingTool: ToolDef = {
  name: 'ping',
  description: 'Health check',
  input: emptyInput,
  output: pingResultSchema,
  effect: 'read',
  auth: 'none',
  execute: async () => handlePing(),
}

export function createExampleCatalogue(
  whoamiExecute: ToolDef['execute'],
  additionalTools: readonly ToolDef[] = [],
) {
  const whoamiTool: ToolDef = {
    name: 'whoami',
    description: 'Identity probe. Stdio: GET /api/me with sk_. Hosted: Worker MCP token props.',
    input: emptyInput,
    output: whoamiResultSchema,
    effect: 'read',
    auth: 'api_key',
    execute: whoamiExecute,
  }
  return createToolCatalogue([pingTool, whoamiTool, ...additionalTools])
}
