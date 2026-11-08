import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'

export type RobotFailure = 'drive-motor-failure' | 'immobilized' | 'critical-battery' | 'rollover'

export interface FailureObservation {
  dt: number
  position: Vector3
  distanceToGoal: number | null
  commandedEffort: number
  motorEnabled: boolean
  batteryPercent: number
  upY: number
}

interface ProgressWindow {
  elapsedS: number
  start: Vector3
  startDistance: number | null
}

/** Detects explicit faults first, then sustained motor effort without physical progress. */
export class FailureDetector {
  private readonly windows = new Map<string, ProgressWindow>()

  public observe(roverId: string, observation: FailureObservation): RobotFailure | null {
    if (observation.upY < 0.25) return 'rollover'
    if (observation.batteryPercent <= 0.1) return 'critical-battery'
    if (!observation.motorEnabled) return 'drive-motor-failure'

    const movingCommand = observation.commandedEffort >= 0.4
    if (!movingCommand) {
      this.windows.delete(roverId)
      return null
    }
    const prior = this.windows.get(roverId)
    if (!prior) {
      this.windows.set(roverId, {
        elapsedS: 0,
        start: { ...observation.position },
        startDistance: observation.distanceToGoal,
      })
      return null
    }
    prior.elapsedS += Math.max(0, observation.dt)
    const displacement = Math.hypot(
      observation.position.x - prior.start.x,
      observation.position.z - prior.start.z,
    )
    const goalProgress =
      prior.startDistance === null || observation.distanceToGoal === null
        ? 0
        : prior.startDistance - observation.distanceToGoal
    if (prior.elapsedS >= 3 && displacement < 0.35 && goalProgress < 0.25) {
      this.windows.delete(roverId)
      return 'immobilized'
    }
    if (displacement >= 0.35 || goalProgress >= 0.25) {
      this.windows.set(roverId, {
        elapsedS: 0,
        start: { ...observation.position },
        startDistance: observation.distanceToGoal,
      })
    }
    return null
  }

  public reset(roverId?: string): void {
    if (roverId) this.windows.delete(roverId)
    else this.windows.clear()
  }
}

