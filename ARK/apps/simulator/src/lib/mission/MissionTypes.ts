import type { EnvironmentSnapshot } from '../types/EnvironmentTypes'
import type { PlanetId } from '../worlds/PlanetConfig'
import type { NormalizedCommand } from './WorldCommands'

export interface BodySnapshot {
  position: { x: number; y: number; z: number }
  velocityY: number
}

/** Point-in-time world snapshot: the verified truth the agent reports from. */
export interface WorldStateSnapshot {
  planet: PlanetId
  planetDisplayName: string
  simTime: number
  status: 'running' | 'paused'
  gravity: { x: number; y: number; z: number }
  sphere: BodySnapshot
  box: BodySnapshot | null
  environment: EnvironmentSnapshot
  seed: number
  profileId: string
}

export type ExecutionOutcome = 'executed' | 'duplicate' | 'failed' | 'read'

export interface CommandResult {
  commandId: string
  command: string
  outcome: ExecutionOutcome
  /** Human-readable one-liner for the UI. */
  message: string
  /** Command-specific return data (world state, capability list, removed flag…). */
  data?: unknown
  error?: string
  stateBefore: WorldStateSnapshot | null
  stateAfter: WorldStateSnapshot | null
}

/** Audit record for one executed intervention (§14). Pure-constructed. */
export interface AuditRecord {
  commandId: string
  requestText: string
  capability: string
  params: Record<string, unknown>
  planet: PlanetId
  simTime: number
  stateBefore: WorldStateSnapshot
  stateAfter: WorldStateSnapshot
  warnings: string[]
  outcome: ExecutionOutcome
  error?: string
  recordedAt: string
}

export function buildAuditRecord(
  normalized: NormalizedCommand,
  requestText: string,
  stateBefore: WorldStateSnapshot,
  stateAfter: WorldStateSnapshot,
  warnings: string[],
  outcome: ExecutionOutcome,
  error?: string,
): AuditRecord {
  return {
    commandId: normalized.commandId,
    requestText,
    capability: normalized.command,
    params: { ...normalized.params },
    planet: normalized.planet,
    simTime: stateBefore.simTime,
    stateBefore,
    stateAfter,
    warnings: [...warnings],
    outcome,
    ...(error !== undefined ? { error } : {}),
    recordedAt: new Date().toISOString(),
  }
}
