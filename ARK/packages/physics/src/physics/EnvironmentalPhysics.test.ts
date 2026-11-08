import { beforeAll, describe, expect, it } from 'vitest'

import { EnvironmentController } from '../environment/EnvironmentController'
import { generateHeightfield } from '../terrain/generateHeightfield'
import { getPlanet, resolveTerrainParams } from '../worlds/planetPresets'
import { PhysicsWorld } from './PhysicsWorld'

beforeAll(async () => {
  await PhysicsWorld.init()
})

/** Drops the wind box from 5 m under a steady wind; returns +X drift after 3 s. */
function windDrift(density: number, windX: number, aeroEnabled: boolean): number {
  const world = new PhysicsWorld()
  try {
    world.setAeroEnabled(aeroEnabled)
    // Park the default sphere away (still on the 60 m ground) so spawn
    // overlap cannot perturb the box.
    world.resetSphere({ x: 20, y: 5, z: 0 })
    world.createWindTestBox({ x: 0, y: 5, z: 0 })
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.setWindVector({ x: windX, y: 0, z: 0 })
    // Override density via a synthetic state (planets stay untouched).
    for (let step = 0; step < 180; step += 1) {
      const state = controller.update(step / 60, 1 / 60)
      world.applyEnvironment({ ...state, airDensity: density, aeroEnabled })
      world.step()
    }
    return world.boxPosition.x
  } finally {
    world.dispose()
  }
}

describe('Wind forces move bodies through Rapier', () => {
  it('pushes the test box downwind on Earth', () => {
    const drift = windDrift(1.225, 20, true)
    expect(drift).toBeGreaterThan(2)
  })

  it('pushes far less in thin Martian air for the same wind', () => {
    const earth = windDrift(1.225, 20, true)
    const mars = windDrift(0.02, 20, true)
    // Bounded landing-settle jitter only (millimeters); no wind-driven drift.
    expect(mars).toBeGreaterThan(-0.05)
    expect(mars).toBeLessThan(earth * 0.15)
  })

  it('leaves bodies still when aerodynamics are disabled', () => {
    const drift = windDrift(1.225, 20, false)
    // Landing settle only — an order of magnitude below wind-driven drift.
    expect(Math.abs(drift)).toBeLessThan(0.5)
  })
})

describe('Traction multiplier reaches the terrain collider', () => {
  it('scales terrain friction live without rebuilding the collider', () => {
    const world = new PhysicsWorld()
    try {
      // Flat-ground default has no tracked terrain collider; install terrain first.
      const heightfield = generateHeightfield(
        { ...resolveTerrainParams(getPlanet('earth')), subdivisions: 16 },
        7,
      )
      world.setTerrain(heightfield, 0.8, 0.3)
      const collider = world.groundBodyReference.collider(0)
      // NOTE: the compat .d.ts declares friction as a property, but the
      // binding exposes it as a getter method; read it as such.
      const readFriction = (): number => (collider.friction as unknown as () => number)()
      expect(readFriction()).toBeCloseTo(0.8, 6)

      const controller = new EnvironmentController(getPlanet('earth'))
      const saturated = controller.setSurfaceWetness(1)
      expect(saturated.tractionMultiplier).toBeCloseTo(0.55, 9)
      const wet = controller.update(0, 1 / 60)
      world.applyEnvironment(wet)
      expect(readFriction()).toBeCloseTo(0.8 * wet.tractionMultiplier, 6)

      controller.reset()
      const dry = controller.update(0, 1 / 60)
      world.applyEnvironment(dry)
      expect(readFriction()).toBeCloseTo(0.8, 3)
    } finally {
      world.dispose()
    }
  })
})
