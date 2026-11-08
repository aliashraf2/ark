import { describe, expect, it } from 'vitest'

import { mulberry32 } from '../../../physics/src/terrain/terrainNoise'
import {
  EVAL_SEED_BASE,
  evalEpisodeSeed,
  generateScenario,
  makeScenarioId,
  type ScenarioRequest,
} from './generateScenario'

function request(overrides: Partial<ScenarioRequest> = {}): ScenarioRequest {
  return {
    sampleHeight: () => 0,
    random: mulberry32(7),
    boundsHalfExtentM: 45,
    goalMinDistanceM: 15,
    goalMaxDistanceM: 40,
    maxStartSlope: 0.27,
    maxGoalSlope: 0.35,
    ...overrides,
  }
}

describe('generateScenario', () => {
  it('is deterministic for one RNG stream', () => {
    const first = generateScenario(request())
    const second = generateScenario(request())
    expect(second).toEqual(first)
  })

  it('meets every constraint on gentle ground', () => {
    const scenario = generateScenario(request())
    expect(scenario.constraintsMet).toBe(true)
    expect(scenario.startSlope).toBeLessThanOrEqual(0.27)
    expect(scenario.targetSlope).toBeLessThanOrEqual(0.35)
    expect(scenario.distanceM).toBeGreaterThanOrEqual(15)
    expect(scenario.distanceM).toBeLessThanOrEqual(40)
  })

  it('reports honestly when the distance band cannot be met', () => {
    // Tiny patch: no two in-bounds points can be 500 m apart.
    const scenario = generateScenario(
      request({ boundsHalfExtentM: 6, goalMinDistanceM: 500, goalMaxDistanceM: 600 }),
    )
    expect(scenario.constraintsMet).toBe(false)
    expect(Number.isFinite(scenario.target.x)).toBe(true)
  })

  it('builds stable scenario ids and splits eval seeds', () => {
    expect(makeScenarioId('mars', 42, 7, 'train')).toBe('mars:t42:e7:train')
    expect(evalEpisodeSeed(0)).toBe(EVAL_SEED_BASE)
    expect(evalEpisodeSeed(3)).toBe(EVAL_SEED_BASE + 3)
    expect(() => evalEpisodeSeed(-1)).toThrow()
    expect(() => evalEpisodeSeed(1.5)).toThrow()
  })
})
