import type { StartEventSpec } from '../environment/EnvironmentController'
import type { PlanetId } from '../worlds/PlanetConfig'
import type {
  AuditRecord,
  CommandResult,
  WorldStateSnapshot,
} from './MissionTypes'
import { buildAuditRecord } from './MissionTypes'
import { isReadOnlyCommand, WORLD_COMMANDS, type NormalizedCommand } from './WorldCommands'

/**
 * Structural engine surface the dispatcher needs. SimulationEngine satisfies
 * this implicitly; tests inject fakes. Keeps mission code decoupled from core.
 */
export interface CommandExecutor {
  switchPlanet(planet: PlanetId): void
  regenerateTerrain(seed?: number): void
  setGravity(magnitude: number): void
  setWind(speedMps: number, directionFromDeg: number): unknown
  setTemperatureCelsius(celsius: number): unknown
  setTractionMultiplier(multiplier: number): unknown
  startEvent(spec: StartEventSpec): unknown
  stopEvent(id: string): boolean
  setSolarMultiplier(multiplier: number): unknown
  pause(): void
  resume(): void
  resetEnvironment(): unknown
  applyScenario(scenarioId: string): unknown
  getWorldState(): WorldStateSnapshot
}

export interface DispatchOptions {
  /** Original user text for the audit trail. */
  requestText?: string
  warnings?: string[]
  /** When true, confirmation-gated commands execute without a UI prompt. */
  preApproved?: boolean
}

/**
 * Executes validated world commands against the simulation. Idempotent by
 * command id, never throws (failures become CommandResults), and builds an
 * audit record for every mutating execution from verified before/after states.
 */
export class CommandDispatcher {
  private readonly executor: CommandExecutor
  private readonly executedIds = new Set<string>()
  private readonly auditLog: AuditRecord[] = []

  constructor(executor: CommandExecutor) {
    this.executor = executor
  }

  public get history(): AuditRecord[] {
    return [...this.auditLog]
  }

  public dispatch(normalized: NormalizedCommand, options: DispatchOptions = {}): CommandResult {
    if (this.executedIds.has(normalized.commandId)) {
      const state = this.safeWorldState()
      return {
        commandId: normalized.commandId,
        command: normalized.command,
        outcome: 'duplicate',
        message: `Command ${normalized.commandId} was already executed; skipped.`,
        stateBefore: state,
        stateAfter: state,
      }
    }

    if (isReadOnlyCommand(normalized.command)) {
      return this.dispatchRead(normalized)
    }

    const stateBefore = this.safeWorldState()
    try {
      const data = this.execute(normalized)
      this.executedIds.add(normalized.commandId)
      const stateAfter = this.safeWorldState()
      if (stateBefore && stateAfter) {
        this.auditLog.push(
          buildAuditRecord(
            normalized,
            options.requestText ?? '',
            stateBefore,
            stateAfter,
            options.warnings ?? [],
            'executed',
          ),
        )
      }
      return {
        commandId: normalized.commandId,
        command: normalized.command,
        outcome: 'executed',
        message: describeExecution(normalized),
        data,
        stateBefore,
        stateAfter,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Execution failed.'
      const stateAfter = this.safeWorldState()
      if (stateBefore && stateAfter) {
        this.auditLog.push(
          buildAuditRecord(
            normalized,
            options.requestText ?? '',
            stateBefore,
            stateAfter,
            options.warnings ?? [],
            'failed',
            message,
          ),
        )
      }
      return {
        commandId: normalized.commandId,
        command: normalized.command,
        outcome: 'failed',
        message,
        error: message,
        stateBefore,
        stateAfter,
      }
    }
  }

  /**
   * Replays a past intervention from a reset world with the same seed:
   * regenerate seed, reset environment, then re-dispatch the command fresh.
   */
  public replay(record: AuditRecord): CommandResult[] {
    const results: CommandResult[] = []
    const seedCmd: NormalizedCommand = {
      commandId: `${record.commandId}-replay-seed`,
      command: 'regenerate_terrain',
      params: { seed: record.stateBefore.seed },
      planet: record.planet,
    }
    results.push(this.dispatch(seedCmd, { requestText: `Replay of ${record.commandId}: restore seed` }))
    const resetCmd: NormalizedCommand = {
      commandId: `${record.commandId}-replay-reset`,
      command: 'reset_environment',
      params: {},
      planet: record.planet,
    }
    results.push(this.dispatch(resetCmd, { requestText: `Replay of ${record.commandId}: reset env` }))
    const redispatch: NormalizedCommand = {
      commandId: `${record.commandId}-replay`,
      command: record.capability as NormalizedCommand['command'],
      params: { ...record.params },
      planet: record.planet,
    }
    results.push(
      this.dispatch(redispatch, {
        requestText: `Replay of ${record.commandId}: ${record.requestText}`,
      }),
    )
    return results
  }

  private dispatchRead(normalized: NormalizedCommand): CommandResult {
    const state = this.safeWorldState()
    if (normalized.command === 'get_world_state') {
      return {
        commandId: normalized.commandId,
        command: normalized.command,
        outcome: 'read',
        message: 'World state captured.',
        data: state,
        stateBefore: state,
        stateAfter: state,
      }
    }
    const capabilities = Object.values(WORLD_COMMANDS).map((descriptor) => ({
      id: descriptor.id,
      description: descriptor.description,
      planets: descriptor.planets,
      requiresConfirmation: descriptor.requiresConfirmation,
      reversible: descriptor.reversible,
      params: descriptor.params,
    }))
    return {
      commandId: normalized.commandId,
      command: normalized.command,
      outcome: 'read',
      message: `${capabilities.length} capabilities registered.`,
      data: capabilities,
      stateBefore: state,
      stateAfter: state,
    }
  }

  private execute(normalized: NormalizedCommand): unknown {
    // Params were validated by normalizeCommand; casts below are provably safe.
    const params = normalized.params
    switch (normalized.command) {
      case 'switch_planet':
        return this.executor.switchPlanet(params['planet'] as PlanetId)
      case 'regenerate_terrain':
        return this.executor.regenerateTerrain(params['seed'] as number | undefined)
      case 'set_gravity':
        return this.executor.setGravity(params['magnitude_mps2'] as number)
      case 'set_wind':
        return this.executor.setWind(
          params['speed_mps'] as number,
          params['direction_from_deg'] as number,
        )
      case 'set_temperature':
        return this.executor.setTemperatureCelsius(params['celsius'] as number)
      case 'set_surface_traction':
        return this.executor.setTractionMultiplier(params['multiplier'] as number)
      case 'start_weather_event':
        return this.executor.startEvent({
          type: params['type'] as StartEventSpec['type'],
          targets: (params['targets'] ?? {}) as StartEventSpec['targets'],
          delay: params['delay'] as number | undefined,
          rampUp: params['rampUp'] as number | undefined,
          hold: params['hold'] as number | undefined,
          rampDown: params['rampDown'] as number | undefined,
          priority: params['priority'] as number | undefined,
        })
      case 'stop_weather_event':
        return this.executor.stopEvent(params['id'] as string)
      case 'set_solar_illumination':
        return this.executor.setSolarMultiplier(params['multiplier'] as number)
      case 'pause_simulation':
        return this.executor.pause()
      case 'resume_simulation':
        return this.executor.resume()
      case 'reset_environment':
        return this.executor.resetEnvironment()
      case 'apply_scenario':
        return this.executor.applyScenario(params['scenario_id'] as string)
      default:
        throw new Error(`No execution adapter for "${normalized.command}".`)
    }
  }

  private safeWorldState(): WorldStateSnapshot | null {
    try {
      return this.executor.getWorldState()
    } catch {
      return null
    }
  }
}

function describeExecution(normalized: NormalizedCommand): string {
  const params = Object.entries(normalized.params)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ')
  return `Executed ${normalized.command}${params ? ` (${params})` : ''}.`
}
