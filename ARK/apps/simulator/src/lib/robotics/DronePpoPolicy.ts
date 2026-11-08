import type { DroneRLAction } from '../../../../../packages/physics/src/robotics/DroneDynamics'

export interface DronePpoPolicy {
  format: 'ark-ppo-drone-mlp-v1'
  agent: 'drone'
  planet: string
  trainedTimesteps: number
  evaluationEpisodes?: number
  evaluationSuccessRate?: number
  observationSize: 9
  actionSize: 3
  activation: 'tanh'
  hiddenLayers: Array<{ weights: number[][]; bias: number[] }>
  actionLayer: { weights: number[][]; bias: number[] }
}

export async function loadDronePpoPolicy(): Promise<DronePpoPolicy> {
  const response = await fetch(new URL('./ppo_drone_mars.json', import.meta.url))
  if (!response.ok) throw new Error(`Drone PPO policy load failed (${response.status}).`)
  const policy = (await response.json()) as DronePpoPolicy
  if (policy.format !== 'ark-ppo-drone-mlp-v1' || policy.observationSize !== 9 || policy.actionSize !== 3 || policy.activation !== 'tanh') {
    throw new Error('Drone PPO checkpoint does not match the simulator observation and action shapes.')
  }
  if (policy.evaluationSuccessRate !== undefined && (!Number.isFinite(policy.evaluationSuccessRate) || policy.evaluationSuccessRate < 0 || policy.evaluationSuccessRate > 1)) {
    throw new Error('Drone PPO checkpoint has an invalid evaluation success rate.')
  }
  let inputs: number = policy.observationSize
  for (const layer of [...policy.hiddenLayers, policy.actionLayer]) {
    if (layer.weights.length !== layer.bias.length || layer.weights.some((row) => row.length !== inputs)) {
      throw new Error('Drone PPO checkpoint contains incompatible layer dimensions.')
    }
    if (![...layer.weights.flat(), ...layer.bias].every(Number.isFinite)) {
      throw new Error('Drone PPO checkpoint contains non-finite parameters.')
    }
    inputs = layer.weights.length
  }
  return policy
}

export function createDronePpoAction(policy: DronePpoPolicy): (observation: Float32Array) => DroneRLAction {
  return (observation) => {
    let values = Array.from(observation)
    for (const layer of policy.hiddenLayers) values = dense(layer.weights, layer.bias, values).map(Math.tanh)
    const output = dense(policy.actionLayer.weights, policy.actionLayer.bias, values)
    return [clamp(output[0] ?? 0), clamp(output[1] ?? 0), clamp(output[2] ?? 0)]
  }
}

function dense(weights: number[][], bias: number[], input: number[]): number[] {
  return weights.map((row, index) => row.reduce((sum, weight, i) => sum + weight * (input[i] ?? 0), bias[index] ?? 0))
}

function clamp(value: number): number { return Math.max(-1, Math.min(1, value)) }
