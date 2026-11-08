import { buildObservation } from '../../../../../packages/physics/src/robotics/RoverDynamics'
import { angleDifference } from '../../../../../packages/physics/src/robotics/RoverDynamics'
import { NavigationController, type ControlInput, type Controller } from '../../../../../packages/physics/src/robotics/controllers'
import { resolveRoverConfig, type DriveAction } from '../../../../../packages/physics/src/robotics/RoverConfig'

const DEFAULT_ROVER_CONFIG = resolveRoverConfig({})

export interface DenseLayer {
  weights: number[][]
  bias: number[]
}

export interface BrowserPpoPolicy {
  format: 'ark-ppo-mlp-v1' | 'ark-ppo-rover-mlp-v1'
  planet: string
  trainedTimesteps: number
  evaluationEpisodes?: number
  evaluationSuccessRate?: number
  observationSize: number
  activation: 'tanh'
  hiddenLayers: DenseLayer[]
  actionLayer: DenseLayer
}

export async function loadBrowserPpoPolicy(): Promise<BrowserPpoPolicy> {
  const response = await fetch(new URL('./ppo_mars_smoke.json', import.meta.url))
  if (!response.ok) throw new Error(`PPO policy load failed (${response.status}).`)
  const policy = (await response.json()) as BrowserPpoPolicy
  validatePolicy(policy)
  return policy
}

export function createPpoController(policy: BrowserPpoPolicy): Controller {
  return new StabilizedPpoController(policy)
}

export function predictPpoAction(policy: BrowserPpoPolicy, input: ControlInput): DriveAction {
  const observation = Array.from(
    buildObservation(input.roverConfig ?? DEFAULT_ROVER_CONFIG, {
      position: input.position,
      yawRad: input.yawRad,
      speed: input.speed,
      yawRate: input.yawRateRadS,
      ranges: input.ranges,
      batteryPercent: input.batteryPercent ?? 1,
      traction: input.traction ?? 1,
      target: input.target,
    }),
  )
  let activations = observation
  for (const layer of policy.hiddenLayers) {
    activations = dense(layer, activations).map(Math.tanh)
  }
  const action = dense(policy.actionLayer, activations)
  return {
    left: clamp(action[0] ?? 0),
    right: clamp(action[1] ?? 0),
    brake: false,
    eStop: false,
  }
}

function dense(layer: DenseLayer, input: number[]): number[] {
  return layer.weights.map((row, index) => {
    let value = layer.bias[index] ?? 0
    for (let i = 0; i < row.length; i += 1) value += row[i]! * (input[i] ?? 0)
    return value
  })
}

function clamp(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function validatePolicy(policy: BrowserPpoPolicy): void {
  if (
    (policy.format !== 'ark-ppo-mlp-v1' && policy.format !== 'ark-ppo-rover-mlp-v1') ||
    policy.observationSize !== 12 ||
    policy.activation !== 'tanh' ||
    policy.hiddenLayers.length === 0 ||
    policy.actionLayer.weights.length !== 2
  ) {
    throw new Error('PPO checkpoint format does not match the dashboard rover policy.')
  }
  if (policy.evaluationSuccessRate !== undefined && (!Number.isFinite(policy.evaluationSuccessRate) || policy.evaluationSuccessRate < 0 || policy.evaluationSuccessRate > 1)) {
    throw new Error('PPO checkpoint has an invalid evaluation success rate.')
  }
  let inputSize = policy.observationSize
  for (const layer of [...policy.hiddenLayers, policy.actionLayer]) {
    if (layer.weights.length !== layer.bias.length || layer.weights.some((row) => row.length !== inputSize)) {
      throw new Error('PPO checkpoint has incompatible layer dimensions.')
    }
    if (![...layer.weights.flat(), ...layer.bias].every(Number.isFinite)) {
      throw new Error('PPO checkpoint contains a non-finite parameter.')
    }
    inputSize = layer.weights.length
  }
}

/** Keeps an exploratory PPO checkpoint inside the rover's stable yaw envelope. */
class StabilizedPpoController implements Controller {
  public readonly kind = 'external' as const
  private previousLeft = 0
  private previousRight = 0
  private readonly waypointSafety = new NavigationController()

  constructor(private readonly policy: BrowserPpoPolicy) {}

  public update(input: ControlInput, dt: number): DriveAction {
    if (!input.target || input.arrived) {
      this.previousLeft = 0
      this.previousRight = 0
      return { left: 0, right: 0, brake: true, eStop: false }
    }

    const learned = predictPpoAction(this.policy, input)
    const learnedForward = (learned.left + learned.right) / 2
    const learnedTurn = (learned.right - learned.left) / 2
    const turn = clamp(learnedTurn * 0.6 - input.yawRateRadS * 1.2, -0.35, 0.35)
    const spinGate = clamp(1 - Math.abs(input.yawRateRadS) / 2, 0, 1)
    const forward = clamp(learnedForward * 0.55, -0.45, 0.45) * spinGate
    const learnedLeft = clamp(forward - turn)
    const learnedRight = clamp(forward + turn)
    const safe = this.waypointSafety.update(input, dt)
    const desiredLeft = clamp(safe.left * 0.8 + learnedLeft * 0.2)
    const desiredRight = clamp(safe.right * 0.8 + learnedRight * 0.2)
    const blend = dt > 0 ? clamp(dt / (0.12 + dt), 0.05, 1) : 1

    this.previousLeft += (desiredLeft - this.previousLeft) * blend
    this.previousRight += (desiredRight - this.previousRight) * blend

    const dx = input.target.x - input.position.x
    const dz = input.target.z - input.position.z
    const bearing = Math.atan2(dx, dz)
    const headingError = angleDifference(input.yawRad, bearing)
    const nearestForwardRange = input.ranges
      .filter((reading) => Math.abs(reading.angleRad) <= 0.35)
      .reduce((nearest, reading) => Math.min(nearest, reading.distance), Number.POSITIVE_INFINITY)

    return {
      left: this.previousLeft,
      right: this.previousRight,
      brake: Math.abs(headingError) > 1.2 || nearestForwardRange < 0.6,
      eStop: false,
    }
  }

  public reset(): void {
    this.previousLeft = 0
    this.previousRight = 0
    this.waypointSafety.reset()
  }
}
