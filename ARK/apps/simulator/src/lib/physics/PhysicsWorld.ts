import RAPIER from '@dimforge/rapier3d-compat'

import { RigidBodyFactory } from './RigidBodyFactory'
import { createTerrainBody } from '../terrain/createTerrainCollider'
import type { Heightfield } from '../terrain/generateHeightfield'
import type { PhysicsConfig, Quaternion, Vector3 } from '../types/SimulationTypes'
import { DEFAULT_PHYSICS_CONFIG, FIXED_TIME_STEP } from '../types/SimulationTypes'

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
  private readonly sphereBody: RAPIER.RigidBody
  private readonly initialSpherePosition: Vector3

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

    this.initialSpherePosition = { ...this.config.sphereInitialPosition }

    this.staticBody = RigidBodyFactory.createGround(this.world, this.config)
    this.sphereBody = RigidBodyFactory.createSphere(this.world, this.config)
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
    this.staticBody = createTerrainBody(this.world, heightfield, { friction, restitution })
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
