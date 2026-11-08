import { describe, expect, it } from 'vitest'
import { FailureDetector } from './FailureDetector'

describe('FailureDetector', () => {
  it('does not flag idle stationary rovers but reports an explicit motor failure', () => {
    const detector = new FailureDetector()
    const idle = { dt: 1, position: { x: 0, y: 0, z: 0 }, distanceToGoal: 5, commandedEffort: 0, motorEnabled: true, batteryPercent: 1, upY: 1 }
    expect(detector.observe('idle', idle)).toBeNull()
    expect(detector.observe('idle', { ...idle, motorEnabled: false })).toBe('drive-motor-failure')
  })

  it('detects sustained effort without physical movement', () => {
    const detector = new FailureDetector()
    const effort = { dt: 1, position: { x: 0, y: 0, z: 0 }, distanceToGoal: 5, commandedEffort: 0.8, motorEnabled: true, batteryPercent: 1, upY: 1 }
    expect(detector.observe('stuck', effort)).toBeNull()
    expect(detector.observe('stuck', effort)).toBeNull()
    expect(detector.observe('stuck', effort)).toBeNull()
    expect(detector.observe('stuck', effort)).toBe('immobilized')
  })
})
