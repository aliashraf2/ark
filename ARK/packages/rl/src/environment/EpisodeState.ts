/** Why an episode terminated (a terminal condition was reached). */
export type TerminationReason = 'goal' | 'battery-depleted' | 'rollover' | null

/** Why an episode truncated (an external limit was hit). */
export type TruncationReason = 'max-steps' | 'time-limit' | 'out-of-bounds' | null

/**
 * Episode metrics, accumulated from actual simulation state (never from
 * commanded effort). Included in every step info; final on terminal steps.
 */
export interface EpisodeMetrics {
  /** Sum of step rewards this episode. */
  episodeReward: number
  /** RL steps taken this episode. */
  length: number
  /** True when the episode ended by reaching the goal. */
  success: boolean
  /** Goal distance at the latest step, meters. */
  finalDistanceM: number
  /** Path length actually traveled (position deltas), meters. */
  distanceTraveledM: number
  /** Steps with a nonzero collision penalty (proximity < 0.6 m). */
  collisions: number
  /** Total energy consumed, Joules (unweighted physics model output). */
  energyJ: number
  terminationReason: TerminationReason
  truncationReason: TruncationReason
}

export function createEpisodeMetrics(): EpisodeMetrics {
  return {
    episodeReward: 0,
    length: 0,
    success: false,
    finalDistanceM: 0,
    distanceTraveledM: 0,
    collisions: 0,
    energyJ: 0,
    terminationReason: null,
    truncationReason: null,
  }
}

/** Explicit mutable episode ledger owned by one ArkEnvironment. */
export class EpisodeTracker {
  private metrics: EpisodeMetrics = createEpisodeMetrics()
  private lastPosition: { x: number; z: number } | null = null

  public reset(startPosition: { x: number; z: number }, initialDistanceM: number): void {
    this.metrics = createEpisodeMetrics()
    this.metrics.finalDistanceM = initialDistanceM
    this.lastPosition = { ...startPosition }
  }

  public recordStep(input: {
    reward: number
    distanceM: number
    position: { x: number; z: number }
    collided: boolean
    energyJ: number
  }): void {
    this.metrics.episodeReward += input.reward
    this.metrics.length += 1
    this.metrics.finalDistanceM = input.distanceM
    if (this.lastPosition) {
      this.metrics.distanceTraveledM += Math.hypot(
        input.position.x - this.lastPosition.x,
        input.position.z - this.lastPosition.z,
      )
    }
    this.lastPosition = { x: input.position.x, z: input.position.z }
    if (input.collided) this.metrics.collisions += 1
    this.metrics.energyJ += input.energyJ
  }

  public finish(terminationReason: TerminationReason, truncationReason: TruncationReason): EpisodeMetrics {
    this.metrics.terminationReason = terminationReason
    this.metrics.truncationReason = truncationReason
    this.metrics.success = terminationReason === 'goal'
    return this.snapshot()
  }

  public snapshot(): EpisodeMetrics {
    return { ...this.metrics }
  }
}
