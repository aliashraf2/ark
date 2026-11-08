import { randomInt } from 'node:crypto'

import { PhysicsWorld } from '../../../physics/src/physics/PhysicsWorld'
import { ROLLOVER_UP_THRESHOLD, slopeMagnitude, type RewardTerms } from '../../../physics/src/robotics/RoverDynamics'
import { RoverEnv } from '../../../physics/src/robotics/RoverEnv'
import { generateHeightfield, type Heightfield } from '../../../physics/src/terrain/generateHeightfield'
import { mulberry32 } from '../../../physics/src/terrain/terrainNoise'
import { getTerrainHeight } from '../../../physics/src/terrain/terrainSampling'
import { FIXED_TIME_STEP } from '../../../physics/src/types/SimulationTypes'
import { getPlanet, resolveTerrainParams } from '../../../physics/src/worlds/planetPresets'
import { toDriveAction, validateRoverAction, type RoverRLAction } from '../actions/validateRoverAction'
import { toFloat32Array } from '../observations/observationSpec'
import {
  EVAL_SEED_BASE,
  generateScenario,
  makeScenarioId,
  type ScenarioMetadata,
  type ScenarioSplit,
} from '../scenarios/generateScenario'
import { EpisodeTracker, type EpisodeMetrics, type TerminationReason, type TruncationReason } from './EpisodeState'
import { resolveEnvironmentConfig, type ArkEnvironmentConfig, type ResolvedArkEnvironmentConfig } from './EnvironmentConfig'

export type {
  ArkEnvironmentConfig,
  EpisodeMetrics,
  ResolvedArkEnvironmentConfig,
  RewardTerms,
  RoverRLAction,
  ScenarioMetadata,
  ScenarioSplit,
  TerminationReason,
  TruncationReason,
}

/** Per-reset overrides. Explicit start/target skip the scenario sampler. */
export interface ResetOptions {
  start?: { x: number; z: number }
  target?: { x: number; z: number }
  split?: ScenarioSplit
}

export interface ResetInfo {
  scenario: ScenarioMetadata
  /** Zero-based episode counter for this environment instance. */
  episodeIndex: number
}

export interface StepInfo {
  metrics: EpisodeMetrics
  /** Raw reward terms before summation (debugging / reward shaping). */
  rewardTerms: RewardTerms
  /** True when a finite out-of-range action was clipped this step. */
  actionClipped: boolean
  distanceM: number
  batteryPercent: number
  upY: number
  missionStatus: string
  /** Total Rapier steps this episode, including the reset settle. */
  physicsSteps: number
  /** Simulated seconds elapsed this episode (physicsSteps × dt). */
  simTimeS: number
  scenarioId: string
}

export interface StepResult {
  observation: Float32Array
  reward: number
  terminated: boolean
  truncated: boolean
  info: StepInfo
}

/**
 * Gymnasium-style RL environment over ARK's shared Rapier core. One
 * ArkEnvironment owns one physics world, one rover, one terrain: create
 * several for independent parallel rollouts (sequential here; workers later).
 *
 * Contract: create() is async (Rapier WASM init, once per process); reset()
 * and step() are synchronous afterwards. step() before the first reset, after
 * close(), or after an episode ended without reset throws — completed episodes
 * never silently continue.
 */
export class ArkEnvironment {
  public readonly config: ResolvedArkEnvironmentConfig

  private readonly heightfield: Heightfield
  private readonly env: RoverEnv
  private readonly tracker = new EpisodeTracker()

  private scenario: ScenarioMetadata | null = null
  private episodeIndex = -1
  private hasReset = false
  private done = false
  private closed = false
  private previousShieldedAction = { left: 0, right: 0 }

  private constructor(config: ResolvedArkEnvironmentConfig, heightfield: Heightfield, env: RoverEnv) {
    this.config = config
    this.heightfield = heightfield
    this.env = env
  }

  public static async create(config: ArkEnvironmentConfig): Promise<ArkEnvironment> {
    const resolved = resolveEnvironmentConfig(config)
    await PhysicsWorld.init()
    const planet = getPlanet(resolved.planet)
    const heightfield = generateHeightfield(
      { ...resolveTerrainParams(planet), subdivisions: resolved.terrainSubdivisions },
      resolved.terrainSeed,
    )
    const env = new RoverEnv({
      gravityMps2: planet.gravity,
      heightfield,
      terrainFriction: planet.terrainFriction,
      tractionMultiplier: resolved.tractionMultiplier,
      actionRepeat: resolved.actionRepeat,
      rewardWeights: resolved.rewardWeights,
      bounds: { halfExtent: resolved.boundsHalfExtentM },
      timeLimitS: resolved.timeLimitS,
      toleranceM: resolved.toleranceM,
      rover: { ...resolved.rover, sensorNoiseSigma: resolved.sensorNoiseSigmaM },
    })
    return new ArkEnvironment(resolved, heightfield, env)
  }

  /** Starts a new episode. Omitted seed uses OS entropy (non-reproducible). */
  public reset(episodeSeed?: number, options: ResetOptions = {}): { observation: Float32Array; info: ResetInfo } {
    this.assertUsable()
    const seed = episodeSeed ?? randomInt(2 ** 31)
    if (!Number.isInteger(seed)) {
      throw new Error(`reset seed must be an integer, got ${String(episodeSeed)}.`)
    }
    const split = options.split ?? (seed >= EVAL_SEED_BASE ? 'eval' : 'train')
    const sampleHeight = (x: number, z: number): number => getTerrainHeight(this.heightfield, x, z)

    let startXZ: { x: number; z: number }
    let targetXZ: { x: number; z: number }
    let constraintsMet = true
    if (options.start && options.target) {
      startXZ = this.checkedPoint('start', options.start)
      targetXZ = this.checkedPoint('target', options.target)
    } else if (options.start || options.target) {
      throw new Error('reset options must provide both start and target, or neither.')
    } else {
      const scenario = generateScenario({
        sampleHeight,
        random: mulberry32(seed),
        boundsHalfExtentM: this.config.boundsHalfExtentM,
        goalMinDistanceM: this.config.goalMinDistanceM,
        goalMaxDistanceM: this.config.goalMaxDistanceM,
        maxStartSlope: this.config.maxStartSlope,
        maxGoalSlope: this.config.maxGoalSlope,
      })
      startXZ = scenario.start
      targetXZ = scenario.target
      constraintsMet = scenario.constraintsMet
    }

    const result = this.env.reset(seed, { start: startXZ, target: targetXZ })
    const startSlope = slopeMagnitude(sampleHeight, result.info.start.x, result.info.start.z)
    const targetSlope = slopeMagnitude(sampleHeight, result.info.target.x, result.info.target.z)
    this.scenario = {
      scenarioId: makeScenarioId(this.config.planet, this.config.terrainSeed, seed, split),
      planet: this.config.planet,
      terrainSeed: this.config.terrainSeed,
      episodeSeed: seed,
      split,
      start: result.info.start,
      startSlope,
      target: result.info.target,
      targetSlope,
      distanceM: Math.hypot(
        result.info.target.x - result.info.start.x,
        result.info.target.z - result.info.start.z,
      ),
      constraintsMet,
    }
    this.episodeIndex += 1
    this.tracker.reset(result.info.start, this.scenario.distanceM)
    this.previousShieldedAction = { left: 0, right: 0 }
    this.hasReset = true
    this.done = false
    return {
      observation: toFloat32Array(result.observation),
      info: { scenario: { ...this.scenario }, episodeIndex: this.episodeIndex },
    }
  }

  public step(action: RoverRLAction): StepResult {
    this.assertUsable()
    if (!this.hasReset || !this.scenario) {
      throw new Error('step() before reset(): call reset() to start an episode first.')
    }
    if (this.done) {
      throw new Error('step() after episode end: call reset() to start a new episode.')
    }
    const validated = validateRoverAction(action)
    const policyObservation = this.env.getObservation()
    const shielded = this.shieldRoverAction(validated, policyObservation)
    const result = this.env.step(toDriveAction(shielded))
    const rolloverPenalty = result.info.upY < ROLLOVER_UP_THRESHOLD ? -100 : 0
    const reward = result.reward + rolloverPenalty
    this.tracker.recordStep({
      reward,
      distanceM: result.info.distanceM,
      position: result.info.position,
      collided: result.terms.collisionPenalty !== 0,
      energyJ: result.info.energyJ,
    })

    const terminated = result.terminated
    const maxStepsHit = this.tracker.snapshot().length >= this.config.maxSteps
    const truncated = !terminated && (result.truncated || maxStepsHit)
    let terminationReason: TerminationReason = null
    let truncationReason: TruncationReason = null
    if (terminated) {
      if (result.info.missionStatus === 'succeeded') terminationReason = 'goal'
      else if (result.info.batteryPercent <= 0) terminationReason = 'battery-depleted'
      else if (result.info.upY < ROLLOVER_UP_THRESHOLD) terminationReason = 'rollover'
    } else if (truncated) {
      // Prefer the mission's own reason (time vs bounds) over the step cap.
      if (result.info.missionFailReason === 'time-limit') truncationReason = 'time-limit'
      else if (result.info.missionFailReason === 'out-of-bounds') truncationReason = 'out-of-bounds'
      else truncationReason = 'max-steps'
    }
    if (terminated || truncated) {
      this.done = true
      this.tracker.finish(terminationReason, truncationReason)
    }
    return {
      observation: toFloat32Array(result.observation),
      reward,
      terminated,
      truncated,
      info: {
        metrics: this.tracker.snapshot(),
        rewardTerms: { ...result.terms, ...(rolloverPenalty ? { rolloverPenalty } : {}) },
        actionClipped: validated.clipped,
        distanceM: result.info.distanceM,
        batteryPercent: result.info.batteryPercent,
        upY: result.info.upY,
        missionStatus: result.info.missionStatus,
        physicsSteps: this.env.physicsSteps,
        simTimeS: this.env.physicsSteps * FIXED_TIME_STEP,
        scenarioId: this.scenario.scenarioId,
      },
    }
  }

  /** Releases the physics world. Safe to call twice; ends all further use. */
  public close(): void {
    if (this.closed) return
    this.closed = true
    this.env.dispose()
  }

  private assertUsable(): void {
    if (this.closed) throw new Error('Environment is closed.')
  }

  private checkedPoint(name: 'start' | 'target', point: { x: number; z: number }): { x: number; z: number } {
    if (
      typeof point?.x !== 'number' ||
      !Number.isFinite(point.x) ||
      typeof point?.z !== 'number' ||
      !Number.isFinite(point.z)
    ) {
      throw new Error(`reset ${name} must be { x, z } with finite numbers.`)
    }
    const halfW = this.heightfield.width / 2
    const halfD = this.heightfield.depth / 2
    if (Math.abs(point.x) > halfW || Math.abs(point.z) > halfD) {
      throw new Error(
        `reset ${name} (${point.x}, ${point.z}) lies outside the terrain patch (±${halfW}, ±${halfD}).`,
      )
    }
    return { x: point.x, z: point.z }
  }

  /**
   * Apply the same bounded, yaw-damped PPO actuator envelope used by the
   * browser controller. Training against this shield prevents exploratory
   * torque spikes from teaching a policy that immediately rolls the chassis.
   */
  private shieldRoverAction(
    action: { left: number; right: number; clipped: boolean },
    observation: ArrayLike<number>,
  ): { left: number; right: number; clipped: boolean; brake: false; eStop: false } {
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
    const yawRate = (observation[4] ?? 0) * 3
    const learnedForward = (action.left + action.right) / 2
    const learnedTurn = (action.right - action.left) / 2
    const turn = clamp(learnedTurn * 0.6 - yawRate * 1.2, -0.35, 0.35)
    const spinGate = clamp(1 - Math.abs(yawRate) / 2, 0, 1)
    const forward = clamp(learnedForward * 0.55, -0.45, 0.45) * spinGate
    const desiredLeft = clamp(forward - turn, -1, 1)
    const desiredRight = clamp(forward + turn, -1, 1)
    const dt = FIXED_TIME_STEP * this.config.actionRepeat
    const blend = clamp(dt / (0.12 + dt), 0.05, 1)
    this.previousShieldedAction.left += (desiredLeft - this.previousShieldedAction.left) * blend
    this.previousShieldedAction.right += (desiredRight - this.previousShieldedAction.right) * blend
    return { ...this.previousShieldedAction, clipped: action.clipped, brake: false, eStop: false }
  }
}

/** Factory form of ArkEnvironment.create (see §14 multi-env example). */
export function createArkEnvironment(config: ArkEnvironmentConfig): Promise<ArkEnvironment> {
  return ArkEnvironment.create(config)
}
