import { describe, expect, it } from 'vitest'
import { RobotCapabilityRegistry } from '../capabilities/RobotCapabilityRegistry'
import { allocateTask, type CooperativeTask, type RobotCandidate } from './TaskAllocator'

describe('allocateTask', () => {
  const task: CooperativeTask = {
    id: 'tow-1', kind: 'rescue', requiredCapabilities: ['tow'], priority: 10,
    target: { x: 0, y: 0, z: 0 }, status: 'requested', assignedRobotId: null,
    estimatedEnergyJ: 400, createdAtS: 0, failureReason: null,
  }

  it('selects an available capable responder and excludes unsupported or low-battery robots', () => {
    const registry = new RobotCapabilityRegistry()
    const support = registry.register('support', 'support')
    const explorer = registry.register('explorer', 'explorer')
    const candidates: RobotCandidate[] = [
      { roverId: 'support-low', profile: support, position: { x: 1, y: 0, z: 0 }, batteryPercent: 0.1, available: true, risk: 0 },
      { roverId: 'explorer', profile: explorer, position: { x: 1, y: 0, z: 0 }, batteryPercent: 1, available: true, risk: 0 },
      { roverId: 'support', profile: support, position: { x: 4, y: 0, z: 0 }, batteryPercent: 0.9, available: true, risk: 0 },
    ]
    expect(allocateTask(task, candidates)?.roverId).toBe('support')
  })
})
