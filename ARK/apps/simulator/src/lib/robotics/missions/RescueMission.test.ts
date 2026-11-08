import { describe, expect, it } from 'vitest'
import { transitionRescue, type RescueMission } from './RescueMission'

describe('rescue mission state machine', () => {
  it('allows legal transitions and rejects skipping a coordination phase', () => {
    const mission: RescueMission = {
      id: 'r', explorerId: 'a', responderId: null, failure: null, phase: 'idle', startTimeS: 0,
      failurePosition: null, safeTarget: { x: 0, y: 0, z: 0 }, elapsedS: 0, rescuedDistanceM: 0,
    }
    expect(transitionRescue(mission, 'exploring').phase).toBe('exploring')
    expect(() => transitionRescue(mission, 'recovering')).toThrow(/Invalid rescue transition/)
  })
})
