import { describe, expect, it } from 'vitest'

import { resolveEnvironmentConfig, type ArkEnvironmentConfig } from './EnvironmentConfig'

const BASE: ArkEnvironmentConfig = { planet: 'mars', terrainSeed: 42 }

describe('resolveEnvironmentConfig', () => {
  it('fills documented defaults', () => {
    const resolved = resolveEnvironmentConfig(BASE)
    expect(resolved.actionRepeat).toBe(4)
    expect(resolved.maxSteps).toBe(600)
    expect(resolved.timeLimitS).toBe(120)
    expect(resolved.toleranceM).toBe(2)
    expect(resolved.boundsHalfExtentM).toBe(45)
    expect(resolved.goalMinDistanceM).toBe(15)
    expect(resolved.goalMaxDistanceM).toBe(40)
    expect(resolved.sensorNoiseSigmaM).toBe(0)
    expect(resolved.tractionMultiplier).toBe(1)
    expect(resolved.terrainSubdivisions).toBe(160)
  })

  it('keeps explicit overrides', () => {
    const resolved = resolveEnvironmentConfig({ ...BASE, actionRepeat: 2, maxSteps: 10 })
    expect(resolved.actionRepeat).toBe(2)
    expect(resolved.maxSteps).toBe(10)
  })

  it.each([
    ['bad planet', { planet: 'venus' }],
    ['non-integer terrain seed', { terrainSeed: 1.5 }],
    ['zero actionRepeat', { actionRepeat: 0 }],
    ['fractional actionRepeat', { actionRepeat: 2.5 }],
    ['zero maxSteps', { maxSteps: 0 }],
    ['negative timeLimit', { timeLimitS: -1 }],
    ['zero tolerance', { toleranceM: 0 }],
    ['negative noise', { sensorNoiseSigmaM: -1 }],
    ['negative traction', { tractionMultiplier: -1 }],
    ['inverted goal band', { goalMinDistanceM: 40, goalMaxDistanceM: 15 }],
    ['tiny subdivisions', { terrainSubdivisions: 4 }],
    ['non-finite weight', { rewardWeights: { progress: 2, success: 100, collision: -5, energy: Number.NaN, time: -0.2 } }],
  ])('throws on invalid config (%s)', (_label, overrides) => {
    // Intentionally invalid values: cast through to test runtime validation.
    expect(() => resolveEnvironmentConfig({ ...BASE, ...overrides } as ArkEnvironmentConfig)).toThrow()
  })
})
