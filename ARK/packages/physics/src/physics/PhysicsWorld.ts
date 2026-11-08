import RAPIER from '@dimforge/rapier3d-compat'

import { RigidBodyFactory } from './RigidBodyFactory'
import { computeDragForce, type AerodynamicBody } from './environmentalForces'
import { createTerrainBody } from '../terrain/createTerrainCollider'
import type { Heightfield } from '../terrain/generateHeightfield'
import type { EnvironmentState } from '../types/EnvironmentTypes'
import type { PhysicsConfig, Quaternion, Vector3 } from '../types/SimulationTypes'
import { DEFAULT_PHYSICS_CONFIG, FIXED_TIME_STEP } from '../types/SimulationTypes'

interface RegisteredAeroBody {
  body: RAPIER.RigidBody
  params: AerodynamicBody
}

/**
 * Rapier is the source of truth for physical state; Three.js only visualizes it.
 * Awaiting PhysicsWorld.init() once (WASM runtime) is required before construction.
 */
export class PhysicsWorld {
  public static initialized = false

  public static async init(): Promise<void> {
    if (!PhysicsWorld.initialized) {
      await RAPIER.init()
      PhysicsWorld.initialized = true
    }
  }

  public readonly gravity: Vector3
  public readonly config: PhysicsConfig
  public readonly world: RAPIER.World

  private staticBody: RAPIER.RigidBody
  private terrainCollider: RAPIER.Collider | null = null
  private terrainBaseFriction = 0
  private lastAppliedFriction = Number.NaN
  private readonly sphereBody: RAPIER.RigidBody
  private readonly initialSpherePosition: Vector3
  private windTestBox: RAPIER.RigidBody | null = null
  private aeroEnabled = false
  private readonly aeroBodies: RegisteredAeroBody[] = []

  public get isRunning(): boolean {
    return this.sphereBody.isSleeping() === false
  }

  constructor(config: Partial<PhysicsConfig> = {}) {
    if (!PhysicsWorld.initialized) {
      throw new Error('PhysicsWorld.init() must be awaited before creating a PhysicsWorld instance.')
    }

    this.config = {
      ...DEFAULT_PHYSICS_CONFIG,
      gravity: { ...DEFAULT_PHYSICS_CONFIG.gravity },
      sphereInitialPosition: { ...DEFAULT_PHYSICS_CONFIG.sphereInitialPosition },
      ...config,
    }

    this.gravity = this.config.gravity
    this.world = new RAPIER.World(this.gravity)
    this.world.timestep = FIXED_TIME_STEP
    this.terrainBaseFriction = this.config.groundFriction
    this.lastAppliedFriction = this.config.groundFriction

    this.initialSpherePosition = { ...this.config.sphereInitialPosition }

    this.staticBody = RigidBodyFactory.createGround(this.world, this.config)
    this.sphereBody = RigidBodyFactory.createSphere(this.world, this.config)
    // Sphere aerodynamics: Cd 0.47, cross-section PI * r^2. Documented assumption.
    this.aeroBodies.push({
      body: this.sphereBody,
      params: {
        dragCoefficient: 0.47,
        area: Math.PI * this.config.sphereRadius * this.config.sphereRadius,
      },
    })
  }

  /**
   * Changes gravity live (m/s^2 magnitude, applied along -Y). The Rapier
   * pipeline reads world.gravity each step, so no world rebuild is needed.
   */
  public setGravity(magnitude: number): void {
    this.gravity.y = -magnitude
    this.config.gravity.y = -magnitude
    this.world.gravity.y = -magnitude
  }

  /**
   * Replaces the static ground (flat plane or previous terrain) with a new
   * terrain collider over the given heightfield. Exactly one static body
   * exists at any time: the old body and its colliders are removed first.
   */
  public setTerrain(heightfield: Heightfield, friction: number, restitution: number): void {
    this.world.removeRigidBody(this.staticBody)
    const terrain = createTerrainBody(this.world, heightfield, { friction, restitution })
    this.staticBody = terrain.body
    this.terrainCollider = terrain.collider
    this.terrainBaseFriction = friction
    this.lastAppliedFriction = friction
  }

  /**
   * Applies one environment state to the physics world: aerodynamic drag on
   * registered bodies (when enabled) plus the traction-scaled terrain
   * friction. Called once per fixed step, before stepping. Drag forces go
   * through Rapier's force accumulator — positions are never touched directly.
   */
  public applyEnvironment(state: EnvironmentState): void {
    const enabled = this.aeroEnabled && state.aeroEnabled
    for (const { body, params } of this.aeroBodies) {
      body.resetForces(false)
      if (!enabled) continue
      const velocity = body.linvel()
      const force = computeDragForce(
        state.airDensity,
        params,
        { x: velocity.x, y: velocity.y, z: velocity.z },
        state.wind,
      )
      // Skip negligible forces without waking: sleeping bodies stay asleep.
      if (force.x === 0 && force.y === 0 && force.z === 0) continue
      body.addForce(force, true)
    }

    if (this.terrainCollider) {
      const friction = Math.max(this.terrainBaseFriction * state.tractionMultiplier, 0)
      if (Math.abs(friction - this.lastAppliedFriction) > 1e-3) {
        this.terrainCollider.setFriction(friction)
        this.lastAppliedFriction = friction
      }
    }
  }

  /** Master switch for aerodynamic forces. Off by default (still air in tests). */
  public setAeroEnabled(enabled: boolean): void {
    this.aeroEnabled = enabled
  }

  public get isAeroEnabled(): boolean {
    return this.aeroEnabled
  }

  /** Effective ground friction currently applied (base × traction multiplier). */
  public get terrainFriction(): number {
    return this.lastAppliedFriction
  }

  /**
   * Creates the opt-in wind demonstration box (idempotent). Kept out of the
   * constructor so headless physics tests keep their exact body counts.
   */
  public createWindTestBox(position: Vector3): RAPIER.RigidBody {
    if (this.windTestBox) return this.windTestBox
    const box = RigidBodyFactory.createWindTestBox(this.world, position)
    this.windTestBox = box
    // Box aerodynamics: Cd 1.05 (cube), face area 0.25 m^2. Documented assumption.
    this.aeroBodies.push({ body: box, params: { dragCoefficient: 1.05, area: 0.25 } })
    return box
  }

  public get hasWindTestBox(): boolean {
    return this.windTestBox !== null
  }

  public resetWindTestBox(position: Vector3): void {
    if (this.windTestBox) {
      RigidBodyFactory.resetBodyTranslation(this.windTestBox, { ...position })
    }
  }

  public get boxPosition(): Vector3 {
    if (!this.windTestBox) throw new Error('Wind test box has not been created.')
    const translation = this.windTestBox.translation()
    return { x: translation.x, y: translation.y, z: translation.z }
  }

  public get boxRotation(): Quaternion {
    if (!this.windTestBox) throw new Error('Wind test box has not been created.')
    const rotation = this.windTestBox.rotation()
    return { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }
  }

  public get boxVelocityY(): number {
    if (!this.windTestBox) throw new Error('Wind test box has not been created.')
    return this.windTestBox.linvel().y
  }

  public get bodyCount(): number {
    return this.world.bodies.len()
  }

  public get colliderCount(): number {
    return this.world.colliders.len()
  }

  public step(dt: number = FIXED_TIME_STEP): void {
    this.world.timestep = dt
    this.world.step()
  }

  public advanceFixedSteps(stepCount: number, dt: number = FIXED_TIME_STEP): void {
    for (let i = 0; i < stepCount; i += 1) {
      this.step(dt)
    }
  }

  public resetSphere(position: Vector3 = this.initialSpherePosition): void {
    RigidBodyFactory.resetBodyTranslation(this.sphereBody, { ...position })
  }

  public get spherePosition(): Vector3 {
    const translation = this.sphereBody.translation()
    return { x: translation.x, y: translation.y, z: translation.z }
  }

  public get sphereRotation(): Quaternion {
    const rotation = this.sphereBody.rotation()
    return { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }
  }

  public get sphereVelocity(): Vector3 {
    const velocity = this.sphereBody.linvel()
    return { x: velocity.x, y: velocity.y, z: velocity.z }
  }

  public get sphereVelocityY(): number {
    return this.sphereBody.linvel().y
  }

  public get sphereBodyReference(): RAPIER.RigidBody {
    return this.sphereBody
  }

  public get groundBodyReference(): RAPIER.RigidBody {
    return this.staticBody
  }

  public dispose(): void {
    this.world.free()
  }
}
