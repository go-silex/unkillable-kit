/**
 * Node-only email transport helpers (SMTP → Mailpit local).
 * Do **not** import this module from Cloudflare Workers bundles.
 *
 * Usage: scripts / Node CLIs with SMTP_HOST/SMTP_PORT (Mailpit 1025).
 */

import { isValidMailboxAddress } from './domain'
import { scrubHeaderLine } from './scrub'

export type SmtpSendInput = {
  host: string
  port: number
  from: string
  to: string
  subject: string
  text: string
}

export type SmtpSendResult =
  | { ok: true; transport: 'smtp' }
  | { ok: false; transport: 'smtp'; error: string }

export type SmtpSocket = {
  writable: WritableStream
  readable: ReadableStream
  close: () => Promise<void>
}

export type SmtpConnect = (opts: { hostname: string; port: number }) => Promise<SmtpSocket>

/** Parse one SMTP reply (handles multi-line 250-… / 250 …). Exported for tests. */
export function parseSmtpReply(
  buffer: string,
): { code: number; complete: boolean; text: string } | null {
  const normalized = buffer.replace(/\r\n/g, '\n')
  if (!normalized.includes('\n')) return null
  const lines = normalized.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return null
  // Last complete line must be "NNN text" (space) not "NNN-text" (continuation)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{3})([\s-])(.*)$/.exec(lines[i]!)
    if (!m) continue
    if (m[2] === ' ') {
      return {
        code: Number(m[1]),
        complete: true,
        text: lines.slice(0, i + 1).join('\n'),
      }
    }
  }
  return null
}

async function readSmtpReply(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  leftover: { buf: string },
): Promise<{ code: number; text: string }> {
  while (true) {
    const parsed = parseSmtpReply(leftover.buf)
    if (parsed?.complete) {
      // consume only the reply portion roughly by clearing on complete reply
      leftover.buf = ''
      return { code: parsed.code, text: parsed.text }
    }
    const { value, done } = await reader.read()
    if (done) {
      throw new Error(`SMTP connection closed mid-reply: ${leftover.buf || '(empty)'}`)
    }
    leftover.buf += decoder.decode(value, { stream: true })
  }
}

function isSuccessCode(code: number): boolean {
  return code >= 200 && code < 400
}

/**
 * SMTP DATA dialogue for local Mailpit — **reads reply codes** and fail-closes on non-2xx/3xx.
 * Requires Bun/Node `connect` (not available on Workers), injectable for tests.
 */
export async function sendSmtp(
  input: SmtpSendInput,
  deps?: { connect?: SmtpConnect | null },
): Promise<SmtpSendResult> {
  // `connect: null` forces unavailable path (tests); omit deps to use globalThis.connect
  const connect =
    deps && 'connect' in deps ? deps.connect : (globalThis as { connect?: SmtpConnect }).connect

  if (typeof connect !== 'function') {
    return {
      ok: false,
      transport: 'smtp',
      error: 'TCP connect() unavailable (use Node/Bun CLI, not Workers)',
    }
  }

  // Header scrub + shared mailbox gate (same rules as CF/Resend/allowlist).
  const from = scrubHeaderLine(input.from).trim()
  const to = scrubHeaderLine(input.to).trim()
  const subject = scrubHeaderLine(input.subject).trimEnd()
  if (!(isValidMailboxAddress(from) && isValidMailboxAddress(to))) {
    return {
      ok: false,
      transport: 'smtp',
      error: 'invalid from/to address (need printable ASCII mailbox after CR/LF scrub)',
    }
  }

  // RFC 5321: dot-stuff body lines that start with '.' so DATA cannot end early.
  const dotStuffedText = input.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')

  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@kit.local>`,
    ``,
    dotStuffedText,
    ``,
  ].join('\r\n')

  let socket: SmtpSocket | undefined
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    socket = await connect({ hostname: input.host, port: input.port })
    writer = socket.writable.getWriter()
    reader = socket.readable.getReader()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const leftover = { buf: '' }

    const expect = async (label: string) => {
      const reply = await readSmtpReply(reader!, decoder, leftover)
      if (!isSuccessCode(reply.code)) {
        throw new Error(`SMTP ${label} failed: ${reply.code} ${reply.text}`)
      }
      return reply
    }

    const write = async (line: string) => {
      await writer!.write(encoder.encode(`${line}\r\n`))
    }

    await expect('banner')
    await write('EHLO localhost')
    await expect('EHLO')
    await write(`MAIL FROM:<${from}>`)
    await expect('MAIL FROM')
    await write(`RCPT TO:<${to}>`)
    await expect('RCPT TO')
    await write('DATA')
    await expect('DATA')
    await writer.write(encoder.encode(`${body}\r\n.\r\n`))
    await expect('message body')
    await write('QUIT')
    // QUIT often returns 221 — still success
    try {
      await expect('QUIT')
    } catch {
      /* some sinks close without 221 */
    }
    return { ok: true, transport: 'smtp' }
  } catch (e) {
    return {
      ok: false,
      transport: 'smtp',
      error: e instanceof Error ? e.message : String(e),
    }
  } finally {
    try {
      reader?.releaseLock()
    } catch {
      /* ignore */
    }
    try {
      await writer?.close()
    } catch {
      /* ignore */
    }
    try {
      await socket?.close()
    } catch {
      /* ignore */
    }
  }
}

/** Re-export edge-safe log transport for Node consumers of `/server` (leaf scrubs headers). */
export { sendLog } from './ports'
