import { beforeAll, describe, expect, it } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'

import { PhysicsWorld } from '../physics/PhysicsWorld'
import { generateHeightfield } from '../terrain/generateHeightfield'
import { getTerrainHeight } from '../terrain/terrainSampling'
import { getPlanet, resolveTerrainParams } from '../worlds/planetPresets'
import { FIXED_TIME_STEP } from '../types/SimulationTypes'
import { resolveRoverConfig } from './RoverConfig'
import { downhillYaw, footprintSpawnHeight, slopeMagnitude } from './RoverDynamics'
import { Rover, type RoverStepContext } from './Rover'
import { RobotManager } from './RobotManager'
import {
  ExternalController,
  ManualController,
  NavigationController,
} from './controllers'
import { validateAction } from './RoverDynamics'

const DT = FIXED_TIME_STEP

beforeAll(async () => {
  await PhysicsWorld.init()
})

/** Bare world with a flat static ground plane at y = 0. */
function flatWorld(gravityY = -9.80665): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 })
  world.timestep = DT
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0))
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setFriction(0.9), ground)
  return world
}

function stepContext(overrides: Partial<RoverStepContext> = {}): RoverStepContext {
  return { gravityMps2: 9.80665, traction: 0.9, dt: DT, ...overrides }
}

function driveSteps(
  world: RAPIER.World,
  rover: Rover,
  action: { left: number; right: number; brake: boolean; eStop: boolean },
  count: number,
  ctx: RoverStepContext = stepContext(),
): void {
  for (let i = 0; i < count; i += 1) {
    rover.applyAction(action, ctx)
    world.step()
  }
}

describe('Test A — spawn without intersection', () => {
  it('settles onto flat ground at wheel height', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-a',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 } },
        11,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 120)
      // Body origin is the contact plane: rests at y ~= 0 (wheel bottoms on y=0).
      expect(rover.position.y).toBeCloseTo(0, 1)
      expect(rover.position.y).toBeGreaterThan(-0.03)
    } finally {
      world.free()
    }
  })
})

describe('Test B — planetary gravity', () => {
  it('falls slower under Mars gravity', () => {
    const earth = flatWorld(-9.80665)
    const mars = flatWorld(-3.71)
    try {
      const earthRover = new Rover(
        earth,
        'rover-earth',
        resolveRoverConfig(),
        { position: { x: 0, y: 5, z: 0 } },
        21,
      )
      const marsRover = new Rover(
        mars,
        'rover-mars',
        resolveRoverConfig(),
        { position: { x: 0, y: 5, z: 0 } },
        21,
      )
      for (let i = 0; i < 30; i += 1) {
        earthRover.applyAction({ left: 0, right: 0, brake: false, eStop: false }, stepContext())
        marsRover.applyAction(
          { left: 0, right: 0, brake: false, eStop: false },
          stepContext({ gravityMps2: 3.71 }),
        )
        earth.step()
        mars.step()
      }
      // Free fall 0.5 s: earth y ~= 5 - 1.23, mars y ~= 5 - 0.46.
      expect(earthRover.position.y).toBeLessThan(marsRover.position.y)
      expect(earthRover.position.y).toBeCloseTo(5 - 0.5 * 9.80665 * 0.25, 0)
      expect(marsRover.position.y).toBeCloseTo(5 - 0.5 * 3.71 * 0.25, 0)
    } finally {
      earth.free()
      mars.free()
    }
  })
})

describe('Test C — drive commands move the rover', () => {
  it('advances along +Z under full forward effort', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-c',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 } },
        31,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 180)
      expect(rover.position.z).toBeGreaterThan(2)
      expect(Math.abs(rover.position.x)).toBeLessThan(0.5)
      expect(rover.position.y).toBeLessThan(0.5)
    } finally {
      world.free()
    }
  })

  it('yaws under differential effort', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-turn',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 } },
        32,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      const yawBefore = rover.yawRad
      driveSteps(world, rover, { left: -1, right: 1, brake: false, eStop: false }, 90)
      expect(Math.abs(rover.yawRad - yawBefore)).toBeGreaterThan(0.2)
    } finally {
      world.free()
    }
  })
})

describe('Test D — braking', () => {
  it('reduces speed to near zero', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-d',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 } },
        41,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 120)
      expect(rover.inertial.speed).toBeGreaterThan(1)
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 180)
      const velocity = rover.linearVelocity
      expect(Math.hypot(velocity.x, velocity.z)).toBeLessThan(0.15)
    } finally {
      world.free()
    }
  })
})

describe('Test E — obstacle collision', () => {
  it('is stopped by a wall instead of passing through', () => {
    const world = flatWorld()
    try {
      const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1, 5.1))
      world.createCollider(RAPIER.ColliderDesc.cuboid(3, 1, 0.1), wall)
      const rover = new Rover(
        world,
        'rover-e',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 } },
        51,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 600)
      // Wall face at z = 5.0; chassis front must stay behind it.
      expect(rover.position.z).toBeLessThan(4.7)
      expect(rover.position.z).toBeGreaterThan(3.5)
    } finally {
      world.free()
    }
  })
})

describe('Test F — distance sensors', () => {
  it('reports known obstacle distances within tolerance', () => {
    const world = flatWorld()
    try {
      // Wide wall: the ±40° rays hit it at x = ±5·tan40° ≈ ±4.2.
      const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1, 5.1))
      world.createCollider(RAPIER.ColliderDesc.cuboid(8, 1, 0.1), wall)
      const rover = new Rover(
        world,
        'rover-f',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 }, yawRad: 0 },
        61,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      const ranges = rover.senseRanges()
      expect(ranges).toHaveLength(5)
      // Center ray: wall face at z = 5.0 from origin.
      expect(ranges[2]?.distance).toBeCloseTo(5, 0)
      // Side rays travel 5 / cos(angle) to the same wall.
      expect(ranges[1]?.distance).toBeCloseTo(5 / Math.cos(0.3491), 0)
      expect(ranges[0]?.distance).toBeCloseTo(5 / Math.cos(0.6981), 0)
      for (const reading of ranges) {
        expect(reading.hit).toBe(true)
        expect(reading.validity).toBe('ok')
      }
    } finally {
      world.free()
    }
  })

  it('returns max range on a miss', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-far',
        resolveRoverConfig(),
        { position: { x: 0, y: 0.05, z: 0 }, yawRad: 0 },
        62,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      const ranges = rover.senseRanges()
      for (const reading of ranges) {
        expect(reading.hit).toBe(false)
        expect(reading.distance).toBe(resolveRoverConfig().sensorRange)
      }
    } finally {
      world.free()
    }
  })
})

describe('Test G — battery', () => {
  it('drains within bounds and a depleted rover cannot drive', () => {
    const world = flatWorld()
    try {
      const config = resolveRoverConfig({ batteryCapacityJ: 60 })
      const rover = new Rover(
        world,
        'rover-g',
        config,
        { position: { x: 0, y: 0.05, z: 0 } },
        71,
      )
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 60)
      const afterSettle = rover.batteryChargeJ
      expect(afterSettle).toBeLessThan(config.batteryCapacityJ)
      expect(afterSettle).toBeGreaterThanOrEqual(0)
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 120)
      expect(rover.depleted).toBe(true)
      expect(rover.batteryChargeJ).toBe(0)
      // Brake to rest, then full effort must not move it.
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 120)
      const rested = { ...rover.position }
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 120)
      expect(Math.hypot(rover.position.x - rested.x, rover.position.z - rested.z)).toBeLessThan(0.25)
    } finally {
      world.free()
    }
  })
})

describe('Test H — controller independence', () => {
  const input = {
    position: { x: 0, y: 0, z: 0 },
    yawRad: 0,
    yawRateRadS: 0,
    speed: 0,
    ranges: [],
    target: { x: 0, y: 0, z: 10 },
    arrived: false,
  }

  it('manual and navigation controllers emit valid actions', () => {
    const manual = new ManualController()
    manual.setKeys({ forward: true, reverse: false, turnLeft: true, turnRight: false, brake: false })
    expect(() => validateAction(manual.update(input, DT))).not.toThrow()
    // Parking hold: neutral sticks engage the brake so the rover never rolls away.
    manual.reset()
    const held = manual.update(input, DT)
    expect(held.brake).toBe(true)
    expect(held.left).toBe(0)
    expect(held.right).toBe(0)
    const nav = new NavigationController()
    expect(() => validateAction(nav.update(input, DT))).not.toThrow()
    const action = nav.update(input, DT)
    expect(action.right).toBeGreaterThanOrEqual(action.left)
  })

  it('external policies are validated; invalid output fails safe', () => {
    const good = new ExternalController(() => ({ left: 0.5, right: 0.5, brake: false, eStop: false }))
    expect(good.update(input, DT).left).toBe(0.5)
    expect(good.lastError).toBeNull()
    const bad = new ExternalController(() => ({ left: NaN, right: 0, brake: false, eStop: false }))
    const safe = bad.update(input, DT)
    expect(safe.brake).toBe(true)
    expect(safe.left).toBe(0)
    expect(bad.lastError).toContain('finite')
  })
})

describe('Test J — reset', () => {
  it('restores transform, velocities, and battery', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(
        world,
        'rover-j',
        resolveRoverConfig(),
        { position: { x: 1, y: 0.05, z: 2 } },
        81,
      )
      driveSteps(world, rover, { left: 1, right: 0.4, brake: false, eStop: false }, 180)
      expect(rover.batteryChargeJ).toBeLessThan(resolveRoverConfig().batteryCapacityJ)
      rover.reset({ position: { x: 1, y: 0.05, z: 2 }, yawRad: 0 }, 81)
      expect(rover.position.x).toBeCloseTo(1, 9)
      expect(rover.position.z).toBeCloseTo(2, 9)
      expect(rover.linearVelocity).toEqual({ x: 0, y: 0, z: 0 })
      expect(rover.angularVelocity).toEqual({ x: 0, y: 0, z: 0 })
      expect(rover.batteryChargeJ).toBe(resolveRoverConfig().batteryCapacityJ)
      expect(rover.yawRad).toBeCloseTo(0, 9)
    } finally {
      world.free()
    }
  })
})

describe('Test I — multiple independent robots', () => {
  it('keeps three rovers independent', () => {
    const world = flatWorld()
    try {
      const manager = new RobotManager(world, null)
      const first = manager.spawn({ position: { x: -4, y: 0.05, z: 0 } }, {}, 91)
      const second = manager.spawn({ position: { x: 0, y: 0.05, z: 0 } }, {}, 92)
      const third = manager.spawn({ position: { x: 4, y: 0.05, z: 0 } }, {}, 93)
      expect(manager.count).toBe(3)
      const driver = manager.getController(first)
      expect(driver).toBeInstanceOf(ManualController)
      ;(driver as ManualController).setKeys({
        forward: true,
        reverse: false,
        turnLeft: false,
        turnRight: false,
        brake: false,
      })
      for (let i = 0; i < 120; i += 1) {
        manager.preStep({ dt: DT, gravityMps2: 9.80665, traction: 0.9 })
        world.step()
      }
      manager.postStep(120 * DT, null)
      const moved = manager.get(first)?.position.z ?? 0
      const stillA = manager.get(second)?.position.z ?? 99
      const stillB = manager.get(third)?.position.z ?? 99
      expect(moved).toBeGreaterThan(1)
      expect(Math.abs(stillA)).toBeLessThan(0.3)
      expect(Math.abs(stillB)).toBeLessThan(0.3)
      // Independent batteries: only the driver drained beyond idle.
      const driverCharge = manager.get(first)?.batteryChargeJ ?? 0
      const idleCharge = manager.get(second)?.batteryChargeJ ?? 0
      expect(driverCharge).toBeLessThan(idleCharge)
      expect(manager.remove(second)).toBe(true)
      expect(manager.count).toBe(2)
      expect(world.bodies.len()).toBe(3) // ground + 2 rovers
      manager.dispose()
      expect(manager.count).toBe(0)
    } finally {
      world.free()
    }
  })
})

describe('slope driving on real terrain (spawn regression)', () => {
  it('drives freely from a proper drop-spawn on a moderate slope', async () => {
    const params = { ...resolveTerrainParams(getPlanet('earth')), subdivisions: 48 }
    const heightfield = generateHeightfield(params, 4242)
    const world = new PhysicsWorld()
    world.setTerrain(heightfield, 0.9, 0.05)
    try {
      const sample = (x: number, z: number) => getTerrainHeight(heightfield, x, z)
      // A moderate, drivable slope — not the steepest cliff on the map.
      let spawn: { x: number; z: number } | null = null
      for (let x = -30; x <= 30 && !spawn; x += 6) {
        for (let z = -30; z <= 30 && !spawn; z += 6) {
          const slope = slopeMagnitude(sample, x, z)
          if (slope > 0.15 && slope < 0.35) spawn = { x, z }
        }
      }
      expect(spawn).not.toBeNull()
      const sx = spawn?.x ?? 0
      const sz = spawn?.z ?? 0
      const gx = (sample(sx + 1.5, sz) - sample(sx - 1.5, sz)) / 3
      const gz = (sample(sx, sz + 1.5) - sample(sx, sz - 1.5)) / 3
      const yaw = downhillYaw(gx, gz)
      const wheels = resolveRoverConfig({}).wheelOffsets
      const manager = new RobotManager(world.world, null)
      const id = manager.spawn(
        {
          position: { x: sx, y: footprintSpawnHeight(sample, sx, sz, yaw, wheels), z: sz },
          yawRad: yaw,
        },
        {},
        7,
      )
      const rover = manager.get(id)
      if (!rover) throw new Error('spawn failed')
      const ctx = stepContext()
      for (let i = 0; i < 60; i += 1) {
        rover.applyAction({ left: 0, right: 0, brake: true, eStop: false }, ctx)
        world.step()
      }
      const p0 = { ...rover.position }
      for (let i = 0; i < 180; i += 1) {
        rover.applyAction({ left: 0.6, right: 0.6, brake: false, eStop: false }, ctx)
        world.step()
      }
      const p1 = { ...rover.position }
      // Real driving: covers distance while staying wheels-down (up.y > 0.5),
      // not tumbling end-over-end down the slope.
      expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(2.5)
      const q = rover.rotation
      expect(1 - 2 * (q.x * q.x + q.z * q.z)).toBeGreaterThan(0.5)
      manager.dispose()
    } finally {
      world.dispose()
    }
  })
})

describe('closed-loop navigation baseline (manager + physics)', () => {
  it('turns around and drives to a 10 m target on flat ground', () => {
    const world = flatWorld()
    try {
      const manager = new RobotManager(world, null)
      // Spawn facing AWAY from the target: the baseline must turn first.
      const id = manager.spawn({ position: { x: 0, y: 0.05, z: 0 }, yawRad: Math.PI }, {}, 501)
      const rover = manager.get(id)
      if (!rover) throw new Error('spawn failed')
      manager.setController(id, new NavigationController())
      const mission = manager.missions.create(id, rover.position, { x: 0, y: 0, z: 10 }, 2, 120)
      manager.missions.start(mission.id)
      const env = { dt: DT, gravityMps2: 9.80665, traction: 0.9 }
      for (let i = 0; i < 1800; i += 1) {
        manager.preStep(env)
        world.step()
        manager.postStep(DT, null)
        if (manager.missions.get(mission.id)?.status === 'succeeded') break
      }
      // missionForRover only tracks pending/active; read the outcome by id.
      expect(manager.missions.get(mission.id)?.status).toBe('succeeded')
      const p = rover.position
      expect(Math.hypot(p.x - 0, p.z - 10)).toBeLessThan(2)
      // At rest after arrival: the yaw-rate tracker reads ~zero, not garbage.
      expect(Math.abs(rover.yawRate)).toBeLessThan(0.5)
      manager.dispose()
    } finally {
      world.free()
    }
  })

  it('yaw-rate tracker reads zero on a parked rover', () => {
    const world = flatWorld()
    try {
      const rover = new Rover(world, 'parked', resolveRoverConfig(), { position: { x: 0, y: 0.05, z: 0 } }, 502)
      const ctx = stepContext()
      for (let i = 0; i < 120; i += 1) {
        rover.applyAction({ left: 0, right: 0, brake: true, eStop: false }, ctx)
        world.step()
        rover.updateYawRate(DT)
      }
      expect(rover.yawRate).toBeCloseTo(0, 6)
    } finally {
      world.free()
    }
  })
})

describe('Test K — world change reseat (manager level)', () => {
  it('re-seats rovers onto a new surface and parks missions', () => {
    const world = flatWorld()
    try {
      const manager = new RobotManager(world, null)
      const id = manager.spawn({ position: { x: 10, y: 0.05, z: 0 } }, {}, 101)
      const rover = manager.get(id)
      if (!rover) throw new Error('spawn failed')
      driveSteps(world, rover, { left: 1, right: 1, brake: false, eStop: false }, 60)
      const mission = manager.missions.create(
        id,
        rover.position,
        { x: 10, y: 0, z: 10 },
        2,
        120,
      )
      manager.missions.start(mission.id)
      // New world: a 2 m step for x > 0.
      manager.handleWorldChange(
        { surfaceY: (x: number) => (x > 0 ? 2 : 0), halfExtent: 50 },
        7,
      )
      // Footprint-clearing drop: step surface 2 m + 0.3 m clearance.
      expect(rover.position.y).toBeCloseTo(2.3, 6)
      expect(rover.linearVelocity).toEqual({ x: 0, y: 0, z: 0 })
      expect(rover.batteryChargeJ).toBe(resolveRoverConfig().batteryCapacityJ)
      expect(manager.missions.missionForRover(id)?.status).toBe('pending')
      // Settles (onto flat y=0 here — the step is fictional) without falling through.
      driveSteps(world, rover, { left: 0, right: 0, brake: true, eStop: false }, 120)
      expect(rover.position.y).toBeCloseTo(0, 1)
      expect(rover.position.y).toBeGreaterThan(-0.03)
    } finally {
      world.free()
    }
  })
})
