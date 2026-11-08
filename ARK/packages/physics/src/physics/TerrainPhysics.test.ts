import { beforeAll, describe, expect, it } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'

import { PhysicsWorld } from './PhysicsWorld'
import type { Heightfield } from '../terrain/generateHeightfield'
import { generateHeightfield } from '../terrain/generateHeightfield'
import { getTerrainHeight, getTerrainSlope } from '../terrain/terrainSampling'
import { FIXED_TIME_STEP } from '../types/SimulationTypes'
import type { PlanetId } from '../worlds/PlanetConfig'
import { getPlanet, resolveTerrainParams } from '../worlds/planetPresets'

const dt = FIXED_TIME_STEP
const SPHERE_RADIUS = 0.5

beforeAll(async () => {
  await PhysicsWorld.init()
})

function testHeightfield(planet: PlanetId, seed: number, subdivisions = 64): Heightfield {
  const params = { ...resolveTerrainParams(getPlanet(planet)), subdivisions }
  return generateHeightfield(params, seed)
}

/**
 * Independent triangle-plane interpolation using the documented mesh split
 * (cell diagonal b-c). The physics surface must match this exactly at
 * interior points; grid nodes are covered separately against raw samples.
 */
function triangleHeight(heightfield: Heightfield, x: number, z: number): number {
  const { nrows, ncols, width, depth, heights } = heightfield
  const fx = (x / width + 0.5) * (ncols - 1)
  const fz = (z / depth + 0.5) * (nrows - 1)
  const col = Math.floor(fx)
  const row = Math.floor(fz)
  const tx = fx - col
  const tz = fz - row
  const a = heights[row * ncols + col] ?? 0
  const b = heights[row * ncols + col + 1] ?? 0
  const c = heights[(row + 1) * ncols + col] ?? 0
  const d = heights[(row + 1) * ncols + col + 1] ?? 0
  if (tx + tz <= 1) {
    return a + (c - a) * tz + (b - a) * tx
  }
  const u = tx + tz - 1
  const v = 1 - tx
  return b + u * (d - b) + v * (c - b)
}

function rayHitY(world: PhysicsWorld, x: number, z: number, fromY: number): number {
  const origin = { x, y: fromY, z }
  const hit = world.world.castRay(
    new RAPIER.Ray(origin, { x: 0, y: -1, z: 0 }),
    fromY + 50,
    false,
    undefined,
    undefined,
    undefined,
    world.sphereBodyReference,
  )
  if (!hit) throw new Error(`ray missed terrain at (${x}, ${z})`)
  return origin.y - hit.timeOfImpact
}

function steepPoint(heightfield: Heightfield): { x: number; z: number } {
  let best = { x: 10, z: 10 }
  let bestSlope = 0
  for (let z = -80; z <= 80; z += 8) {
    for (let x = -80; x <= 80; x += 8) {
      const slope = getTerrainSlope(heightfield, x, z)
      if (slope > bestSlope) {
        bestSlope = slope
        best = { x: x + 0.37, z: z - 0.53 }
      }
    }
  }
  return best
}

describe('Test D: terrain collision matches the rendered surface', () => {
  for (const planet of ['earth', 'mars'] as const) {
    it(`ray-cast surface agrees with heightfield on ${planet}`, () => {
      const config = getPlanet(planet)
      const heightfield = testHeightfield(planet, 2024)
      const world = new PhysicsWorld()
      try {
        world.setGravity(config.gravity)
        world.setTerrain(heightfield, config.terrainFriction, config.terrainRestitution)
        world.step()

        let maxHeight = -Infinity
        for (const h of heightfield.heights) maxHeight = Math.max(maxHeight, h)
        const fromY = maxHeight + 30
        const steep = steepPoint(heightfield)
        const interior: Array<[number, number]> = [
          [3.7, -11.2],
          [-27.9, 14.6],
          [41.3, 33.1],
          [-58.4, -47.7],
          [12.9, 62.5],
          [-9.1, -3.3],
          [steep.x, steep.z],
        ]
        for (const [x, z] of interior) {
          expect(rayHitY(world, x, z, fromY)).toBeCloseTo(triangleHeight(heightfield, x, z), 2)
        }

        // Exact agreement at grid nodes (all interpolation schemes coincide).
        const { ncols, nrows, width, depth } = heightfield
        const cellX = width / (ncols - 1)
        const cellZ = depth / (nrows - 1)
        for (const [row, col] of [[5, 9], [40, 22], [33, 55], [60, 60]]) {
          const x = -width / 2 + col * cellX
          const z = -depth / 2 + row * cellZ
          expect(rayHitY(world, x + 1e-3, z + 1e-3, fromY)).toBeCloseTo(
            heightfield.heights[row * ncols + col] ?? NaN,
            1,
          )
        }
      } finally {
        world.dispose()
      }
    })

    it(`dropped spheres rest on the ${planet} surface without tunneling`, () => {
      const config = getPlanet(planet)
      // Full app resolution: 1.25 m cells keep triangle-vs-bilinear crease
      // effects at centimeter scale.
      const heightfield = testHeightfield(planet, 555, 160)
      const world = new PhysicsWorld()
      try {
        world.setGravity(config.gravity)
        world.setTerrain(heightfield, config.terrainFriction, config.terrainRestitution)
        for (const [x, z] of [[0, 0], [27.3, -41.7]] as const) {
          const surface = getTerrainHeight(heightfield, x, z)
          world.resetSphere({ x, y: surface + 8, z })
          let minClearance = Infinity
          for (let step = 0; step < 900; step += 1) {
            world.step(dt)
            const position = world.spherePosition
            const ground = getTerrainHeight(heightfield, position.x, position.z)
            minClearance = Math.min(minClearance, position.y - ground - SPHERE_RADIUS)
          }
          const rest = world.spherePosition
          const restGround = getTerrainHeight(heightfield, rest.x, rest.z)
          // Rests on the visible surface (sampled under the final position,
          // so rolling on slopes does not weaken the check).
          expect(rest.y - restGround - SPHERE_RADIUS).toBeGreaterThanOrEqual(-0.04)
          expect(rest.y - restGround - SPHERE_RADIUS).toBeLessThanOrEqual(0.08)
          // Never tunnels through the surface mid-flight. Transient overlap
          // up to one integration step (~0.2 m at impact speed) is expected
          // discrete-step behavior; tunneling would plunge meters below.
          expect(minClearance).toBeGreaterThan(-0.35)
        }
      } finally {
        world.dispose()
      }
    })
  }
})

describe('Test E: planetary gravity', () => {
  it('falls slower on Mars and matches free-fall analytics on both worlds', () => {
    const world = new PhysicsWorld()
    try {
      const dropY = (gravity: number, steps: number): number => {
        world.setGravity(gravity)
        expect(world.gravity.y).toBeCloseTo(-gravity, 6)
        world.resetSphere({ x: 0, y: 5, z: 0 })
        world.advanceFixedSteps(steps)
        return world.spherePosition.y
      }

      const steps = 30
      const t = steps * dt
      const earthY = dropY(getPlanet('earth').gravity, steps)
      expect(earthY).toBeCloseTo(5 - 0.5 * getPlanet('earth').gravity * t * t, 1)
      const marsY = dropY(getPlanet('mars').gravity, steps)
      expect(marsY).toBeCloseTo(5 - 0.5 * getPlanet('mars').gravity * t * t, 1)
      expect(marsY).toBeGreaterThan(earthY)
    } finally {
      world.dispose()
    }
  })
})

describe('Test G: repeated terrain swaps do not leak bodies or colliders', () => {
  it('holds body and collider counts steady across regenerations', () => {
    const world = new PhysicsWorld()
    try {
      const bodiesBefore = world.bodyCount
      const collidersBefore = world.colliderCount
      expect(bodiesBefore).toBe(2)
      expect(collidersBefore).toBe(2)

      for (let i = 0; i < 6; i += 1) {
        const planet = i % 2 === 0 ? 'earth' : 'mars'
        const config = getPlanet(planet)
        const heightfield = testHeightfield(planet, 1000 + i)
        world.setGravity(config.gravity)
        world.setTerrain(heightfield, config.terrainFriction, config.terrainRestitution)
        expect(world.bodyCount).toBe(bodiesBefore)
        expect(world.colliderCount).toBe(collidersBefore)
      }

      // The world still steps and collides after repeated swaps.
      world.advanceFixedSteps(120)
      expect(Number.isFinite(world.spherePosition.y)).toBe(true)
    } finally {
      world.dispose()
    }
  })
})
