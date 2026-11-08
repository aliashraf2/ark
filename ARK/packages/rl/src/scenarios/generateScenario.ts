import { findSpawnSite, slopeMagnitude } from '../../../physics/src/robotics/RoverDynamics'

/** Train/eval split tag recorded in scenario metadata. */
export type ScenarioSplit = 'train' | 'eval'

/**
 * Episode-seed space split: train episodes use seeds below EVAL_SEED_BASE,
 * eval episodes use evalEpisodeSeed(n). Both are deterministic; the ranges
 * never overlap so eval scenarios can't leak into training.
 */
export const EVAL_SEED_BASE = 1000000000

export function evalEpisodeSeed(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Eval index must be a non-negative integer, got ${String(index)}.`)
  }
  return EVAL_SEED_BASE + index
}

export interface ScenarioRequest {
  /** Terrain height sampler, meters. */
  sampleHeight: (x: number, z: number) => number
  /** Uniform [0, 1) stream (seeded by the caller for determinism). */
  random: () => number
  boundsHalfExtentM: number
  goalMinDistanceM: number
  goalMaxDistanceM: number
  maxStartSlope: number
  maxGoalSlope: number
}

export interface NavigationScenario {
  start: { x: number; z: number }
  startSlope: number
  target: { x: number; z: number }
  targetSlope: number
  distanceM: number
  /** True when the goal met every constraint (distance range + slope). */
  constraintsMet: boolean
}

const GOAL_TRIES = 128

/**
 * Deterministic navigation scenario: a gentle spawn site plus a goal on
 * gentle ground within the requested distance band. Pure given the sampler
 * and RNG stream. Limitation: gentle ground is checked, but true reachability
 * (no path planner) is NOT verified — a ridge between start and goal can make
 * a scenario hard or impossible. constraintsMet reports whether the goal met
 * every constraint; callers can filter or regenerate on false.
 */
export function generateScenario(request: ScenarioRequest): NavigationScenario {
  const margin = request.boundsHalfExtentM - 5
  const randomPoint = (): { x: number; z: number } => ({
    x: (request.random() * 2 - 1) * margin,
    z: (request.random() * 2 - 1) * margin,
  })
  const slopeAt = (point: { x: number; z: number }): number =>
    slopeMagnitude(request.sampleHeight, point.x, point.z)

  const startSeed = randomPoint()
  const startSite = findSpawnSite(request.sampleHeight, startSeed.x, startSeed.z, request.maxStartSlope)
  const start = { x: startSite.x, z: startSite.z }
  const distanceTo = (point: { x: number; z: number }): number =>
    Math.hypot(point.x - start.x, point.z - start.z)

  let fallback: { x: number; z: number } | null = null
  for (let attempt = 0; attempt < GOAL_TRIES; attempt += 1) {
    const candidate = randomPoint()
    const slope = slopeAt(candidate)
    if (slope > request.maxGoalSlope) continue
    if (!fallback) fallback = candidate
    const distance = distanceTo(candidate)
    if (distance >= request.goalMinDistanceM && distance <= request.goalMaxDistanceM) {
      return {
        start,
        startSlope: startSite.slope,
        target: candidate,
        targetSlope: slope,
        distanceM: distance,
        constraintsMet: true,
      }
    }
  }
  // Pathological terrain (no gentle goal in range after 128 tries): fall back
  // to the first gentle point found, or a gentle-site search near a random
  // point (which returns the gentlest site within radius when nothing meets
  // the cap). constraintsMet: false tells the caller the band was missed.
  let target = fallback
  if (!target) {
    const seed = randomPoint()
    const site = findSpawnSite(request.sampleHeight, seed.x, seed.z, request.maxGoalSlope)
    target = { x: site.x, z: site.z }
  }
  const targetSlope = slopeAt(target)
  return {
    start,
    startSlope: startSite.slope,
    target,
    targetSlope,
    distanceM: distanceTo(target),
    constraintsMet: false,
  }
}

export interface ScenarioMetadata extends NavigationScenario {
  scenarioId: string
  planet: string
  terrainSeed: number
  episodeSeed: number
  split: ScenarioSplit
}

export function makeScenarioId(planet: string, terrainSeed: number, episodeSeed: number, split: ScenarioSplit): string {
  return `${planet}:t${terrainSeed}:e${episodeSeed}:${split}`
}
