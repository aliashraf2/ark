import type { DriveAction } from '../../../physics/src/robotics/RoverConfig'

/**
 * RL action: continuous differential drive, no brake channel. Zero throttle
 * coasts against rolling resistance; brake/eStop stay false (documented
 * limitation — a brake channel can extend this contract later).
 */
export interface RoverRLAction {
  leftDrive: number
  rightDrive: number
}

export const ACTION_SIZE = 2

export interface ValidatedRoverAction {
  left: number
  right: number
  /** True when a finite out-of-range effort was clipped to [-1, 1]. */
  clipped: boolean
}

/**
 * Strict RL action gate. Malformed actions (missing/non-number/NaN/Infinite
 * fields) THROW — training code bugs must fail loudly, never silently
 * drive. Finite out-of-range efforts are CLIPPED to [-1, 1] (Gymnasium Box
 * convention) and reported via `clipped`. The physics layer validates again
 * at the actuator (fail-safe brake), so clipping here is purely the documented
 * RL-side policy.
 */
export function validateRoverAction(action: unknown): ValidatedRoverAction {
  if (typeof action !== 'object' || action === null) {
    throw new Error('RL action must be an object { leftDrive, rightDrive }.')
  }
  const { leftDrive, rightDrive } = action as Record<string, unknown>
  if (typeof leftDrive !== 'number' || !Number.isFinite(leftDrive)) {
    throw new Error(`RL action leftDrive must be a finite number, got ${String(leftDrive)}.`)
  }
  if (typeof rightDrive !== 'number' || !Number.isFinite(rightDrive)) {
    throw new Error(`RL action rightDrive must be a finite number, got ${String(rightDrive)}.`)
  }
  const left = Math.max(-1, Math.min(1, leftDrive))
  const right = Math.max(-1, Math.min(1, rightDrive))
  return { left, right, clipped: left !== leftDrive || right !== rightDrive }
}

/** Maps a validated RL action onto the shared actuator interface. */
export function toDriveAction(validated: ValidatedRoverAction): DriveAction {
  return { left: validated.left, right: validated.right, brake: false, eStop: false }
}

export function actionBounds(): { low: Float32Array; high: Float32Array } {
  return { low: new Float32Array([-1, -1]), high: new Float32Array([1, 1]) }
}
