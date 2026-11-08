import { describe, expect, it } from 'vitest'

import { NonFiniteValueError, assertFiniteDeep, serializeResult, toJsonable } from './serialization'

describe('assertFiniteDeep', () => {
  it('passes finite nested structures', () => {
    expect(() => assertFiniteDeep({ a: [1, 2.5], b: { c: -0 } })).not.toThrow()
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    'throws on %s with a path',
    (bad) => {
      try {
        assertFiniteDeep({ obs: [0.1, bad] })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(NonFiniteValueError)
        expect((error as NonFiniteValueError).path).toBe('$.obs[1]')
      }
    },
  )
})

describe('serializeResult', () => {
  it('converts typed arrays to plain arrays', () => {
    expect(serializeResult({ observation: new Float32Array([0.5, 1]) })).toEqual({
      observation: [0.5, 1],
    })
  })

  it('refuses to serialize non-finite values instead of emitting null', () => {
    expect(() => serializeResult({ reward: Number.NaN })).toThrow(NonFiniteValueError)
    // JSON.stringify would silently produce {"reward":null} — prove the guard matters.
    expect(JSON.stringify({ reward: Number.NaN })).toBe('{"reward":null}')
  })

  it('round-trips through JSON unchanged', () => {
    const value = { reward: 0.125, flags: [true, false], nested: { x: -3 } }
    expect(JSON.parse(JSON.stringify(serializeResult(value)))).toEqual(value)
    expect(toJsonable(value)).toEqual(value)
  })
})
