import { FIXED_TIME_STEP, MAX_FRAME_DELTA } from '../types/SimulationTypes'

/**
 * Accumulator-based fixed-step clock. Render frames deposit wall-clock time;
 * physics consumes it in exact FIXED_TIME_STEP increments for determinism.
 */
export class SimulationClock {
  public static readonly FIXED_TIME_STEP = FIXED_TIME_STEP
  public static readonly MAX_FRAME_DELTA = MAX_FRAME_DELTA

  private accumulator = 0
  private lastTimestampMs: number | null = null
  private elapsedSeconds = 0

  public get fixedTimeStep(): number {
    return SimulationClock.FIXED_TIME_STEP
  }

  public get elapsed(): number {
    return this.elapsedSeconds
  }

  /**
   * Fraction of the next fixed step already accumulated (0..1).
   * Used to interpolate visuals between physics states.
   */
  public get alpha(): number {
    return Math.min(this.accumulator / SimulationClock.FIXED_TIME_STEP, 1)
  }

  public update(timestampMs: number): number {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs
      return 0
    }

    const deltaSeconds = Math.min(
      Math.max((timestampMs - this.lastTimestampMs) / 1000, 0),
      SimulationClock.MAX_FRAME_DELTA,
    )

    this.lastTimestampMs = timestampMs
    this.accumulator += deltaSeconds

    const steps = Math.floor(this.accumulator / SimulationClock.FIXED_TIME_STEP)
    if (steps > 0) {
      this.accumulator -= steps * SimulationClock.FIXED_TIME_STEP
      this.elapsedSeconds += steps * SimulationClock.FIXED_TIME_STEP
    }

    return steps
  }

  public reset(): void {
    this.accumulator = 0
    this.lastTimestampMs = null
    this.elapsedSeconds = 0
  }
}
