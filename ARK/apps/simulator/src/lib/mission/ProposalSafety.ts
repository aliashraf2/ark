import type { PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import type { InterpretResponse } from './MissionClient'
import { normalizeCommand, type NormalizedCommand } from './WorldCommands'

/** Shared typed/voice staging uses the existing validator as final authority. */
export function prepareProposal(response: InterpretResponse, planet: PlanetId, autoExecute: boolean): {
  commands: NormalizedCommand[]; warnings: string[]; needsApproval: boolean
} {
  const commands: NormalizedCommand[] = []
  const warnings: string[] = []
  const ids = new Set<string>()
  let needsApproval = !autoExecute
  for (const action of response.actions) {
    if (!action.command_id || ids.has(action.command_id)) throw new Error('Proposal has missing or repeated command identifiers.')
    ids.add(action.command_id)
    const proposal = normalizeCommand(action.command, action.params, planet, action.command_id)
    if (!proposal.normalized) {
      throw new Error(`Local validation rejected “${action.command}”: ${proposal.validation.errors.join('; ')}`)
    }
    commands.push(proposal.normalized)
    warnings.push(...proposal.validation.warnings, ...action.warnings)
    if (proposal.validation.requiresConfirmation || action.requires_confirmation) {
      needsApproval = true
      warnings.push(`“${action.command}” requires confirmation.`)
    }
  }
  return { commands, warnings: [...new Set(warnings)], needsApproval }
}
