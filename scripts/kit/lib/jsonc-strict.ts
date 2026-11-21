/**
 * Strict JSONC: objects, arrays, strings, numbers, literals, comments, trailing commas.
 * Per-object uniqueness of decoded keys (JSON string unescaping). Parse errors throw.
 */

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

type Cursor = { text: string; i: number }

function fail(c: Cursor, message: string): never {
  throw new Error(`unparseable bun.lock: ${message} at ${c.i}`)
}

function skipLineComment(c: Cursor): void {
  c.i += 2
  while (c.i < c.text.length && c.text[c.i] !== '\n') c.i += 1
}

function skipBlockComment(c: Cursor): void {
  c.i += 2
  while (c.i < c.text.length && !(c.text[c.i] === '*' && c.text[c.i + 1] === '/')) c.i += 1
  if (c.i >= c.text.length) fail(c, 'unterminated block comment')
  c.i += 2
}

function skipWs(c: Cursor): void {
  const { text } = c
  while (c.i < text.length) {
    const ch = text[c.i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      c.i += 1
      continue
    }
    if (ch === '/' && text[c.i + 1] === '/') {
      skipLineComment(c)
      continue
    }
    if (ch === '/' && text[c.i + 1] === '*') {
      skipBlockComment(c)
      continue
    }
    break
  }
}

function readEscape(c: Cursor): string {
  const e = c.text[c.i++]!
  if (e === 'u') {
    const hex = c.text.slice(c.i, c.i + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(c, 'bad unicode escape')
    c.i += 4
    return String.fromCharCode(Number.parseInt(hex, 16))
  }
  const mapped = ESCAPES[e]
  if (mapped === undefined) fail(c, 'bad escape')
  return mapped
}

function readString(c: Cursor): string {
  const { text } = c
  if (text[c.i++] !== '"') fail(c, 'expected string')
  let out = ''
  while (c.i < text.length) {
    const ch = text[c.i++]!
    if (ch === '"') return out
    if (ch === '\n' || ch === '\r') fail(c, 'newline in string')
    out += ch === '\\' ? readEscape(c) : ch
  }
  fail(c, 'unterminated string')
}
function readDigits(c: Cursor): void {
  if (!/[0-9]/.test(c.text[c.i] ?? '')) fail(c, 'expected digit')
  while (/[0-9]/.test(c.text[c.i] ?? '')) c.i += 1
}

function readNumber(c: Cursor): number {
  const start = c.i
  if (c.text[c.i] === '-') c.i += 1
  if (c.text[c.i] === '0') c.i += 1
  else readDigits(c)
  if (c.text[c.i] === '.') {
    c.i += 1
    readDigits(c)
  }
  if (c.text[c.i] === 'e' || c.text[c.i] === 'E') {
    c.i += 1
    if (c.text[c.i] === '+' || c.text[c.i] === '-') c.i += 1
    readDigits(c)
  }
  const num = Number(c.text.slice(start, c.i))
  if (!Number.isFinite(num)) fail(c, 'non-finite number')
  return num
}

function readLiteral(c: Cursor, word: string, value: unknown): unknown {
  if (!c.text.startsWith(word, c.i)) fail(c, 'unexpected token')
  c.i += word.length
  return value
}

function readValue(c: Cursor): unknown {
  skipWs(c)
  const ch = c.text[c.i] ?? ''
  if (ch === '"') return readString(c)
  if (ch === '{') return readObject(c)
  if (ch === '[') return readArray(c)
  if (ch === '-' || /[0-9]/.test(ch)) return readNumber(c)
  if (ch === 't') return readLiteral(c, 'true', true)
  if (ch === 'f') return readLiteral(c, 'false', false)
  if (ch === 'n') return readLiteral(c, 'null', null)
  fail(c, 'unexpected token')
}

function finishCollection(c: Cursor, close: '}' | ']'): boolean {
  skipWs(c)
  const ch = c.text[c.i] ?? ''
  if (ch === ',') {
    c.i += 1
    skipWs(c)
    if (c.text[c.i] === close) {
      c.i += 1
      return true
    }
    return false
  }
  if (ch === close) {
    c.i += 1
    return true
  }
  fail(c, `expected comma or ${close}`)
}

function readObject(c: Cursor): Record<string, unknown> {
  c.i += 1
  const obj: Record<string, unknown> = {}
  const seen = new Set<string>()
  skipWs(c)
  if (c.text[c.i] === '}') {
    c.i += 1
    return obj
  }
  while (true) {
    skipWs(c)
    if (c.text[c.i] !== '"') fail(c, 'expected object key')
    const key = readString(c)
    if (seen.has(key)) throw new Error('ambiguous bun.lock: duplicate decoded keys')
    seen.add(key)
    skipWs(c)
    if (c.text[c.i++] !== ':') fail(c, 'expected colon')
    obj[key] = readValue(c)
    if (finishCollection(c, '}')) break
  }
  return obj
}

function readArray(c: Cursor): unknown[] {
  c.i += 1
  const arr: unknown[] = []
  skipWs(c)
  if (c.text[c.i] === ']') {
    c.i += 1
    return arr
  }
  while (true) {
    arr.push(readValue(c))
    if (finishCollection(c, ']')) break
  }
  return arr
}

export function parseJsoncStrict(text: string): unknown {
  const c: Cursor = { text, i: 0 }
  const value = readValue(c)
  skipWs(c)
  if (c.i < text.length) fail(c, 'trailing input')
  return value
}
