import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { getPlanet } from '../../../../../packages/physics/src/worlds/planetPresets'
import {
  normalizeCommand,
  WORLD_COMMANDS,
  type CommandDescriptor,
  type WorldCommandId,
} from './WorldCommands'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const PROTOCOL_PATH = join(REPO_ROOT, 'packages', 'shared', 'world-commands.json')

interface CanonicalProtocol {
  protocol: string
  version: string
  planets: Record<string, { gravity: number; temperatureMinK: number; temperatureMaxK: number }>
  commands: Record<string, CanonicalCommand>
}

interface CanonicalCommand {
  description: string
  planets: string[]
  requiresConfirmation: boolean
  reversible: boolean
  params: Record<string, Record<string, unknown>>
}

function loadProtocol(): CanonicalProtocol {
  return JSON.parse(readFileSync(PROTOCOL_PATH, 'utf-8')) as CanonicalProtocol
}

describe('Contract: TS registry agrees with canonical world-commands.json', () => {
  it('declares the same command set', () => {
    const protocol = loadProtocol()
    expect(protocol.protocol).toBe('ark.world-commands')
    const canonicalIds = Object.keys(protocol.commands).sort()
    const registryIds = Object.keys(WORLD_COMMANDS).sort()
    expect(registryIds).toEqual(canonicalIds)
  })

  it('matches descriptors, planets, flags, and param schemas', () => {
    const protocol = loadProtocol()
    for (const [id, canonical] of Object.entries(protocol.commands)) {
      const descriptor: CommandDescriptor = WORLD_COMMANDS[id as WorldCommandId]
      expect(descriptor.description).toBe(canonical.description)
      expect([...descriptor.planets].sort()).toEqual([...canonical.planets].sort())
      expect(descriptor.requiresConfirmation).toBe(canonical.requiresConfirmation)
      expect(descriptor.reversible).toBe(canonical.reversible)
      expect(Object.keys(descriptor.params).sort()).toEqual(Object.keys(canonical.params).sort())
      for (const [name, schema] of Object.entries(canonical.params)) {
        const local = descriptor.params[name]
        expect(local?.type).toBe(schema['type'])
        for (const field of ['unit', 'min', 'max', 'values', 'range', 'required', 'default'] as const) {
          expect(local?.[field] ?? null, `${id}.${name}.${field}`).toEqual(schema[field] ?? null)
        }
      }
    }
  })

  it('embeds planet reference values identical to the TS configs', () => {
    const protocol = loadProtocol()
    for (const planet of ['earth', 'mars'] as const) {
      const config = getPlanet(planet)
      const canonical = protocol.planets[planet]
      expect(canonical?.gravity).toBe(config.gravity)
      expect(canonical?.temperatureMinK).toBe(config.temperature.min)
      expect(canonical?.temperatureMaxK).toBe(config.temperature.max)
    }
  })
})

describe('normalizeCommand validation', () => {
  it('accepts a valid command with normalized defaults', () => {
    const proposal = normalizeCommand(
      'start_weather_event',
      { type: 'rain', targets: { precipitation: 12 } },
      'earth',
      'cmd-1',
    )
    expect(proposal.validation.ok).toBe(true)
    expect(proposal.normalized?.commandId).toBe('cmd-1')
    expect(proposal.normalized?.params).toMatchObject({
      type: 'rain',
      rampUp: 5,
      hold: 30,
      rampDown: 5,
      priority: 1,
    })
  })

  it('rejects unknown commands, params, and bad types', () => {
    expect(normalizeCommand('nope', {}, 'earth').validation.ok).toBe(false)
    const extra = normalizeCommand('set_wind', { speed_mps: 5, direction_from_deg: 0, bogus: 1 }, 'earth')
    expect(extra.validation.ok).toBe(false)
    const badType = normalizeCommand('set_wind', { speed_mps: 'fast', direction_from_deg: 0 }, 'earth')
    expect(badType.validation.ok).toBe(false)
    const missing = normalizeCommand('set_wind', { speed_mps: 5 }, 'earth')
    expect(missing.validation.ok).toBe(false)
  })

  it('rejects out-of-range values instead of clamping', () => {
    expect(normalizeCommand('set_wind', { speed_mps: 61, direction_from_deg: 0 }, 'earth').validation.ok).toBe(false)
    expect(
      normalizeCommand('set_surface_traction', { multiplier: 0.1 }, 'earth').validation.ok,
    ).toBe(false)
    expect(
      normalizeCommand('set_temperature', { celsius: 100 }, 'earth').validation.ok,
    ).toBe(false)
    expect(
      normalizeCommand('set_temperature', { celsius: -200 }, 'mars').validation.ok,
    ).toBe(false)
    // Planet-resolved bounds differ: -60 C is fine on Mars, invalid on Earth.
    expect(normalizeCommand('set_temperature', { celsius: -60 }, 'mars').validation.ok).toBe(true)
    expect(normalizeCommand('set_temperature', { celsius: -60 }, 'earth').validation.ok).toBe(false)
  })

  it('refuses planet-incompatible events', () => {
    const rain = normalizeCommand(
      'start_weather_event',
      { type: 'rain', targets: { precipitation: 5 } },
      'mars',
    )
    expect(rain.validation.ok).toBe(false)
    const storm = normalizeCommand(
      'start_weather_event',
      { type: 'dust-storm', targets: { dustTau: 1 } },
      'earth',
    )
    expect(storm.validation.ok).toBe(false)
  })

  it('labels gravity overrides and escalates extreme ones to confirmation', () => {
    const mild = normalizeCommand('set_gravity', { magnitude_mps2: 12 }, 'earth')
    expect(mild.validation.ok).toBe(true)
    expect(mild.validation.experimentalOverride).toBe(true)
    expect(mild.validation.requiresConfirmation).toBe(false)
    expect(mild.validation.warnings.join(' ')).toMatch(/experimental override/)

    const extreme = normalizeCommand('set_gravity', { magnitude_mps2: 25 }, 'earth')
    expect(extreme.validation.requiresConfirmation).toBe(true)

    const exact = normalizeCommand('set_gravity', { magnitude_mps2: 9.80665 }, 'earth')
    expect(exact.validation.experimentalOverride).toBe(false)
  })

  it('rejects non-finite and oversized event targets', () => {
    const nan = normalizeCommand(
      'start_weather_event',
      { type: 'wind', targets: { wind: { x: Number.NaN, y: 0, z: 0 } } },
      'earth',
    )
    expect(nan.validation.ok).toBe(false)
    const huge = normalizeCommand(
      'start_weather_event',
      { type: 'wind', targets: { wind: { x: 100, y: 0, z: 0 } } },
      'earth',
    )
    expect(huge.validation.ok).toBe(false)
    const empty = normalizeCommand('start_weather_event', { type: 'wind', targets: {} }, 'earth')
    expect(empty.validation.ok).toBe(false)
  })

  it('marks disruptive commands for confirmation', () => {
    for (const command of ['switch_planet', 'regenerate_terrain', 'reset_environment', 'apply_scenario'] as const) {
      const params =
        command === 'switch_planet'
          ? { planet: 'mars' }
          : command === 'apply_scenario'
            ? { scenario_id: 'earth-clear' }
            : {}
      const proposal = normalizeCommand(command, params, 'earth')
      expect(proposal.validation.ok).toBe(true)
      expect(proposal.validation.requiresConfirmation).toBe(true)
    }
  })
})
