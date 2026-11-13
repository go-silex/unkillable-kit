import { describe, expect, it } from 'vitest'
import {
  ARG_KEY_FORBIDDEN_RE,
  BindingUnresolvedError,
  bindingTaskIds,
  resolveWholeBindings,
  unionAfterWithBindings,
  WHOLE_BINDING_RE,
  walkArgsBindings,
} from './bindings'
import { REDACTED_OUTPUT_MARKER } from './receipts'

const BINDING_DOLLAR = '$'
const ph = (id: string) => `${BINDING_DOLLAR}{{ tasks.${id}.output }}`

describe('WHOLE_BINDING_RE', () => {
  it('matches whole-value task output bindings only', () => {
    expect(WHOLE_BINDING_RE.test(ph('a'))).toBe(true)
    expect(WHOLE_BINDING_RE.test(ph('echo_hello'))).toBe(true)
    expect(WHOLE_BINDING_RE.test(`prefix ${ph('a')}`)).toBe(false)
    expect(WHOLE_BINDING_RE.test(`${BINDING_DOLLAR}{{ tasks.a.output.foo }}`)).toBe(false)
    expect(WHOLE_BINDING_RE.test(`${BINDING_DOLLAR}{{ env.X }}`)).toBe(false)
  })
})

describe('ARG_KEY_FORBIDDEN_RE', () => {
  it('flags env/secret-shaped keys case-insensitively', () => {
    expect(ARG_KEY_FORBIDDEN_RE.test('api_key')).toBe(true)
    expect(ARG_KEY_FORBIDDEN_RE.test('secret_token')).toBe(true)
    expect(ARG_KEY_FORBIDDEN_RE.test('Authorization')).toBe(true)
    expect(ARG_KEY_FORBIDDEN_RE.test('text')).toBe(false)
    expect(ARG_KEY_FORBIDDEN_RE.test('environment')).toBe(false)
  })
})

describe('bindingTaskIds + walkArgsBindings', () => {
  it('collects nested whole bindings and flags partial / forbidden keys', () => {
    expect(bindingTaskIds({ text: ph('a'), nest: { x: ph('b') } })).toEqual(['a', 'b'])
    expect(walkArgsBindings({ text: `prefix ${ph('a')}` }).map((i) => i.code)).toEqual([
      'BINDING_NOT_WHOLE',
    ])
    expect(walkArgsBindings({ api_key: 'x' }).map((i) => i.code)).toEqual(['ARG_KEY_FORBIDDEN'])
    expect(walkArgsBindings({ text: 'plain' })).toEqual([])
  })
})

describe('resolveWholeBindings', () => {
  it('substitutes string outputs and fails closed on missing', () => {
    const outputs = new Map<string, string | undefined>([
      ['a', 'hello'],
      ['red', REDACTED_OUTPUT_MARKER],
    ])
    expect(resolveWholeBindings({ text: ph('a') }, outputs)).toEqual({
      text: 'hello',
    })
    expect(resolveWholeBindings({ text: ph('red') }, outputs)).toEqual({
      text: REDACTED_OUTPUT_MARKER,
    })
    expect(resolveWholeBindings({ text: 'plain' }, outputs)).toEqual({ text: 'plain' })
    expect(() => resolveWholeBindings({ text: ph('missing') }, outputs)).toThrow(
      BindingUnresolvedError,
    )
  })
})

describe('unionAfterWithBindings', () => {
  it('sorts the authored∪derived union', () => {
    expect(unionAfterWithBindings(['z'], { text: ph('a') })).toEqual(['a', 'z'])
    expect(unionAfterWithBindings(undefined, { text: 'plain' })).toBeUndefined()
  })
})
