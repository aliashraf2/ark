import { beforeAll, describe, expect, it } from 'vitest'

import { PhysicsWorld } from '../physics/PhysicsWorld'
import type { Heightfield } from '../terrain/generateHeightfield'
import { generateHeightfield } from '../terrain/generateHeightfield'
import { getPlanet, resolveTerrainParams } from '../worlds/planetPresets'
import { RoverEnv, type RoverEnvConfig } from './RoverEnv'

beforeAll(async () => {
  await PhysicsWorld.init()
})

function testHeightfield(): Heightfield {
  const params = { ...resolveTerrainParams(getPlanet('earth')), subdivisions: 32 }
  return generateHeightfield(params, 4242)
}

function envConfig(overrides: Partial<RoverEnvConfig> = {}): RoverEnvConfig {
  return {
    gravityMps2: 9.80665,
    heightfield: testHeightfield(),
    terrainFriction: 0.9,
    ...overrides,
  }
}

describe('Test L — RL environment interface', () => {
  it('reset/step produce valid observations, rewards, and flags', () => {
    const env = new RoverEnv(envConfig())
    try {
      const initial = env.reset(7)
      expect(initial.observation).toHaveLength(12)
      for (const value of initial.observation) {
        expect(Number.isFinite(value)).toBe(true)
      }
      expect(env.isTerminated()).toBe(false)
      expect(env.isTruncated()).toBe(false)

      let result = env.step({ left: 0.6, right: 0.6, brake: false, eStop: false })
      for (let i = 0; i < 4; i += 1) {
        result = env.step({ left: 0.6, right: 0.6, brake: false, eStop: false })
      }
      expect(result.observation).toHaveLength(12)
      expect(Number.isFinite(result.reward)).toBe(true)
      expect(result.reward).toBe(env.getReward())
      expect(result.info.steps).toBe(5)
      expect(result.info.missionStatus).toBe('active')
      expect(result.info.batteryPercent).toBeLessThan(1)
      expect(result.terms.total).toBeCloseTo(result.reward, 9)
    } finally {
      env.dispose()
    }
  })

  it('truncates on mission time limit', () => {
    const env = new RoverEnv(envConfig({ timeLimitS: 0.1 }))
    try {
      env.reset(9)
      let result = env.step({ left: 0, right: 0, brake: true, eStop: false })
      for (let i = 0; i < 4 && !result.truncated; i += 1) {
        result = env.step({ left: 0, right: 0, brake: true, eStop: false })
      }
      expect(result.truncated).toBe(true)
      expect(result.terminated).toBe(false)
      expect(env.isTruncated()).toBe(true)
    } finally {
      env.dispose()
    }
  })

  it('terminates on battery depletion', () => {
    const env = new RoverEnv(envConfig({ rover: { batteryCapacityJ: 5 } }))
    try {
      env.reset(11)
      let result = env.step({ left: 1, right: 1, brake: false, eStop: false })
      for (let i = 0; i < 10 && !result.terminated; i += 1) {
        result = env.step({ left: 1, right: 1, brake: false, eStop: false })
      }
      expect(result.terminated).toBe(true)
      expect(env.isTerminated()).toBe(true)
    } finally {
      env.dispose()
    }
  })

  it('rejects invalid actions without crashing', () => {
    const env = new RoverEnv(envConfig())
    try {
      env.reset(13)
      // ExternalController fails safe to brake; the env keeps stepping.
      const result = env.step({ left: NaN, right: 0, brake: false, eStop: false })
      expect(Number.isFinite(result.reward)).toBe(true)
      expect(result.terminated).toBe(false)
    } finally {
      env.dispose()
    }
  })
})

describe('determinism', () => {
  it('reproduces initial observations for the same seed', () => {
    const first = new RoverEnv(envConfig())
    const second = new RoverEnv(envConfig())
    try {
      const obsA = first.reset(123).observation
      const obsB = second.reset(123).observation
      expect([...obsB]).toEqual([...obsA])
      const stepA = first.step({ left: 0.5, right: 0.5, brake: false, eStop: false })
      const stepB = second.step({ left: 0.5, right: 0.5, brake: false, eStop: false })
      expect(stepB.reward).toBeCloseTo(stepA.reward, 9)
    } finally {
      first.dispose()
      second.dispose()
    }
  })
})
