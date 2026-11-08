import type { Vector3 } from '../types/SimulationTypes'
import type { DriveAction, RangeReading, RoverConfig } from './RoverConfig'
import { headingControlAction, validateAction } from './RoverDynamics'

/**
 * Controller input: world-frame quantities (not the normalized RL vector).
 * Every controller — manual, autonomous, or external — consumes this and
 * returns a DriveAction through the same validated actuator interface.
 */
export interface ControlInput {
  position: Vector3
  yawRad: number
  /** Yaw rate, rad/s (ideal ground-truth inertial). */
  yawRateRadS: number
  speed: number
  ranges: ReadonlyArray<RangeReading>
  target: Vector3 | null
  arrived: boolean
  batteryPercent?: number
  traction?: number
  roverConfig?: RoverConfig
}

export interface Controller {
  readonly kind: 'manual' | 'navigation' | 'external'
  update(input: ControlInput, dt: number): DriveAction
  reset(): void
}

export interface ManualKeyState {
  forward: boolean
  reverse: boolean
  turnLeft: boolean
  turnRight: boolean
  brake: boolean
}

export const NEUTRAL_KEYS: Readonly<ManualKeyState> = Object.freeze({
  forward: false,
  reverse: false,
  turnLeft: false,
  turnRight: false,
  brake: false,
})

/** Keyboard/manual controller: identical action interface, human-driven. */
export class ManualController implements Controller {
  public readonly kind = 'manual' as const
  private keys: ManualKeyState = { ...NEUTRAL_KEYS }

  public setKeys(keys: ManualKeyState): void {
    this.keys = { ...keys }
  }

  public update(_input: ControlInput, _dt: number): DriveAction {
    const throttle = (this.keys.forward ? 1 : 0) - (this.keys.reverse ? 1 : 0)
    const turn = (this.keys.turnLeft ? 1 : 0) - (this.keys.turnRight ? 1 : 0)
    // Parking hold: no input means brake, so the rover never rolls away alone.
    const hold = throttle === 0 && turn === 0
    return {
      left: Math.max(-1, Math.min(1, throttle - turn * 0.7)),
      right: Math.max(-1, Math.min(1, throttle + turn * 0.7)),
      brake: this.keys.brake || hold,
      eStop: false,
    }
  }

  public reset(): void {
    this.keys = { ...NEUTRAL_KEYS }
  }
}

export interface NavigationGains {
  readonly heading: number
  /** Derivative gain on yaw rate: stops endless spin-in-place overshoot. */
  readonly yawDamping: number
  readonly maxTurn: number
  readonly cruise: number
}

export const DEFAULT_NAVIGATION_GAINS: NavigationGains = Object.freeze({
  heading: 0.8,
  yawDamping: 1.2,
  maxTurn: 0.6,
  cruise: 0.4,
})

/**
 * Baseline waypoint controller: proportional heading + clearance-scaled
 * throttle. Documented failure modes: local minima (U-shaped traps), no
 * global planning, oscillation in narrow gaps, no reverse recovery.
 */
export class NavigationController implements Controller {
  public readonly kind = 'navigation' as const
  private readonly gains: NavigationGains

  constructor(gains: NavigationGains = DEFAULT_NAVIGATION_GAINS) {
    this.gains = { ...gains }
  }

  public update(input: ControlInput, _dt: number): DriveAction {
    if (!input.target || input.arrived) {
      return { left: 0, right: 0, brake: true, eStop: false }
    }
    const dx = input.target.x - input.position.x
    const dz = input.target.z - input.position.z
    const bearing = Math.atan2(dx, dz)
    const forwardRays = input.ranges.filter((reading) => Math.abs(reading.angleRad) <= 0.35)
    const minForward =
      forwardRays.length > 0 ? Math.min(...forwardRays.map((reading) => reading.distance)) : 0
    return headingControlAction(input.yawRad, input.yawRateRadS, bearing, minForward, false, {
      heading: this.gains.heading,
      yawDamping: this.gains.yawDamping,
      maxTurn: this.gains.maxTurn,
      cruise: this.gains.cruise,
    })
  }

  public reset(): void {
    // Stateless law — nothing to reset.
  }
}

/**
 * External-policy adapter (future RL policies, remote APIs). The wrapped
 * function receives the same input every controller gets; invalid output is
 * rejected safely to brake + neutral and recorded on lastError.
 */
export class ExternalController implements Controller {
  public readonly kind = 'external' as const
  public lastError: string | null = null
  private readonly policy: (input: ControlInput, dt: number) => DriveAction

  constructor(policy: (input: ControlInput, dt: number) => DriveAction) {
    this.policy = policy
  }

  public update(input: ControlInput, dt: number): DriveAction {
    try {
      const action = this.policy(input, dt)
      const validated = validateAction(action)
      this.lastError = null
      return {
        left: validated.left,
        right: validated.right,
        brake: validated.brake,
        eStop: validated.eStop,
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'External policy failed.'
      return { left: 0, right: 0, brake: true, eStop: false }
    }
  }

  public reset(): void {
    this.lastError = null
  }
}
