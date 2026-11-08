import { describe, expect, it } from 'vitest'
import { greedyAction, qState, updateQ, validateQPolicy, useRoverQ, RoverQController, type RoverQPolicy } from './RoverQPolicy'

const policy = (): RoverQPolicy => ({ format: 'ark-rover-q-v1', planet: 'mars', terrainSeed: 42,
  terrainSubdivisions: 160, trainedSteps: 1, trainingSeconds: 1, q: {} })
describe('rover Q-learning', () => {
  it('keeps a worse checkpoint experimental and excludes Earth', () => {
    const p = policy()
    p.evaluation = { episodes: 40, successRate: 0.075, baselineSuccessRate: 0.1, meanReturn: -27 }
    expect(useRoverQ(p, 'mars')).toBe(false)
    expect(useRoverQ(p, 'mars', true)).toBe(true)
    expect(useRoverQ(p, 'earth', true)).toBe(false)
  })
  it('uses the waypoint baseline for unseen states and breaks ties conservatively', () => {
    expect(greedyAction()).toBe(1)
    expect(greedyAction([0, 0, 0, 0, 0])).toBe(1)
    expect(greedyAction([0, 0, 2, 0, 0])).toBe(2)
  })
  it('bootstraps normal transitions but not terminal failures or goals', () => {
    const p = policy(); p.q.next = [10, 10, 10, 10, 10]
    updateQ(p, 'state', 2, 1, 'next', false, 1, 0.9)
    expect(p.q.state![2]).toBe(10)
    updateQ(p, 'state', 2, -100, 'next', true, 1, 0.9)
    expect(p.q.state![2]).toBe(-100)
  })
  it('rejects malformed observations and checkpoints before driving', () => {
    expect(() => qState([NaN])).toThrow()
    expect(() => validateQPolicy({ ...policy(), q: { '0:0:0:0:0': [Infinity] } })).toThrow()
    expect(() => validateQPolicy(policy())).not.toThrow()
  })
  it('brakes when a mission has no target', () => {
    const c = new RoverQController(policy())
    expect(c.update({ position: { x: 0, y: 0, z: 0 }, yawRad: 0, yawRateRadS: 0, speed: 0,
      ranges: [], target: null, arrived: true }, 1 / 60).brake).toBe(true)
  })
})
