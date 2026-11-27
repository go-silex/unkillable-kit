import { describe, expect, it, vi } from 'vitest'
import { onFirstUse } from './on-first-use'

describe('onFirstUse', () => {
  it('behaves as the built object under reflection, definition and freezing', () => {
    const handle = onFirstUse(() => ({ handler: () => 'built', api: { ok: true } }))
    Object.defineProperty(handle, 'tag', { value: 42 })
    expect(Object.keys(handle)).toEqual(['handler', 'api'])
    expect(Object.getOwnPropertyDescriptor(handle, 'tag')).toMatchObject({ configurable: false })
    expect({ ...handle }.api).toBe(handle.api)
    Object.freeze(handle)
    expect(Object.isFrozen(handle)).toBe(true)
    expect(handle.handler()).toBe('built')
  })

  it('retries a failed build and refuses use during the build', () => {
    let attempts = 0
    const handle: { value: number } = onFirstUse(() => {
      attempts += 1
      if (attempts === 1) throw new Error('first build fails')
      expect(() => handle.value).toThrow('being built')
      return { value: attempts }
    })
    expect(() => handle.value).toThrow('first build fails')
    expect(handle.value).toBe(2)
    expect(handle.value).toBe(2)
    expect(attempts).toBe(2)
  })

  it('builds once, on the first operation', () => {
    const build = vi.fn(() => ({ value: 1 }))
    const handle = onFirstUse(build)
    expect(build).not.toHaveBeenCalled()
    handle.value = 2
    expect(handle.value).toBe(2)
    expect('value' in handle).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
  })
})
