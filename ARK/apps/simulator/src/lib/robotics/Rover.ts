import RAPIER from '@dimforge/rapier3d-compat'

import type { Quaternion, Vector3 } from '../types/SimulationTypes'
import { mulberry32 } from '../terrain/terrainNoise'
import type { DriveAction, InertialReading, RangeReading, RoverConfig } from './RoverConfig'
import {
  addGaussianNoise,
  batteryReading,
  computeDrive,
  eulerFromQuaternion,
  forwardFromYaw,
  inertialFromBody,
  powerDrawW,
  stepBatteryCharge,
  validateAction,
  type DriveContext,
} from './RoverDynamics'

export interface RoverSpawn {
  position: Vector3
  yawRad?: number
}

export interface RoverStepContext {
  gravityMps2: number
  traction: number
  dt: number
}

/**
 * One physical rover: a single dynamic Rapier body (chassis cuboid + 4 wheel
 * ball colliders as one compound) driven by contact-aware forces. Rapier owns
 * all motion — this class only applies forces/torques and reads state.
 *
 * Approximation (documented): no jointed wheels/suspension; steering is yaw
 * torque and lateral tire grip is emulated slip damping (see RoverDynamics).
 */
export class Rover {
  public readonly id: string
  public readonly config: RoverConfig

  private readonly world: RAPIER.World
  private readonly body: RAPIER.RigidBody
  private chargeJ: number
  private lastPowerW = 0
  private lastAction = { left: 0, right: 0, brake: false, eStop: false }
  private random: () => number
  private lastRanges: RangeReading[] = []

  constructor(world: RAPIER.World, id: string, config: RoverConfig, spawn: RoverSpawn, seed: number) {
    this.world = world
    this.id = id
    this.config = config
    this.chargeJ = config.batteryCapacityJ
    this.random = mulberry32(seed)

    const yaw = spawn.yawRad ?? 0
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0)
        .setAngularDamping(0.6)
        .setCanSleep(false),
    )

    const half = config.chassisHalfExtents
    const chassis = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(0, config.chassisHeight, 0)
      .setDensity(config.density)
      .setFriction(config.friction)
      .setRestitution(config.restitution)
    world.createCollider(chassis, this.body)

    for (const offset of config.wheelOffsets) {
      const wheel = RAPIER.ColliderDesc.ball(config.wheelRadius)
        .setTranslation(offset.x, config.wheelRadius, offset.z)
        .setDensity(config.density)
        .setFriction(config.friction)
        .setRestitution(config.restitution)
      world.createCollider(wheel, this.body)
    }

    this.lastRanges = this.config.sensorAngles.map((angleRad) => ({
      angleRad,
      distance: config.sensorRange,
      hit: false,
      validity: 'ok' as const,
    }))
  }

  public get position(): Vector3 {
    const t = this.body.translation()
    return { x: t.x, y: t.y, z: t.z }
  }

  public get rotation(): Quaternion {
    const r = this.body.rotation()
    return { x: r.x, y: r.y, z: r.z, w: r.w }
  }

  public get yawRad(): number {
    return eulerFromQuaternion(this.rotation).yaw
  }

  public get linearVelocity(): Vector3 {
    const v = this.body.linvel()
    return { x: v.x, y: v.y, z: v.z }
  }

  public get angularVelocity(): Vector3 {
    const w = this.body.angvel()
    return { x: w.x, y: w.y, z: w.z }
  }

  public get massKg(): number {
    return this.body.mass()
  }

  public get inertial(): InertialReading {
    return inertialFromBody(this.rotation, this.linearVelocity, this.angularVelocity)
  }

  public get ranges(): ReadonlyArray<RangeReading> {
    return this.lastRanges
  }

  public get batteryChargeJ(): number {
    return this.chargeJ
  }

  public get lastPowerDrawW(): number {
    return this.lastPowerW
  }

  public get depleted(): boolean {
    return this.chargeJ <= 0
  }

  /** Applies one validated action as forces for this fixed step. Pure-computed. */
  public applyAction(action: DriveAction, ctx: RoverStepContext): void {
    const validated = validateAction(action)
    this.lastAction = validated
    const driveCtx: DriveContext = {
      massKg: this.massKg,
      gravityMps2: ctx.gravityMps2,
      traction: ctx.traction,
      yawRad: this.yawRad,
      velocity: this.linearVelocity,
      dt: ctx.dt,
      chargeJ: this.chargeJ,
    }
    const output = computeDrive(this.config, validated, driveCtx)
    this.body.resetForces(false)
    this.body.addForce(output.force, true)
    this.body.addTorque(output.torque, true)
    if (output.snapStop) {
      const v = this.body.linvel()
      this.body.setLinvel({ x: 0, y: v.y, z: 0 }, true)
    }
    this.lastPowerW = powerDrawW(this.config, validated)
    this.chargeJ = stepBatteryCharge(this.chargeJ, this.lastPowerW, ctx.dt)
  }

  /** Refreshes distance sensors from the live physics world (raycasts). */
  public senseRanges(): ReadonlyArray<RangeReading> {
    const origin = this.position
    const sensorY = origin.y + this.config.chassisHeight + this.config.sensorHeight
    const yaw = this.yawRad
    this.lastRanges = this.config.sensorAngles.map((angle) => {
      const worldAngle = yaw + angle
      const dir = forwardFromYaw(worldAngle)
      const ray = new RAPIER.Ray({ x: origin.x, y: sensorY, z: origin.z }, dir)
      const hit = this.world.castRay(
        ray,
        this.config.sensorRange,
        false,
        undefined,
        undefined,
        undefined,
        this.body,
      )
      let distance = this.config.sensorRange
      let didHit = false
      if (hit) {
        distance = Math.min(hit.timeOfImpact, this.config.sensorRange)
        didHit = true
      }
      if (this.config.sensorNoiseSigma > 0) {
        distance = Math.max(
          0,
          Math.min(
            this.config.sensorRange,
            addGaussianNoise(distance, this.config.sensorNoiseSigma, this.random),
          ),
        )
      }
      return {
        angleRad: angle,
        distance,
        hit: didHit,
        validity: 'ok' as const,
      }
    })
    return this.lastRanges
  }

  public battery(): ReturnType<typeof batteryReading> {
    return batteryReading(this.chargeJ, this.config.batteryCapacityJ, this.lastPowerW)
  }

  /** Restores spawn transform, clears velocities, refills battery, reseeds noise. */
  public reset(spawn: RoverSpawn, seed: number): void {
    const yaw = spawn.yawRad ?? 0
    this.body.setTranslation({ x: spawn.position.x, y: spawn.position.y, z: spawn.position.z }, true)
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.body.resetForces(false)
    this.chargeJ = this.config.batteryCapacityJ
    this.lastPowerW = 0
    this.random = mulberry32(seed)
    this.senseRanges()
  }

  public dispose(): void {
    this.world.removeRigidBody(this.body)
  }
}
