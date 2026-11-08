import { beforeAll, describe, expect, it } from 'vitest'

import { SimulationClock } from '../core/SimulationClock'
import { FIXED_TIME_STEP } from '../types/SimulationTypes'
import { PhysicsWorld } from './PhysicsWorld'

const dt = FIXED_TIME_STEP
const GRAVITY_MAGNITUDE = 9.81

beforeAll(async () => {
  await PhysicsWorld.init()
})

function createWorld(): PhysicsWorld {
  return new PhysicsWorld({ gravity: { x: 0, y: -GRAVITY_MAGNITUDE, z: 0 } })
}

describe('PhysicsWorld', () => {
  it('Test A: free fall follows y(t) = y0 - 0.5*g*t^2 before contact', () => {
    const world = createWorld()
    try {
      const y0 = world.spherePosition.y
      // 0.5 s of fall ends well before ground contact (~0.96 s for a 4.5 m drop).
      const steps = 30
      world.advanceFixedSteps(steps)

      const t = steps * dt
      const expected = y0 - 0.5 * GRAVITY_MAGNITUDE * t * t
      // Semi-implicit Euler lags the analytic solution by ~g*t*dt/2 (0.041 m here).
      expect(Math.abs(world.spherePosition.y - expected)).toBeLessThan(0.06)
    } finally {
      world.dispose()
    }
  })

  it('Test B: never passes through the ground and settles at center height ~= radius', () => {
    const world = createWorld()
    try {
      let minY = Number.POSITIVE_INFINITY
      for (let i = 0; i < 420; i += 1) {
        world.step(dt)
        minY = Math.min(minY, world.spherePosition.y)
      }

      // No tunneling: at ~9.4 m/s impact speed one 1/60 s step moves ~0.16 m,
      // so transient discrete overlap can reach ~0.34 but never nears the
      // surface plane (Y = 0), let alone passes through the ground slab.
      expect(minY).toBeGreaterThan(0.3)

      const height = world.spherePosition.y
      expect(height).toBeGreaterThanOrEqual(0.5 - 0.03)
      expect(height).toBeLessThanOrEqual(0.5 + 0.03)
    } finally {
      world.dispose()
    }
  })

  it('Test C: vertical velocity becomes increasingly negative before collision', () => {
    const world = createWorld()
    try {
      const samples: number[] = [world.sphereVelocityY]
      for (let i = 0; i < 4; i += 1) {
        world.advanceFixedSteps(5)
        samples.push(world.sphereVelocityY)
      }

      expect(samples[0]).toBe(0)
      for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]).toBeLessThan(samples[i - 1])
      }
    } finally {
      world.dispose()
    }
  })

  it('Test D: reset restores position and clears linear/angular velocity', () => {
    const world = createWorld()
    try {
      const body = world.sphereBodyReference
      const handleBefore = body.handle

      world.advanceFixedSteps(60)
      body.setLinvel({ x: 1, y: 2, z: 3 }, true)
      body.setAngvel({ x: 0.5, y: 0.5, z: 0.5 }, true)
      world.resetSphere()

      const position = world.spherePosition
      expect(position.x).toBeCloseTo(0, 5)
      expect(position.y).toBeCloseTo(5, 5)
      expect(position.z).toBeCloseTo(0, 5)
      expect(body.linvel().x).toBe(0)
      expect(body.linvel().y).toBe(0)
      expect(body.linvel().z).toBe(0)
      expect(body.angvel().x).toBe(0)
      expect(body.angvel().y).toBe(0)
      expect(body.angvel().z).toBe(0)
      // Reset reuses the body instead of recreating it.
      expect(body.handle).toBe(handleBefore)
    } finally {
      world.dispose()
    }
  })

  it('Test E: same fixed-step count gives equivalent state regardless of batching', () => {
    const worldA = createWorld()
    const worldB = createWorld()
    try {
      worldA.advanceFixedSteps(240)
      worldB.advanceFixedSteps(120)
      worldB.advanceFixedSteps(120)

      expect(worldA.spherePosition.y).toBeCloseTo(worldB.spherePosition.y, 3)
      expect(worldA.sphereVelocity.y).toBeCloseTo(worldB.sphereVelocity.y, 3)
    } finally {
      worldA.dispose()
      worldB.dispose()
    }
  })

  it('Test F: worlds can be disposed and recreated without leaking state', () => {
    const first = createWorld()
    first.advanceFixedSteps(10)
    first.dispose()

    const second = createWorld()
    try {
      expect(second.spherePosition.y).toBeCloseTo(5, 5)
      second.advanceFixedSteps(10)
      expect(second.spherePosition.y).toBeLessThan(5)
    } finally {
      second.dispose()
    }
  })
})

describe('SimulationClock', () => {
  it('clamps large frame gaps to prevent uncontrolled physics catch-up', () => {
    const clock = new SimulationClock()
    expect(clock.update(1000)).toBe(0)

    // A 10 s gap (inactive tab) must not schedule 600 steps.
    const steps = clock.update(1000 + 10_000)
    expect(steps).toBeLessThanOrEqual(Math.floor(0.25 / dt))
    expect(clock.elapsed).toBeCloseTo(steps * dt, 9)
  })

  it('accumulates time into fixed steps', () => {
    const clock = new SimulationClock()
    clock.update(0)
    // 100 ms holds exactly 6 fixed steps at 60 Hz.
    expect(clock.update(100)).toBe(6)
    expect(clock.elapsed).toBeCloseTo(6 * dt, 9)
  })
})
