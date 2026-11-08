import type { Vector3 } from '../types/SimulationTypes'
import { goalDistanceXZ } from './RoverDynamics'

export type MissionStatus = 'pending' | 'active' | 'succeeded' | 'failed'

export interface NavigationMission {
  id: string
  roverId: string
  start: Vector3
  target: Vector3
  toleranceM: number
  timeLimitS: number
  elapsedS: number
  status: MissionStatus
  failReason: string | null
}

export interface MissionBounds {
  halfExtent: number
}

/**
 * Pure mission evaluation over one step. Arrival is horizontal distance
 * within tolerance; timeout and out-of-bounds fail. No side effects.
 */
export function evaluateMissionStep(
  mission: NavigationMission,
  roverPosition: Vector3,
  dt: number,
  bounds: MissionBounds | null,
): NavigationMission {
  if (mission.status !== 'active') return mission
  const elapsedS = mission.elapsedS + dt
  const distance = goalDistanceXZ(roverPosition, mission.target)
  if (distance <= mission.toleranceM) {
    return { ...mission, elapsedS, status: 'succeeded', failReason: null }
  }
  if (elapsedS >= mission.timeLimitS) {
    return { ...mission, elapsedS, status: 'failed', failReason: 'time-limit' }
  }
  if (
    bounds &&
    (Math.abs(roverPosition.x) > bounds.halfExtent || Math.abs(roverPosition.z) > bounds.halfExtent)
  ) {
    return { ...mission, elapsedS, status: 'failed', failReason: 'out-of-bounds' }
  }
  return { ...mission, elapsedS }
}

/** Owns mission lifecycles for all rovers; physics-agnostic. */
export class MissionManager {
  private readonly missions = new Map<string, NavigationMission>()
  private sequence = 0

  public create(roverId: string, start: Vector3, target: Vector3, toleranceM: number, timeLimitS: number): NavigationMission {
    this.sequence += 1
    const mission: NavigationMission = {
      id: `mission-${this.sequence}`,
      roverId,
      start: { ...start },
      target: { ...target },
      toleranceM,
      timeLimitS,
      elapsedS: 0,
      status: 'pending',
      failReason: null,
    }
    this.missions.set(mission.id, mission)
    return { ...mission }
  }

  public get(missionId: string): NavigationMission | null {
    const mission = this.missions.get(missionId)
    return mission ? { ...mission } : null
  }

  public missionForRover(roverId: string): NavigationMission | null {
    for (const mission of this.missions.values()) {
      if (mission.roverId === roverId && (mission.status === 'pending' || mission.status === 'active')) {
        return { ...mission }
      }
    }
    return null
  }

  public start(missionId: string): NavigationMission | null {
    const mission = this.missions.get(missionId)
    if (!mission || mission.status !== 'pending') return mission ? { ...mission } : null
    const started: NavigationMission = { ...mission, status: 'active', elapsedS: 0, failReason: null }
    this.missions.set(missionId, started)
    return { ...started }
  }

  public abort(missionId: string): NavigationMission | null {
    const mission = this.missions.get(missionId)
    if (!mission) return null
    const aborted: NavigationMission = { ...mission, status: 'failed', failReason: 'aborted' }
    this.missions.set(missionId, aborted)
    return { ...aborted }
  }

  public resetMission(missionId: string): NavigationMission | null {
    const mission = this.missions.get(missionId)
    if (!mission) return null
    const reset: NavigationMission = { ...mission, elapsedS: 0, status: 'pending', failReason: null }
    this.missions.set(missionId, reset)
    return { ...reset }
  }

  public removeRoverMissions(roverId: string): void {
    for (const [id, mission] of this.missions) {
      if (mission.roverId === roverId) this.missions.delete(id)
    }
  }

  /** Advances all active missions from current rover positions. */
  public update(dt: number, positions: ReadonlyMap<string, Vector3>, bounds: MissionBounds | null): void {
    for (const [id, mission] of this.missions) {
      if (mission.status !== 'active') continue
      const position = positions.get(mission.roverId)
      if (!position) continue
      this.missions.set(id, evaluateMissionStep(mission, position, dt, bounds))
    }
  }
}
