import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'

export type RescuePhase =
  | 'idle'
  | 'exploring'
  | 'assistance-requested'
  | 'responder-assigned'
  | 'responder-enroute'
  | 'rendezvous'
  | 'recovering'
  | 'completed'
  | 'failed'

export interface RescueMission {
  id: string
  explorerId: string
  responderId: string | null
  failure: string | null
  phase: RescuePhase
  startTimeS: number
  failurePosition: Vector3 | null
  safeTarget: Vector3
  elapsedS: number
  rescuedDistanceM: number
}

const TRANSITIONS: Readonly<Record<RescuePhase, readonly RescuePhase[]>> = Object.freeze({
  idle: ['exploring'],
  exploring: ['assistance-requested', 'failed'],
  'assistance-requested': ['responder-assigned', 'failed'],
  'responder-assigned': ['responder-enroute', 'failed'],
  'responder-enroute': ['rendezvous', 'failed'],
  rendezvous: ['recovering', 'failed'],
  recovering: ['completed', 'failed'],
  completed: ['exploring'],
  failed: ['exploring'],
})

export function transitionRescue(mission: RescueMission, phase: RescuePhase): RescueMission {
  if (!TRANSITIONS[mission.phase].includes(phase)) {
    throw new Error(`Invalid rescue transition ${mission.phase} -> ${phase}.`)
  }
  return { ...mission, phase }
}

export function rescueDistance(position: Vector3, target: Vector3): number {
  return Math.hypot(position.x - target.x, position.z - target.z)
}

