import RAPIER from '@dimforge/rapier3d-compat'

import { createTerrainBody } from '../terrain/createTerrainCollider'
import type { Heightfield } from '../terrain/generateHeightfield'
import { getTerrainHeight } from '../terrain/terrainSampling'
import { mulberry32 } from '../terrain/terrainNoise'
import type { Vector3 } from '../types/SimulationTypes'
import { FIXED_TIME_STEP } from '../types/SimulationTypes'
import { ExternalController } from './controllers'
import type { MissionBounds } from './MissionManager'
import { RobotManager } from './RobotManager'
import {
  bodyUpY,
  buildObservation,
  downhillYaw,
  findSpawnSite,
  footprintSpawnHeight,
  goalDistanceXZ,
  navigationReward,
  ROLLOVER_UP_THRESHOLD,
  type RewardTerms,
} from './RoverDynamics'
import type { DriveAction, RoverConfigOverrides, RoverObservation } from './RoverConfig'
import { NEUTRAL_ACTION } from './RoverConfig'

export interface EnvRewardWeights {
  readonly progress: number
  readonly success: number
  readonly collision: number
  readonly energy: number
  readonly time: number
}

export const DEFAULT_REWARD_WEIGHTS: EnvRewardWeights = Object.freeze({
  progress: 2,
  success: 100,
  collision: -5,
  energy: -0.01,
  time: -0.2,
})

export interface RoverEnvConfig {
  /** Gravitational acceleration magnitude, m/s^2 (planet-dependent). */
  gravityMps2: number
  heightfield: Heightfield
  terrainFriction: number
  /** Manual traction multiplier (wetness/surface effects), dimensionless. */
  tractionMultiplier?: number
  /** Physics steps per env step (action repeat). */
  actionRepeat?: number
  rewardWeights?: EnvRewardWeights
  bounds?: MissionBounds
  timeLimitS?: number
  toleranceM?: number
  rover?: RoverConfigOverrides
}

export interface EnvStepResult {
  observation: RoverObservation
  reward: number
  terms: RewardTerms
  terminated: boolean
  truncated: boolean
  info: {
    missionStatus: string
    /** Mission failure reason when status is 'failed' ('time-limit' | 'out-of-bounds' | 'aborted'). */
    missionFailReason: string | null
    distanceM: number
    batteryPercent: number
    steps: number
    /** Current rover position (ground-truth simulation state, for metrics). */
    position: Vector3
    /** Body up-axis Y: 1 upright, < ROLLOVER_UP_THRESHOLD means rolled over. */
    upY: number
    /** Raw energy consumed this step, Joules (before reward weighting). */
    energyJ: number
  }
}

/** Physics settle steps applied after every reset (braked drop onto terrain). */
export const SETTLE_STEPS = 30

/** Explicit scenario overrides for reset; omitted fields keep the sampler. */
export interface EnvResetOptions {
  start?: { x: number; z: number }
  target?: { x: number; z: number }
}

export interface EnvResetResult {
  observation: RoverObservation
  info: {
    /** Spawn actually used (post gentle-site search), terrain XZ. */
    start: { x: number; z: number }
    /** Goal actually used, terrain XZ. */
    target: { x: number; z: number }
  }
}

/**
 * Headless-capable Gym-style interface over one rover + one navigation
 * mission. Runs on its own bare Rapier world (no rendering, no sphere) so
 * future training harnesses can step it in Node or workers; the only
 * requirement is an initialized Rapier WASM runtime (PhysicsWorld.init()).
 *
 * Determinism: same seed + same build reproduces comparable trajectories
 * within one runtime. Cross-platform bit-identical physics is NOT claimed.
 */
export class RoverEnv {
  private world: RAPIER.World
  private manager: RobotManager
  private roverId: string
  private readonly config: Required<Omit<RoverEnvConfig, 'heightfield' | 'rover' | 'rewardWeights'>> & {
    heightfield: Heightfield
    rewardWeights: EnvRewardWeights
    rover: RoverConfigOverrides
  }
  private readonly external: ExternalController

  private pendingAction: DriveAction = { ...NEUTRAL_ACTION }
  private missionId: string | null = null
  private previousDistance = 0
  private stepCount = 0
  private physicsStepCount = 0
  private lastReward = 0
  private random: () => number = mulberry32(1)

  constructor(config: RoverEnvConfig) {
    this.config = {
      gravityMps2: config.gravityMps2,
      heightfield: config.heightfield,
      terrainFriction: config.terrainFriction,
      tractionMultiplier: config.tractionMultiplier ?? 1,
      actionRepeat: config.actionRepeat ?? 4,
      rewardWeights: config.rewardWeights ?? DEFAULT_REWARD_WEIGHTS,
      bounds: config.bounds ?? { halfExtent: 45 },
      timeLimitS: config.timeLimitS ?? 120,
      toleranceM: config.toleranceM ?? 2,
      rover: config.rover ?? {},
    }
    this.external = new ExternalController(() => this.pendingAction)
    // Dummy spawn: the first reset() rebuilds the world at the real spawn.
    // Definite assignment via buildWorld (constructor cannot call reset()).
    this.world = null as unknown as RAPIER.World
    this.manager = null as unknown as RobotManager
    this.roverId = ''
    this.buildWorld({ position: { x: 0, y: 50, z: 0 }, yawRad: 0 }, 1)
  }

  /**
   * (Re)builds the Rapier world: terrain collider, manager, and one rover.
   * Every reset rebuilds from scratch because engine-internal history
   * (broad-phase pair ordering, contact caches) survives teleport + velocity
   * zeroing and makes reset;step;reset diverge. Identical build sequence
   * yields identical engine state, restoring determinism.
   */
  private buildWorld(spawn: { position: { x: number; y: number; z: number }; yawRad: number }, seed: number): void {
    this.world = new RAPIER.World({ x: 0, y: -this.config.gravityMps2, z: 0 })
    this.world.timestep = FIXED_TIME_STEP
    createTerrainBody(this.world, this.config.heightfield, {
      friction: this.config.terrainFriction,
      restitution: 0.05,
    })
    this.manager = new RobotManager(this.world, null)
    this.roverId = this.manager.spawn(spawn, this.config.rover, seed)
    this.manager.setController(this.roverId, this.external)
  }

  private destroyWorld(): void {
    this.manager.dispose()
    this.world.free()
  }

  private get rover(): NonNullable<ReturnType<RobotManager['get']>> {
    const rover = this.manager.get(this.roverId)
    if (!rover) throw new Error('RoverEnv rover missing.')
    return rover
  }

  private get traction(): number {
    return this.config.terrainFriction * this.config.tractionMultiplier
  }

  /**
   * Resets rover, mission, and RNG streams. Returns the initial observation
   * plus the scenario actually used. Explicit start/target overrides skip the
   * sampler (the start still goes through the gentle-site search).
   */
  public reset(seed: number, options: EnvResetOptions = {}): EnvResetResult {
    this.random = mulberry32(seed)
    const margin = this.config.bounds.halfExtent - 5
    const startXZ = options.start ?? this.sampleXZ(margin)
    let targetXZ = options.target ?? this.sampleXZ(margin)
    if (!options.target) {
      for (
        let attempt = 0;
        attempt < 16 && Math.hypot(targetXZ.x - startXZ.x, targetXZ.z - startXZ.z) < 15;
        attempt += 1
      ) {
        targetXZ = this.sampleXZ(margin)
      }
    }
    const heightfield = this.config.heightfield
    const sample = (sx: number, sz: number) => getTerrainHeight(heightfield, sx, sz)
    const target = { x: targetXZ.x, y: sample(targetXZ.x, targetXZ.z) + 0.1, z: targetXZ.z }
    const site = findSpawnSite(sample, startXZ.x, startXZ.z)
    const yaw = downhillYaw(
      (sample(site.x + 1.5, site.z) - sample(site.x - 1.5, site.z)) / 3,
      (sample(site.x, site.z + 1.5) - sample(site.x, site.z - 1.5)) / 3,
      this.random() * 2 * Math.PI,
    )
    // Fresh world every episode (see buildWorld): teleports leak history.
    const spawnPosition = {
      x: site.x,
      y: footprintSpawnHeight(sample, site.x, site.z, yaw, this.rover.config.wheelOffsets),
      z: site.z,
    }
    this.destroyWorld()
    this.buildWorld({ position: spawnPosition, yawRad: yaw }, seed)
    this.pendingAction = { ...NEUTRAL_ACTION }
    // Settle onto the terrain before the mission starts.
    for (let i = 0; i < SETTLE_STEPS; i += 1) {
      this.rover.applyAction({ ...NEUTRAL_ACTION, brake: true }, this.stepEnv(FIXED_TIME_STEP))
      this.world.step()
    }
    // The manager is fresh, so no previous mission can leak; create directly.
    const mission = this.manager.missions.create(
      this.roverId,
      this.rover.position,
      target,
      this.config.toleranceM,
      this.config.timeLimitS,
    )
    this.missionId = mission.id
    this.manager.missions.start(mission.id)
    this.previousDistance = goalDistanceXZ(this.rover.position, target)
    this.stepCount = 0
    this.physicsStepCount = SETTLE_STEPS
    this.lastReward = 0
    this.rover.senseRanges()
    return {
      observation: this.getObservation(),
      info: { start: { x: site.x, z: site.z }, target: { x: targetXZ.x, z: targetXZ.z } },
    }
  }

  /** Advances the environment by actionRepeat physics steps under one action. */
  public step(action: DriveAction): EnvStepResult {
    this.pendingAction = { ...action }
    const dt = FIXED_TIME_STEP * this.config.actionRepeat
    for (let i = 0; i < this.config.actionRepeat; i += 1) {
      this.manager.preStep({
        dt: FIXED_TIME_STEP,
        gravityMps2: this.config.gravityMps2,
        traction: this.traction,
      })
      this.world.step()
    }
    this.physicsStepCount += this.config.actionRepeat
    this.manager.postStep(dt, this.config.bounds)
    const settled = this.missionId ? this.manager.missions.get(this.missionId) : null
    const target = settled?.target ?? { x: 0, y: 0, z: 0 }
    const distance = goalDistanceXZ(this.rover.position, target)
    const ranges = this.rover.ranges
    const minRange = ranges.length > 0 ? Math.min(...ranges.map((r) => r.distance)) : 99
    const success = settled?.status === 'succeeded'
    const energyJ = this.rover.lastPowerDrawW * dt
    const terms = navigationReward(
      this.previousDistance,
      distance,
      minRange,
      energyJ,
      dt,
      success,
      this.config.rewardWeights,
    )
    this.previousDistance = distance
    this.stepCount += 1
    this.lastReward = terms.total
    const upY = bodyUpY(this.rover.rotation)
    const terminated = success || this.rover.depleted || upY < ROLLOVER_UP_THRESHOLD
    const truncated =
      !terminated && (settled?.status === 'failed' || settled == null)
    return {
      observation: this.getObservation(),
      reward: terms.total,
      terms,
      terminated,
      truncated,
      info: {
        missionStatus: settled?.status ?? 'none',
        missionFailReason: settled?.failReason ?? null,
        distanceM: distance,
        batteryPercent: this.rover.battery().percent,
        steps: this.stepCount,
        position: { ...this.rover.position },
        upY,
        energyJ,
      },
    }
  }

  public getObservation(): RoverObservation {
    const mission = this.missionId ? this.manager.missions.get(this.missionId) : null
    const inertial = this.rover.inertial
    return buildObservation(this.rover.config, {
      position: this.rover.position,
      yawRad: inertial.yawRad,
      speed: inertial.speed,
      yawRate: inertial.angularVelocity.y,
      ranges: this.rover.ranges,
      batteryPercent: this.rover.battery().percent,
      traction: this.traction,
      target: mission ? mission.target : null,
    })
  }

  public getReward(): number {
    return this.lastReward
  }

  /** Total Rapier steps advanced this episode, including the reset settle. */
  public get physicsSteps(): number {
    return this.physicsStepCount
  }

  public isTerminated(): boolean {
    const mission = this.missionId ? this.manager.missions.get(this.missionId) : null
    return (
      mission?.status === 'succeeded' ||
      this.rover.depleted ||
      bodyUpY(this.rover.rotation) < ROLLOVER_UP_THRESHOLD
    )
  }

  public isTruncated(): boolean {
    if (this.isTerminated()) return false
    const mission = this.missionId ? this.manager.missions.get(this.missionId) : null
    return mission?.status === 'failed'
  }

  public dispose(): void {
    this.destroyWorld()
  }

  private stepEnv(dt: number): { gravityMps2: number; traction: number; dt: number } {
    return { gravityMps2: this.config.gravityMps2, traction: this.traction, dt }
  }

  private sampleXZ(margin: number): { x: number; z: number } {
    const x = (this.random() * 2 - 1) * margin
    const z = (this.random() * 2 - 1) * margin
    return { x, z }
  }
}
