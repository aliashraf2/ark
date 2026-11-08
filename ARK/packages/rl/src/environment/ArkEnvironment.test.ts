import { afterEach, describe, expect, it } from 'vitest'

import { OBSERVATION_SIZE, OBSERVATION_SPEC } from '../observations/observationSpec'
import { ArkEnvironment, createArkEnvironment, type ArkEnvironmentConfig } from './ArkEnvironment'

const BASE_CONFIG: ArkEnvironmentConfig = {
  planet: 'earth',
  terrainSeed: 11,
  terrainSubdivisions: 32,
}

const live: ArkEnvironment[] = []
async function makeEnv(config: ArkEnvironmentConfig = BASE_CONFIG): Promise<ArkEnvironment> {
  const env = await createArkEnvironment(config)
  live.push(env)
  return env
}

afterEach(() => {
  while (live.length > 0) live.pop()?.close()
})

describe('Test A+B — observation shape and validity', () => {
  it('returns a fixed-size Float32Array within documented bounds', async () => {
    const env = await makeEnv()
    const { observation } = env.reset(7)
    expect(observation).toBeInstanceOf(Float32Array)
    expect(observation).toHaveLength(OBSERVATION_SIZE)
    expect(OBSERVATION_SIZE).toBe(12)
    for (let i = 0; i < observation.length; i += 1) {
      const value = observation[i]
      const spec = OBSERVATION_SPEC[i]
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual((spec?.range[0] ?? 0) - 1e-6)
      expect(value).toBeLessThanOrEqual((spec?.range[1] ?? 0) + 1e-6)
    }
  })

  it('stays valid while driving', async () => {
    const env = await makeEnv()
    env.reset(7)
    for (let i = 0; i < 5; i += 1) {
      const result = env.step({ leftDrive: 1, rightDrive: 0.6 })
      expect(result.observation).toHaveLength(OBSERVATION_SIZE)
      for (const value of result.observation) expect(Number.isFinite(value)).toBe(true)
      if (result.terminated || result.truncated) break
    }
  })
})

describe('Test C — action validation', () => {
  it('throws on malformed actions, clips finite out-of-range', async () => {
    const env = await makeEnv()
    env.reset(7)
    expect(() => env.step(null as never)).toThrow()
    expect(() => env.step('left' as never)).toThrow()
    expect(() => env.step({} as never)).toThrow()
    expect(() => env.step({ leftDrive: 0 } as never)).toThrow()
    expect(() => env.step({ leftDrive: Number.NaN, rightDrive: 0 })).toThrow()
    expect(() => env.step({ leftDrive: 0, rightDrive: Number.POSITIVE_INFINITY })).toThrow()
    const clipped = env.step({ leftDrive: 2, rightDrive: -3 })
    expect(clipped.info.actionClipped).toBe(true)
    const clean = env.step({ leftDrive: 0.5, rightDrive: -0.5 })
    expect(clean.info.actionClipped).toBe(false)
  })
})

describe('Test D — action repeat', () => {
  it('advances exactly actionRepeat physics steps per RL step', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, actionRepeat: 2 })
    env.reset(7)
    for (let i = 0; i < 5; i += 1) env.step({ leftDrive: 0.3, rightDrive: 0.3 })
    // 30 settle steps + 5 RL steps × 2 substeps.
    const probe = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(probe.info.physicsSteps).toBe(30 + 6 * 2)
    expect(probe.info.simTimeS).toBeCloseTo((30 + 6 * 2) / 60, 9)
    expect(probe.info.metrics.length).toBe(6)
  })
})

describe('Test E — reward calculation', () => {
  it('pays the configured success bonus on arrival with itemized terms', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, toleranceM: 50 })
    // Start and goal coincide: settle drift stays far inside tolerance 50.
    env.reset(7, { start: { x: 0, z: 0 }, target: { x: 0, z: 0 } })
    const result = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(result.terminated).toBe(true)
    expect(result.info.rewardTerms.successBonus).toBe(100)
    expect(result.info.rewardTerms.timePenalty).toBeLessThan(0)
    const terms = result.info.rewardTerms
    expect(result.reward).toBeCloseTo(
      terms.progress + terms.successBonus + terms.collisionPenalty + terms.energyPenalty + terms.timePenalty,
      9,
    )
  })
})

describe('Test F — goal completion', () => {
  it('terminates with success on arrival', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, toleranceM: 50 })
    env.reset(7, { start: { x: 0, z: 0 }, target: { x: 0, z: 0 } })
    const result = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(result.terminated).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.info.metrics.success).toBe(true)
    expect(result.info.metrics.terminationReason).toBe('goal')
    expect(result.info.missionStatus).toBe('succeeded')
  })

  it('terminates with battery-depleted when energy runs out', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, maxSteps: 1000, rover: { batteryCapacityJ: 5 } })
    env.reset(7)
    let result = env.step({ leftDrive: 1, rightDrive: 1 })
    for (let i = 0; i < 30 && !result.terminated && !result.truncated; i += 1) {
      result = env.step({ leftDrive: 1, rightDrive: 1 })
    }
    expect(result.terminated).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.info.metrics.success).toBe(false)
    expect(result.info.metrics.terminationReason).toBe('battery-depleted')
    expect(result.info.batteryPercent).toBe(0)
  })
})

describe('Test G — truncation', () => {
  it('truncates on the RL step cap with reason max-steps', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, maxSteps: 3 })
    env.reset(7)
    env.step({ leftDrive: 0.2, rightDrive: 0.2 })
    env.step({ leftDrive: 0.2, rightDrive: 0.2 })
    const result = env.step({ leftDrive: 0.2, rightDrive: 0.2 })
    expect(result.terminated).toBe(false)
    expect(result.truncated).toBe(true)
    expect(result.info.metrics.truncationReason).toBe('max-steps')
    expect(result.info.metrics.success).toBe(false)
  })

  it('truncates on the mission time limit with reason time-limit', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, timeLimitS: 0.05, maxSteps: 1000 })
    env.reset(7)
    const result = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(result.truncated).toBe(true)
    expect(result.info.metrics.truncationReason).toBe('time-limit')
  })

  it('truncates outside the episode bounds with reason out-of-bounds', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, boundsHalfExtentM: 6, maxSteps: 1000 })
    env.reset(7, { start: { x: 0, z: 0 }, target: { x: 0, z: 30 } })
    let result = env.step({ leftDrive: 1, rightDrive: 1 })
    for (let i = 0; i < 150 && !result.truncated && !result.terminated; i += 1) {
      result = env.step({ leftDrive: 1, rightDrive: 1 })
    }
    expect(result.truncated).toBe(true)
    expect(result.info.metrics.truncationReason).toBe('out-of-bounds')
  })
})

describe('Test H — reset', () => {
  it('restores episode state and starts a fresh scenario', async () => {
    const env = await makeEnv()
    const first = env.reset(7)
    env.step({ leftDrive: 1, rightDrive: 1 })
    env.step({ leftDrive: 1, rightDrive: 1 })
    const second = env.reset(99)
    expect(second.info.episodeIndex).toBe(1)
    expect(second.info.scenario.scenarioId).not.toBe(first.info.scenario.scenarioId)
    const result = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(result.info.metrics.length).toBe(1)
    expect(result.info.metrics.episodeReward).toBeCloseTo(result.reward, 9)
    expect(result.info.metrics.collisions).toBe(0)
    expect(result.info.batteryPercent).toBeGreaterThan(0.99)
  })
})

describe('Test I — deterministic scenarios', () => {
  it('repeats the initial observation and metadata for one seed', async () => {
    const env = await makeEnv()
    const first = env.reset(7)
    const second = env.reset(7)
    expect(Array.from(second.observation)).toEqual(Array.from(first.observation))
    expect(second.info.scenario).toEqual(first.info.scenario)
  })

  it('matches across independent instances with equal configs', async () => {
    const a = await makeEnv()
    const b = await makeEnv()
    const ra = a.reset(21)
    const rb = b.reset(21)
    expect(Array.from(ra.observation)).toEqual(Array.from(rb.observation))
    expect(ra.info.scenario).toEqual(rb.info.scenario)
  })

  it('varies the scenario with the seed', async () => {
    const env = await makeEnv()
    const first = env.reset(7)
    const second = env.reset(8)
    expect(second.info.scenario.scenarioId).not.toBe(first.info.scenario.scenarioId)
    expect(Array.from(second.observation)).not.toEqual(Array.from(first.observation))
  })

  it('repeats post-step transitions: reset clears all Rapier state', async () => {
    // Regression: contact warm-start caches keyed by the persistent rover
    // colliders used to leak across episodes, so reset(7);step;reset(7);step
    // diverged even though back-to-back resets matched.
    const env = await makeEnv()
    const action = { leftDrive: 0.3, rightDrive: -0.7 }
    env.reset(7)
    const first = env.step(action)
    env.reset(7)
    const second = env.step(action)
    expect(Array.from(second.observation)).toEqual(Array.from(first.observation))
    expect(second.reward).toBe(first.reward)
  })
})

describe('Test J — independent environments', () => {
  it('keeps physics, episodes, and metrics separate per instance', async () => {
    const earth = await makeEnv({ ...BASE_CONFIG, planet: 'earth', terrainSeed: 10 })
    const mars = await makeEnv({ ...BASE_CONFIG, planet: 'mars', terrainSeed: 20 })
    const re = earth.reset(5)
    const rm = mars.reset(5)
    expect(re.info.scenario.planet).toBe('earth')
    expect(rm.info.scenario.planet).toBe('mars')
    earth.step({ leftDrive: 1, rightDrive: 1 })
    earth.step({ leftDrive: 1, rightDrive: 1 })
    earth.step({ leftDrive: 1, rightDrive: 1 })
    const marsStep = mars.step({ leftDrive: 0, rightDrive: 0 })
    expect(marsStep.info.metrics.length).toBe(1)
    expect(marsStep.info.metrics.episodeReward).toBeCloseTo(marsStep.reward, 9)
    const earthStep = earth.step({ leftDrive: 0, rightDrive: 0 })
    expect(earthStep.info.metrics.length).toBe(4)
  })
})

describe('Test K — terminal-step protection', () => {
  it('requires reset before the first step and after episodes end', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, maxSteps: 1 })
    expect(() => env.step({ leftDrive: 0, rightDrive: 0 })).toThrow(/before reset/)
    env.reset(7)
    const done = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(done.truncated).toBe(true)
    expect(() => env.step({ leftDrive: 0, rightDrive: 0 })).toThrow(/after episode end/)
    expect(() => env.reset(8)).not.toThrow()
    expect(() => env.step({ leftDrive: 0, rightDrive: 0 })).not.toThrow()
  })

  it('also protects terminated (not just truncated) episodes', async () => {
    const env = await makeEnv({ ...BASE_CONFIG, toleranceM: 50 })
    env.reset(7, { start: { x: 0, z: 0 }, target: { x: 0, z: 0 } })
    const done = env.step({ leftDrive: 0, rightDrive: 0 })
    expect(done.terminated).toBe(true)
    expect(() => env.step({ leftDrive: 0, rightDrive: 0 })).toThrow(/after episode end/)
  })
})

describe('Test L — cleanup', () => {
  it('creates and closes repeatedly without leaking or throwing', async () => {
    for (let i = 0; i < 3; i += 1) {
      const env = await createArkEnvironment(BASE_CONFIG)
      env.reset(i)
      env.step({ leftDrive: 0.5, rightDrive: -0.5 })
      env.close()
      env.close()
    }
  })

  it('rejects use after close', async () => {
    const env = await makeEnv()
    env.reset(1)
    env.close()
    expect(() => env.reset(2)).toThrow(/closed/)
    expect(() => env.step({ leftDrive: 0, rightDrive: 0 })).toThrow(/closed/)
  })
})

describe('metrics', () => {
  it('tracks traveled distance, energy, and reward sums from real state', async () => {
    const env = await makeEnv()
    env.reset(7)
    let total = 0
    let result = env.step({ leftDrive: 1, rightDrive: 1 })
    total += result.reward
    for (let i = 0; i < 4 && !result.terminated && !result.truncated; i += 1) {
      result = env.step({ leftDrive: 1, rightDrive: 1 })
      total += result.reward
    }
    expect(result.info.metrics.episodeReward).toBeCloseTo(total, 9)
    expect(result.info.metrics.distanceTraveledM).toBeGreaterThan(0)
    expect(result.info.metrics.energyJ).toBeGreaterThan(0)
    expect(result.info.simTimeS).toBeGreaterThan(0)
  })
})
