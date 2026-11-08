import RAPIER from '@dimforge/rapier3d-compat'
import { applyDroneAction, buildDroneObservation, createDroneBody, DRONE_ACTION_SIZE, DRONE_OBSERVATION_SIZE, type DroneRLAction } from '../../../physics/src/robotics/DroneDynamics'
import { PhysicsWorld } from '../../../physics/src/physics/PhysicsWorld'
import { createTerrainBody } from '../../../physics/src/terrain/createTerrainCollider'
import { generateHeightfield, type Heightfield } from '../../../physics/src/terrain/generateHeightfield'
import { getTerrainHeight } from '../../../physics/src/terrain/terrainSampling'
import { mulberry32 } from '../../../physics/src/terrain/terrainNoise'
import { FIXED_TIME_STEP } from '../../../physics/src/types/SimulationTypes'
import { getPlanet, resolveTerrainParams } from '../../../physics/src/worlds/planetPresets'

export interface DroneEnvironmentConfig {
  planet?: 'earth' | 'mars'
  terrainSeed?: number
  maxSteps?: number
  actionRepeat?: number
  boundsHalfExtentM?: number
  goalMinDistanceM?: number
  goalMaxDistanceM?: number
}

export interface DroneResetOptions { start?: { x: number; z: number }; target?: { x: number; z: number } }

export class DroneEnvironment {
  private readonly planet: 'earth' | 'mars'
  private readonly heightfield: Heightfield
  private readonly gravity: number
  private readonly maxSteps: number
  private readonly actionRepeat: number
  private readonly bounds: number
  private readonly minDistance: number
  private readonly maxDistance: number
  private world: RAPIER.World
  private body: RAPIER.RigidBody | null = null
  private target = { x: 0, y: 0, z: 0 }
  private random = mulberry32(1)
  private steps = 0
  private rewardSum = 0
  private distanceTraveled = 0
  private previousDistance = 0
  private done = true
  private closed = false
  private success = false

  private constructor(config: DroneEnvironmentConfig, heightfield: Heightfield) {
    this.planet = config.planet ?? 'mars'
    const worldConfig = getPlanet(this.planet)
    this.heightfield = heightfield
    this.gravity = worldConfig.gravity
    this.maxSteps = config.maxSteps ?? 600
    this.actionRepeat = config.actionRepeat ?? 4
    this.bounds = config.boundsHalfExtentM ?? 45
    this.minDistance = config.goalMinDistanceM ?? 8
    this.maxDistance = config.goalMaxDistanceM ?? 30
    this.world = new RAPIER.World({ x: 0, y: -this.gravity, z: 0 })
  }

  public static async create(config: DroneEnvironmentConfig = {}): Promise<DroneEnvironment> {
    await PhysicsWorld.init()
    const planet = getPlanet(config.planet ?? 'mars')
    const params = resolveTerrainParams(planet, (config.planet ?? 'mars') === 'mars' ? 'smooth-basin' : 'plains')
    const heightfield = generateHeightfield({ ...params, subdivisions: 64 }, config.terrainSeed ?? 42)
    return new DroneEnvironment(config, heightfield)
  }

  public static spaces(): { observation: { shape: number[]; low: number[]; high: number[]; dtype: 'float32' }; action: { shape: number[]; low: number[]; high: number[]; dtype: 'float32' } } {
    return {
      observation: { shape: [DRONE_OBSERVATION_SIZE], low: Array(DRONE_OBSERVATION_SIZE).fill(-1), high: Array(DRONE_OBSERVATION_SIZE).fill(1), dtype: 'float32' },
      action: { shape: [DRONE_ACTION_SIZE], low: Array(DRONE_ACTION_SIZE).fill(-1), high: Array(DRONE_ACTION_SIZE).fill(1), dtype: 'float32' },
    }
  }

  public getSpaces() { return DroneEnvironment.spaces() }

  public reset(seed = 1, options: DroneResetOptions = {}): { observation: Float32Array; info: { start: { x: number; z: number }; target: { x: number; z: number }; episodeIndex: number } } {
    this.assertOpen()
    this.world.free()
    this.world = new RAPIER.World({ x: 0, y: -this.gravity, z: 0 })
    createTerrainBody(this.world, this.heightfield, { friction: getPlanet(this.planet).terrainFriction, restitution: 0.05 })
    this.random = mulberry32(seed)
    const start = options.start ?? this.randomPoint()
    const target = options.target ?? this.randomTarget(start)
    this.target = { x: target.x, y: getTerrainHeight(this.heightfield, target.x, target.z) + 5, z: target.z }
    const position = { x: start.x, y: getTerrainHeight(this.heightfield, start.x, start.z) + 5, z: start.z }
    this.body = createDroneBody(this.world, position)
    this.steps = 0
    this.rewardSum = 0
    this.distanceTraveled = 0
    this.previousDistance = this.distance(position)
    this.done = false
    this.success = false
    return { observation: this.observation(), info: { start: { ...start }, target: { x: target.x, z: target.z }, episodeIndex: seed } }
  }

  public step(action: DroneRLAction): { observation: Float32Array; reward: number; terminated: boolean; truncated: boolean; info: { metrics: Record<string, unknown>; distanceM: number; position: { x: number; y: number; z: number }; simTimeS: number } } {
    this.assertOpen()
    if (this.done || !this.body) throw new Error('step() before reset or after episode end; reset the environment.')
    if (!Array.isArray(action) || action.length !== 3 || action.some((v) => !Number.isFinite(v))) throw new Error('Drone action must contain three finite numbers.')
    const before = this.position()
    for (let i = 0; i < this.actionRepeat; i += 1) { applyDroneAction(this.body, action, this.gravity); this.world.step() }
    const position = this.position()
    const v = this.body.linvel()
    const distance = this.distance(position)
    this.distanceTraveled += Math.hypot(position.x - before.x, position.y - before.y, position.z - before.z)
    this.steps += 1
    const progress = this.previousDistance - distance
    const altitudeError = Math.abs(this.target.y - position.y)
    let reward = progress * 2 - 0.03 - Math.abs(action[0]) * 0.005 - Math.abs(action[1]) * 0.005 - Math.abs(action[2]) * 0.005
    let terminated = false
    let truncated = false
    let terminationReason: string | null = null
    let truncationReason: string | null = null
    const groundY = getTerrainHeight(this.heightfield, position.x, position.z)
    if (distance <= 1.5 && altitudeError <= 1.5 && Math.hypot(v.x, v.y, v.z) <= 2) {
      this.success = true
      terminated = true
      terminationReason = 'goal'
      reward += 100
    } else if (position.y < groundY + 0.8) {
      terminated = true
      terminationReason = 'crash'
      reward -= 50
    } else if (Math.abs(position.x) > this.bounds || Math.abs(position.z) > this.bounds) {
      terminated = true
      terminationReason = 'out-of-bounds'
      reward -= 50
    } else if (this.steps >= this.maxSteps) {
      truncated = true
      truncationReason = 'time-limit'
    }
    this.previousDistance = distance
    this.rewardSum += reward
    this.done = terminated || truncated
    return {
      observation: this.observation(), reward, terminated, truncated,
      info: { distanceM: distance, position, simTimeS: this.steps * this.actionRepeat * FIXED_TIME_STEP, metrics: {
        episodeReward: this.rewardSum, length: this.steps, success: this.success,
        terminationReason, truncationReason, finalDistanceM: distance, distanceTraveledM: this.distanceTraveled,
      } },
    }
  }

  public close(): void { if (!this.closed) { this.closed = true; this.world.free(); this.body = null } }

  private observation(): Float32Array { return buildDroneObservation(this.position(), this.velocity(), this.target) }
  private position(): { x: number; y: number; z: number } {
    if (!this.body) throw new Error('Drone environment must be reset first.')
    const p = this.body.translation(); return { x: p.x, y: p.y, z: p.z }
  }
  private velocity(): { x: number; y: number; z: number } {
    if (!this.body) return { x: 0, y: 0, z: 0 }
    const v = this.body.linvel(); return { x: v.x, y: v.y, z: v.z }
  }
  private distance(p: { x: number; y: number; z: number }): number { return Math.hypot(this.target.x - p.x, this.target.y - p.y, this.target.z - p.z) }
  private randomPoint(): { x: number; z: number } { return { x: (this.random() * 2 - 1) * 18, z: (this.random() * 2 - 1) * 18 } }
  private randomTarget(start: { x: number; z: number }): { x: number; z: number } {
    for (let i = 0; i < 20; i += 1) {
      const target = this.randomPoint()
      const d = Math.hypot(target.x - start.x, target.z - start.z)
      if (d >= this.minDistance && d <= this.maxDistance) return target
    }
    return { x: Math.min(this.bounds - 5, start.x + this.minDistance), z: start.z }
  }
  private assertOpen(): void { if (this.closed) throw new Error('Drone environment is closed.') }
}
