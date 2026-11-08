import { NavigationController, type Controller, type ControlInput } from '../../../physics/src/robotics/controllers'
import { buildObservation } from '../../../physics/src/robotics/RoverDynamics'
import { resolveRoverConfig, type DriveAction } from '../../../physics/src/robotics/RoverConfig'

export const Q_ACTIONS = [
  { heading: 0.8, yawDamping: 1.2, maxTurn: 0.6, cruise: 0.2 },
  { heading: 0.8, yawDamping: 1.2, maxTurn: 0.6, cruise: 0.4 },
  { heading: 0.8, yawDamping: 1.2, maxTurn: 0.6, cruise: 0.65 },
  { heading: 1.2, yawDamping: 1.2, maxTurn: 0.6, cruise: 0.35 },
  { heading: 0.6, yawDamping: 1.8, maxTurn: 0.4, cruise: 0.35 },
] as const
export const Q_DECISION_SECONDS = 8 / 60
export interface RoverQPolicy {
  format: 'ark-rover-q-v1'
  planet: 'mars'
  terrainSeed: number
  terrainSubdivisions: number
  trainedSteps: number
  trainingSeconds: number
  q: Record<string, number[]>
  evaluation?: { episodes: number; successRate: number; baselineSuccessRate: number; meanReturn: number }
}

/** Small state abstraction; distances and rates use ARK's existing normalized observation. */
export function qState(obs: ArrayLike<number>): string {
  if (obs.length !== 12 || !Array.from(obs).every(Number.isFinite)) throw new Error('Invalid rover observation')
  const bin = (n: number, edges: number[]): number => edges.filter((edge) => n >= edge).length
  return [bin(Math.abs(obs[1]!), [0.05, 0.15, 0.35, 0.65]), bin(obs[3]!, [0.08, 0.25]),
    bin(Math.abs(obs[4]!), [0.12, 0.4]), bin(obs[0]!, [0.06]), bin(obs[7]!, [0.15])].join(':')
}
export function greedyAction(row?: number[]): number {
  let best = 1 // unseen/tied states use the existing navigation gains
  if (row) for (let i = 0; i < Q_ACTIONS.length; i++) if (row[i]! > row[best]!) best = i
  return best
}
export function useRoverQ(policy: RoverQPolicy, planet: string, requested = false): boolean {
  return planet === 'mars' && (requested || (policy.evaluation !== undefined &&
    policy.evaluation.episodes >= 40 && policy.evaluation.successRate > policy.evaluation.baselineSuccessRate))
}
export function updateQ(policy: RoverQPolicy, state: string, action: number, reward: number, next: string, terminal: boolean, alpha = 0.15, gamma = 0.98): void {
  if (!Number.isInteger(action) || !Q_ACTIONS[action] || !Number.isFinite(reward)) throw new Error('Invalid Q transition')
  const row = policy.q[state] ??= Array(Q_ACTIONS.length).fill(0)
  const nextRow = policy.q[next]
  const target = reward + (terminal ? 0 : gamma * (nextRow ? Math.max(...nextRow) : 0))
  row[action]! += alpha * (target - row[action]!)
}
export function validateQPolicy(value: unknown): asserts value is RoverQPolicy {
  const p = value as RoverQPolicy
  if (!p || p.format !== 'ark-rover-q-v1' || p.planet !== 'mars' || !p.q || Array.isArray(p.q) ||
      !Number.isFinite(p.trainedSteps) || p.trainedSteps < 1 || !Number.isFinite(p.trainingSeconds) || p.trainingSeconds < 0 ||
      !Number.isInteger(p.terrainSeed) || !Number.isInteger(p.terrainSubdivisions) || p.terrainSubdivisions < 8 ||
      Object.entries(p.q).some(([key, row]) => !/^\d:\d:\d:\d:\d$/.test(key) || !Array.isArray(row) || row.length !== Q_ACTIONS.length || !row.every(Number.isFinite))) {
    throw new Error('Invalid rover Q-learning checkpoint')
  }
  if (p.evaluation && (!Number.isInteger(p.evaluation.episodes) || p.evaluation.episodes < 1 ||
      ![p.evaluation.successRate, p.evaluation.baselineSuccessRate].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isFinite(p.evaluation.meanReturn))) throw new Error('Invalid Q evaluation')
}

/** Learns a choice of bounded navigation gains; wheel physics and safety stay in ARK. */
export class RoverQController implements Controller {
  readonly kind = 'external' as const
  private readonly controllers = Q_ACTIONS.map((gains) => new NavigationController(gains))
  private remaining = 0
  private selected = 1
  private forced: number | null = null
  constructor(private readonly policy: RoverQPolicy) {}
  forceAction(action: number): void {
    if (!Q_ACTIONS[action]) throw new Error('Invalid rover Q action')
    this.forced = action
  }
  update(input: ControlInput, dt: number): DriveAction {
    if (this.forced !== null) this.selected = this.forced
    else if (this.remaining <= 1e-8) {
      const obs = buildObservation(input.roverConfig ?? resolveRoverConfig({}), {
        position: input.position, yawRad: input.yawRad, yawRate: input.yawRateRadS, speed: input.speed,
        ranges: input.ranges, target: input.target, batteryPercent: input.batteryPercent ?? 1, traction: input.traction ?? 1,
      })
      this.selected = greedyAction(this.policy.q[qState(obs)])
      this.remaining = Q_DECISION_SECONDS
    }
    this.remaining -= Math.max(0, dt)
    return this.controllers[this.selected]!.update(input, dt)
  }
  reset(): void { this.remaining = 0; this.selected = 1; this.forced = null }
}
