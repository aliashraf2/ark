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
  buildObservation,
  downhillYaw,
  findSpawnSite,
  footprintSpawnHeight,
  goalDistanceXZ,
  navigationReward,
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
    distanceM: number
    batteryPercent: number
    steps: number
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
  private readonly world: RAPIER.World
  private readonly manager: RobotManager
  private readonly roverId: string
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
    this.world = new RAPIER.World({ x: 0, y: -this.config.gravityMps2, z: 0 })
    this.world.timestep = FIXED_TIME_STEP
    createTerrainBody(this.world, this.config.heightfield, {
      friction: this.config.terrainFriction,
      restitution: 0.05,
    })
    this.manager = new RobotManager(this.world, null)
    this.external = new ExternalController(() => this.pendingAction)
    this.roverId = this.manager.spawn(
      { position: { x: 0, y: 50, z: 0 }, yawRad: 0 },
      this.config.rover,
      1,
    )
    this.manager.setController(this.roverId, this.external)
  }

  private get rover(): NonNullable<ReturnType<RobotManager['get']>> {
    const rover = this.manager.get(this.roverId)
    if (!rover) throw new Error('RoverEnv rover missing.')
    return rover
  }

  private get traction(): number {
    return this.config.terrainFriction * this.config.tractionMultiplier
  }

  /** Resets rover, mission, and RNG streams. Returns the initial observation. */
  public reset(seed: number): { observation: RoverObservation } {
    this.random = mulberry32(seed)
    const margin = this.config.bounds.halfExtent - 5
    const start = this.samplePoint(margin)
    let target = this.samplePoint(margin)
    for (let attempt = 0; attempt < 16 && goalDistanceXZ(start, target) < 15; attempt += 1) {
      target = this.samplePoint(margin)
    }
    const heightfield = this.config.heightfield
    const sample = (sx: number, sz: number) => getTerrainHeight(heightfield, sx, sz)
    const site = findSpawnSite(sample, start.x, start.z)
    const yaw = downhillYaw(
      (sample(site.x + 1.5, site.z) - sample(site.x - 1.5, site.z)) / 3,
      (sample(site.x, site.z + 1.5) - sample(site.x, site.z - 1.5)) / 3,
      this.random() * 2 * Math.PI,
    )
    this.rover.reset(
      {
        position: {
          x: site.x,
          y: footprintSpawnHeight(sample, site.x, site.z, yaw, this.rover.config.wheelOffsets),
          z: site.z,
        },
        yawRad: yaw,
      },
      seed,
    )
    // Settle onto the terrain before the mission starts.
    for (let i = 0; i < 30; i += 1) {
      this.rover.applyAction({ ...NEUTRAL_ACTION, brake: true }, this.stepEnv(FIXED_TIME_STEP))
      this.world.step()
    }
    if (this.missionId) this.manager.missions.resetMission(this.missionId)
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
    this.lastReward = 0
    this.rover.senseRanges()
    return { observation: this.getObservation() }
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
    this.manager.postStep(dt, this.config.bounds)
    const settled = this.missionId ? this.manager.missions.get(this.missionId) : null
    const target = settled?.target ?? { x: 0, y: 0, z: 0 }
    const distance = goalDistanceXZ(this.rover.position, target)
    const ranges = this.rover.ranges
    const minRange = ranges.length > 0 ? Math.min(...ranges.map((r) => r.distance)) : 99
    const success = settled?.status === 'succeeded'
    const terms = navigationReward(
      this.previousDistance,
      distance,
      minRange,
      this.rover.lastPowerDrawW * dt,
      dt,
      success,
      this.config.rewardWeights,
    )
    this.previousDistance = distance
    this.stepCount += 1
    this.lastReward = terms.total
    const terminated = success || this.rover.depleted
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
        distanceM: distance,
        batteryPercent: this.rover.battery().percent,
        steps: this.stepCount,
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

  public isTerminated(): boolean {
    const mission = this.missionId ? this.manager.missions.get(this.missionId) : null
    return mission?.status === 'succeeded' || this.rover.depleted
  }

  public isTruncated(): boolean {
    if (this.isTerminated()) return false
    const mission = this.missionId ? this.manager.missions.get(this.missionId) : null
    return mission?.status === 'failed'
  }

  public dispose(): void {
    this.manager.dispose()
    this.world.free()
  }

  private stepEnv(dt: number): { gravityMps2: number; traction: number; dt: number } {
    return { gravityMps2: this.config.gravityMps2, traction: this.traction, dt }
  }

  private samplePoint(margin: number): Vector3 {
    const x = (this.random() * 2 - 1) * margin
    const z = (this.random() * 2 - 1) * margin
    return { x, y: getTerrainHeight(this.config.heightfield, x, z) + 0.1, z }
  }
}
