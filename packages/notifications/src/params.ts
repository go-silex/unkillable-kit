import type * as z from 'zod'

function assertJsonArray(value: unknown[], ancestors: Set<object>): void {
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('Invalid JSON array')
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!(descriptor?.enumerable && 'value' in descriptor))
      throw new TypeError('Invalid JSON array')
    assertJson(descriptor.value, ancestors)
  }
}

function assertJsonObject(value: object, ancestors: Set<object>): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError('Invalid JSON object')
    assertJson(descriptor.value, ancestors)
  }
}

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return
  if (typeof value !== 'object' || ancestors.has(value))
    throw new TypeError('Notification parameters must be JSON values')
  const prototype = Object.getPrototypeOf(value)
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError('Notification parameters must be plain JSON values')
  ancestors.add(value)
  if (Array.isArray(value)) assertJsonArray(value, ancestors)
  else assertJsonObject(value, ancestors)
  ancestors.delete(value)
}

function freezeJson(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
}

export function parseNotificationParams<S extends z.ZodType>(
  type: { readonly params: S },
  input: unknown,
): z.output<S> {
  assertJson(input)
  const parsed: z.output<S> = type.params.parse(input)
  assertJson(parsed)
  const serialized = JSON.stringify(parsed)
  const roundTrip: unknown = JSON.parse(serialized)
  const reparsed: z.output<S> = type.params.parse(roundTrip)
  assertJson(reparsed)
  if (JSON.stringify(reparsed) !== serialized)
    throw new TypeError('Notification parameter schema does not survive JSON round trip')
  freezeJson(parsed)
  return parsed
}
