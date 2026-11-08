import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'
import { hasCapabilities, type CapabilityId, type RobotProfile } from '../capabilities/RobotCapabilityRegistry'

export type CooperativeTaskKind = 'explore' | 'rescue' | 'deliver'
export type CooperativeTaskStatus = 'requested' | 'assigned' | 'accepted' | 'navigating' | 'rendezvous' | 'recovering' | 'completed' | 'failed'

export interface CooperativeTask {
  id: string
  kind: CooperativeTaskKind
  requiredCapabilities: readonly CapabilityId[]
  priority: number
  target: Vector3
  status: CooperativeTaskStatus
  assignedRobotId: string | null
  estimatedEnergyJ: number
  createdAtS: number
  failureReason: string | null
}

export interface RobotCandidate {
  roverId: string
  profile: RobotProfile | null
  position: Vector3
  batteryPercent: number
  available: boolean
  risk: number
}

export interface AllocationWeights {
  distance: number
  battery: number
  energy: number
  risk: number
}

export const DEFAULT_ALLOCATION_WEIGHTS: Readonly<AllocationWeights> = Object.freeze({
  distance: 0.8,
  battery: 20,
  energy: 0.001,
  risk: 15,
})

export interface AllocationResult {
  roverId: string
  score: number
  estimatedTravelEnergyJ: number
}

export function allocateTask(
  task: CooperativeTask,
  candidates: readonly RobotCandidate[],
  weights: AllocationWeights = DEFAULT_ALLOCATION_WEIGHTS,
  batteryReserve = 0.2,
): AllocationResult | null {
  const scored = candidates.flatMap((candidate) => {
    if (!candidate.available || candidate.batteryPercent < batteryReserve) return []
    if (!hasCapabilities(candidate.profile, task.requiredCapabilities)) return []
    const distance = distanceXZ(candidate.position, task.target)
    const estimatedTravelEnergyJ = estimateTravelEnergyJ(distance, task.kind)
    const usableEnergyJ = candidate.batteryPercent * 20_000 * (1 - batteryReserve)
    if (usableEnergyJ < estimatedTravelEnergyJ + task.estimatedEnergyJ) return []
    const score =
      task.priority * 10 -
      distance * weights.distance +
      candidate.batteryPercent * 100 * weights.battery -
      (estimatedTravelEnergyJ + task.estimatedEnergyJ) * weights.energy -
      candidate.risk * weights.risk
    return [{ roverId: candidate.roverId, score, estimatedTravelEnergyJ }]
  })
  scored.sort((a, b) => b.score - a.score || a.roverId.localeCompare(b.roverId))
  return scored[0] ?? null
}

export function estimateTravelEnergyJ(distanceM: number, kind: CooperativeTaskKind): number {
  const recoveryReserve = kind === 'rescue' ? 400 : 0
  return Math.max(0, distanceM) * 45 + recoveryReserve
}

function distanceXZ(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

