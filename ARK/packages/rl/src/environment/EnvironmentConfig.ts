import { DEFAULT_REWARD_WEIGHTS, type EnvRewardWeights } from '../../../physics/src/robotics/RoverEnv'
import type { RoverConfigOverrides } from '../../../physics/src/robotics/RoverConfig'
import type { PlanetId } from '../../../physics/src/worlds/PlanetConfig'

/**
 * RL environment configuration. Only planet + terrainSeed are required;
 * everything else has a documented default (see resolveEnvironmentConfig).
 * Physics timestep is fixed at 1/60 s by the shared core (not configurable).
 */
export interface ArkEnvironmentConfig {
  /** Planet whose gravity, terrain, and friction govern the episode. */
  planet: PlanetId
  /** Seed for procedural terrain generation (fixed for the env's lifetime). */
  terrainSeed: number
  /** Physics substeps per RL step (action repeat). Default 4 (15 Hz control). */
  actionRepeat?: number
  /** Truncate the episode after this many RL steps. Default 600. */
  maxSteps?: number
  /** Mission time limit, sim-seconds (also truncates). Default 120. */
  timeLimitS?: number
  /** Goal radius, meters. Default 2. */
  toleranceM?: number
  /** Episode bounds half-extent, meters; leaving truncates. Default 45. */
  boundsHalfExtentM?: number
  /** Minimum start-to-goal distance for generated scenarios. Default 15. */
  goalMinDistanceM?: number
  /** Maximum start-to-goal distance for generated scenarios. Default 40. */
  goalMaxDistanceM?: number
  /** Steepest allowed spawn slope, rise/meter. Default 0.27 (~15 deg). */
  maxStartSlope?: number
  /** Steepest allowed goal slope, rise/meter. Default 0.35 (~19 deg). */
  maxGoalSlope?: number
  /** Per-ray gaussian sensor noise sigma, meters (0 = deterministic). Default 0. */
  sensorNoiseSigmaM?: number
  /** Manual traction multiplier (surface effects). Default 1. */
  tractionMultiplier?: number
  /** Reward term weights. Default DEFAULT_REWARD_WEIGHTS. */
  rewardWeights?: EnvRewardWeights
  /** Rover construction overrides (e.g. tiny battery for depletion tests). */
  rover?: RoverConfigOverrides
  /**
   * Terrain grid resolution override (cells per side, >= 8). Default is the
   * planet profile value (160). Lower values train faster; the SAME heightfield
   * feeds physics here as rendering in the browser for identical parameters.
   */
  terrainSubdivisions?: number
}

export type ResolvedArkEnvironmentConfig = Required<Omit<ArkEnvironmentConfig, 'rewardWeights' | 'rover'>> & {
  rewardWeights: EnvRewardWeights
  rover: RoverConfigOverrides
}

export const DEFAULT_RL_CONFIG = Object.freeze({
  actionRepeat: 4,
  maxSteps: 600,
  timeLimitS: 120,
  toleranceM: 2,
  boundsHalfExtentM: 45,
  goalMinDistanceM: 15,
  goalMaxDistanceM: 40,
  maxStartSlope: 0.27,
  maxGoalSlope: 0.35,
  sensorNoiseSigmaM: 0,
  tractionMultiplier: 1,
})

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validates + fills defaults. Throws on any invalid value (fail fast). */
export function resolveEnvironmentConfig(config: ArkEnvironmentConfig): ResolvedArkEnvironmentConfig {
  if (config.planet !== 'earth' && config.planet !== 'mars') {
    throw new Error(`Config planet must be 'earth' or 'mars', got ${String(config.planet)}.`)
  }
  if (!Number.isInteger(config.terrainSeed)) {
    throw new Error(`Config terrainSeed must be an integer, got ${String(config.terrainSeed)}.`)
  }
  const d = DEFAULT_RL_CONFIG
  const resolved = {
    planet: config.planet,
    terrainSeed: config.terrainSeed,
    actionRepeat: config.actionRepeat ?? d.actionRepeat,
    maxSteps: config.maxSteps ?? d.maxSteps,
    timeLimitS: config.timeLimitS ?? d.timeLimitS,
    toleranceM: config.toleranceM ?? d.toleranceM,
    boundsHalfExtentM: config.boundsHalfExtentM ?? d.boundsHalfExtentM,
    goalMinDistanceM: config.goalMinDistanceM ?? d.goalMinDistanceM,
    goalMaxDistanceM: config.goalMaxDistanceM ?? d.goalMaxDistanceM,
    maxStartSlope: config.maxStartSlope ?? d.maxStartSlope,
    maxGoalSlope: config.maxGoalSlope ?? d.maxGoalSlope,
    sensorNoiseSigmaM: config.sensorNoiseSigmaM ?? d.sensorNoiseSigmaM,
    tractionMultiplier: config.tractionMultiplier ?? d.tractionMultiplier,
    rewardWeights: config.rewardWeights ?? DEFAULT_REWARD_WEIGHTS,
    rover: config.rover ?? {},
    terrainSubdivisions: config.terrainSubdivisions ?? 160,
  }
  const positiveInt = (name: 'actionRepeat' | 'maxSteps' | 'terrainSubdivisions'): void => {
    if (!Number.isInteger(resolved[name]) || resolved[name] <= 0) {
      throw new Error(`Config ${name} must be a positive integer, got ${String(resolved[name])}.`)
    }
  }
  positiveInt('actionRepeat')
  positiveInt('maxSteps')
  positiveInt('terrainSubdivisions')
  if (resolved.terrainSubdivisions < 8) {
    throw new Error(`Config terrainSubdivisions must be >= 8, got ${resolved.terrainSubdivisions}.`)
  }
  const positive = (
    name:
      | 'timeLimitS'
      | 'toleranceM'
      | 'boundsHalfExtentM'
      | 'goalMinDistanceM'
      | 'goalMaxDistanceM'
      | 'maxStartSlope'
      | 'maxGoalSlope',
  ): void => {
    if (!isFiniteNumber(resolved[name]) || resolved[name] <= 0) {
      throw new Error(`Config ${name} must be a positive finite number, got ${String(resolved[name])}.`)
    }
  }
  positive('timeLimitS')
  positive('toleranceM')
  positive('boundsHalfExtentM')
  positive('goalMinDistanceM')
  positive('goalMaxDistanceM')
  positive('maxStartSlope')
  positive('maxGoalSlope')
  if (!isFiniteNumber(resolved.sensorNoiseSigmaM) || resolved.sensorNoiseSigmaM < 0) {
    throw new Error(`Config sensorNoiseSigmaM must be >= 0, got ${String(resolved.sensorNoiseSigmaM)}.`)
  }
  if (!isFiniteNumber(resolved.tractionMultiplier) || resolved.tractionMultiplier < 0) {
    throw new Error(`Config tractionMultiplier must be >= 0, got ${String(resolved.tractionMultiplier)}.`)
  }
  if (resolved.goalMinDistanceM >= resolved.goalMaxDistanceM) {
    throw new Error(
      `Config goalMinDistanceM (${resolved.goalMinDistanceM}) must be < goalMaxDistanceM (${resolved.goalMaxDistanceM}).`,
    )
  }
  for (const key of ['progress', 'success', 'collision', 'energy', 'time'] as const) {
    if (!isFiniteNumber(resolved.rewardWeights[key])) {
      throw new Error(`Config rewardWeights.${key} must be finite, got ${String(resolved.rewardWeights[key])}.`)
    }
  }
  return resolved
}
