import {
  actionBounds,
  createArkEnvironment,
  observationBounds,
  type ArkEnvironment,
  type ArkEnvironmentConfig,
  type EpisodeMetrics,
  type ResetOptions,
  type RoverRLAction,
  type StepResult,
} from '../../../packages/rl/src/index'
import { DroneEnvironment, type DroneEnvironmentConfig } from '../../../packages/rl/src/environment/DroneEnvironment'
import { createEpisodeMetrics } from '../../../packages/rl/src/environment/EpisodeState'

/** Maximum live environments per bridge process (sequential stepping). */
export const DEFAULT_MAX_ENVS = 8

export class RegistryError extends Error {
  public readonly code: 'unknown_env' | 'env_limit'
  public constructor(code: 'unknown_env' | 'env_limit', message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

interface RegistryEntry {
  env: ArkEnvironment | DroneEnvironment
  agentType: 'rover' | 'drone'
  actionSize: number
  hasReset: boolean
  done: boolean
  lastMetrics: Record<string, unknown>
}

export interface SpaceDescription {
  shape: number[]
  low: number[]
  high: number[]
  dtype: 'float32'
}

function describeSpace(low: Float32Array, high: Float32Array): SpaceDescription {
  return { shape: [low.length], low: Array.from(low), high: Array.from(high), dtype: 'float32' }
}

/**
 * Owns independent ArkEnvironment instances inside one bridge process: one
 * Rapier world, rover, terrain, scenario, and episode state each. Thin by
 * design — all simulation behavior stays in Phase 6.2; this only tracks
 * lifecycle for protocol-level errors and get_metrics caching.
 */
export class EnvironmentRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private nextId = 1
  private readonly maxEnvs: number

  public constructor(maxEnvs: number = DEFAULT_MAX_ENVS) {
    this.maxEnvs = maxEnvs
  }

  public get size(): number {
    return this.entries.size
  }

  public async create(config: ArkEnvironmentConfig & { agentType?: 'rover' | 'drone' }): Promise<string> {
    if (this.entries.size >= this.maxEnvs) {
      throw new RegistryError('env_limit', `Live environment limit reached (${this.maxEnvs}). Close one first.`)
    }
    const agentType = config.agentType ?? 'rover'
    const env = agentType === 'drone'
      ? await DroneEnvironment.create(config as DroneEnvironmentConfig)
      : await createArkEnvironment(config)
    const envId = `env-${this.nextId}`
    this.nextId += 1
    const spaces = agentType === 'drone' ? (env as DroneEnvironment).getSpaces() : null
    this.entries.set(envId, { env, agentType, actionSize: spaces?.action.shape[0] ?? 2, hasReset: false, done: false, lastMetrics: createEpisodeMetrics() as unknown as Record<string, unknown> })
    return envId
  }

  private get(envId: string): RegistryEntry {
    const entry = this.entries.get(envId)
    if (!entry) throw new RegistryError('unknown_env', `Unknown or closed envId ${JSON.stringify(envId)}.`)
    return entry
  }

  public reset(envId: string, seed: number | undefined, options: ResetOptions): { observation: Float32Array; info: unknown } {
    const entry = this.get(envId)
    const result = entry.env.reset(seed, options)
    entry.hasReset = true
    entry.done = false
    entry.lastMetrics = createEpisodeMetrics() as unknown as Record<string, unknown>
    if (entry.agentType === 'rover' && 'scenario' in result.info) {
      entry.lastMetrics.finalDistanceM = result.info.scenario.distanceM
    }
    return result
  }

  public step(envId: string, action: number[]): StepResult | ReturnType<DroneEnvironment['step']> {
    const entry = this.get(envId)
    if (!entry.hasReset) {
      throw new StepOrderError('step_before_reset', 'step() before reset(): call reset() to start an episode first.')
    }
    if (entry.done) {
      throw new StepOrderError('step_after_done', 'step() after episode end: call reset() to start a new episode.')
    }
    if (action.length !== entry.actionSize) throw new Error(`Action must have ${entry.actionSize} values for the ${entry.agentType} environment.`)
    // The wire protocol and Gymnasium both expose actions as numeric arrays.
    // Rover's physics environment accepts its named action object, so convert
    // at this boundary instead of forwarding an incompatible array.
    const result = entry.agentType === 'drone'
      ? (entry.env as DroneEnvironment).step(action as unknown as readonly [number, number, number])
      : (entry.env as ArkEnvironment).step({ leftDrive: action[0]!, rightDrive: action[1]! } as RoverRLAction)
    entry.lastMetrics = { ...result.info.metrics }
    if (result.terminated || result.truncated) entry.done = true
    return result
  }

  public getSpaces(agentType: 'rover' | 'drone' = 'rover'): { observation: SpaceDescription; action: SpaceDescription } {
    if (agentType === 'drone') return DroneEnvironment.spaces()
    const obs = observationBounds()
    const act = actionBounds()
    return { observation: describeSpace(obs.low, obs.high), action: describeSpace(act.low, act.high) }
  }

  public actionSize(envId: string): number { return this.get(envId).actionSize }

  public getMetrics(envId: string): Record<string, unknown> {
    const entry = this.get(envId)
    if (!entry.hasReset) {
      throw new StepOrderError('step_before_reset', 'get_metrics() before reset(): no episode has started.')
    }
    return { ...entry.lastMetrics }
  }

  public close(envId: string): void {
    const entry = this.get(envId)
    entry.env.close()
    this.entries.delete(envId)
  }

  public closeAll(): void {
    for (const [envId, entry] of this.entries) {
      try {
        entry.env.close()
      } catch (error) {
        console.error(`[bridge] error closing ${envId}:`, error instanceof Error ? error.message : error)
      }
    }
    this.entries.clear()
  }
}

export class StepOrderError extends Error {
  public readonly code: 'step_before_reset' | 'step_after_done'
  public constructor(code: 'step_before_reset' | 'step_after_done', message: string) {
    super(message)
    this.name = 'StepOrderError'
    this.code = code
  }
}
