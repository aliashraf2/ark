import { describe, expect, it } from 'vitest'
import { createPpoController, type BrowserPpoPolicy } from './PpoPolicy'
import { resolveRoverConfig } from '../../../../../packages/physics/src/robotics/RoverConfig'

describe('stabilized PPO controller', () => {
  it('bounds differential wheel effort and damps high yaw rate', () => {
    const policy: BrowserPpoPolicy = {
      format: 'ark-ppo-mlp-v1', planet: 'mars', trainedTimesteps: 5_120,
      observationSize: 12, activation: 'tanh',
      hiddenLayers: [{ weights: Array.from({ length: 4 }, () => Array(12).fill(0)), bias: [0, 0, 0, 0] }],
      actionLayer: { weights: [[0, 0, 0, 0], [0, 0, 0, 0]], bias: [1, -1] },
    }
    const controller = createPpoController(policy)
    const action = controller.update({
      position: { x: 0, y: 0, z: 0 }, yawRad: 0, yawRateRadS: 3, speed: 0,
      ranges: [], target: { x: 10, y: 0, z: 10 }, arrived: false, batteryPercent: 1,
      traction: 1, roverConfig: resolveRoverConfig(),
    }, 1 / 60)
    expect(Math.abs(action.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(action.right)).toBeLessThanOrEqual(1)
    expect(Math.abs(action.right - action.left) / 2).toBeLessThanOrEqual(0.35)
  })
})
