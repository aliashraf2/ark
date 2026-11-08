import type { PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import { getPlanet } from '../../../../../packages/physics/src/worlds/planetPresets'

export type WorldCommandId =
  | 'get_world_state'
  | 'list_capabilities'
  | 'switch_planet'
  | 'set_gravity'
  | 'set_wind'
  | 'set_temperature'
  | 'set_surface_traction'
  | 'start_weather_event'
  | 'stop_weather_event'
  | 'set_solar_illumination'
  | 'regenerate_terrain'
  | 'pause_simulation'
  | 'resume_simulation'
  | 'reset_environment'
  | 'apply_scenario'

export type CommandParamType =
  | 'number'
  | 'integer'
  | 'string'
  | 'enum'
  | 'vector3'
  | 'event_targets'

export interface CommandParamSchema {
  type: CommandParamType
  unit?: string
  min?: number
  max?: number
  values?: string[]
  range?: 'planet_temperature' | 'planet_temperature_kelvin'
  required: boolean
  default?: unknown
}

export interface CommandDescriptor {
  id: WorldCommandId
  description: string
  planets: PlanetId[]
  requiresConfirmation: boolean
  confirmWhenExtreme?: boolean
  reversible: boolean
  params: Record<string, CommandParamSchema>
}

/**
 * World command registry. Mirrors packages/shared/world-commands.json, which is
 * the canonical protocol source; WorldCommands.test.ts contract-verifies that
 * the two agree on ids, params, bounds, planets, and flags.
 */
export const WORLD_COMMANDS: Record<WorldCommandId, CommandDescriptor> = {
  get_world_state: {
    id: 'get_world_state',
    description: 'Read the current planet, simulation time, environment state, and test-body telemetry. Read-only.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {},
  },
  list_capabilities: {
    id: 'list_capabilities',
    description: 'List registered world capabilities (built-in and approved synthesized) with schemas.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {},
  },
  switch_planet: {
    id: 'switch_planet',
    description: 'Switch the active world between Earth and Mars. Resets environment and respawns test bodies.',
    planets: ['earth', 'mars'],
    requiresConfirmation: true,
    reversible: true,
    params: {
      planet: { type: 'enum', values: ['earth', 'mars'], required: true },
    },
  },
  set_gravity: {
    id: 'set_gravity',
    description:
      'Set gravitational acceleration magnitude. Values far from the planetary default are labeled experimental overrides, not realistic physics.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    confirmWhenExtreme: true,
    reversible: true,
    params: {
      magnitude_mps2: { type: 'number', unit: 'm/s^2', min: 0.1, max: 30, required: true },
    },
  },
  set_wind: {
    id: 'set_wind',
    description:
      'Set manual wind by speed and meteorological compass direction (degrees clockwise from north, direction FROM which wind blows).',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {
      speed_mps: { type: 'number', unit: 'm/s', min: 0, max: 60, required: true },
      direction_from_deg: { type: 'number', unit: 'deg', min: 0, max: 360, required: true },
    },
  },
  set_temperature: {
    id: 'set_temperature',
    description: 'Set ambient temperature. Display/state only in Milestone 4; no rigid-body coupling claimed.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {
      celsius: { type: 'number', unit: 'degC', range: 'planet_temperature', required: true },
    },
  },
  set_surface_traction: {
    id: 'set_surface_traction',
    description: 'Set the manual surface traction multiplier applied on top of wetness effects.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {
      multiplier: { type: 'number', min: 0.2, max: 1.5, required: true },
    },
  },
  start_weather_event: {
    id: 'start_weather_event',
    description:
      'Start a scheduled weather event (rain, wind gust, dust storm, temperature shift, cloud). Rain/cloud are Earth-only; dust storms are Mars-only.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {
      type: {
        type: 'enum',
        values: ['rain', 'wind', 'dust-storm', 'temperature', 'cloud'],
        required: true,
      },
      targets: { type: 'event_targets', required: true },
      delay: { type: 'number', unit: 's', min: 0, max: 3600, required: false, default: 0 },
      rampUp: { type: 'number', unit: 's', min: 0, max: 3600, required: false, default: 5 },
      hold: { type: 'number', unit: 's', min: 0, max: 7200, required: false, default: 30 },
      rampDown: { type: 'number', unit: 's', min: 0, max: 3600, required: false, default: 5 },
      priority: { type: 'number', min: 1, max: 10, required: false, default: 1 },
    },
  },
  stop_weather_event: {
    id: 'stop_weather_event',
    description: 'Cancel a running weather event by id.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: false,
    params: {
      id: { type: 'string', required: true },
    },
  },
  set_solar_illumination: {
    id: 'set_solar_illumination',
    description:
      'Set a manual solar multiplier (experimental shade) composed with cloud/dust attenuation. 1 = unmodified.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {
      multiplier: { type: 'number', min: 0, max: 1, required: true },
    },
  },
  regenerate_terrain: {
    id: 'regenerate_terrain',
    description:
      'Regenerate terrain from a seed. Omitting the seed picks a fresh random one. Same seed reproduces the same terrain.',
    planets: ['earth', 'mars'],
    requiresConfirmation: true,
    reversible: true,
    params: {
      seed: { type: 'integer', min: 0, max: 2147483647, required: false },
    },
  },
  pause_simulation: {
    id: 'pause_simulation',
    description: 'Pause physics stepping and event progression. Rendering continues.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {},
  },
  resume_simulation: {
    id: 'resume_simulation',
    description: 'Resume physics stepping and event progression.',
    planets: ['earth', 'mars'],
    requiresConfirmation: false,
    reversible: true,
    params: {},
  },
  reset_environment: {
    id: 'reset_environment',
    description: 'Clear all events and restore planet base conditions. Overwrites active schedules.',
    planets: ['earth', 'mars'],
    requiresConfirmation: true,
    reversible: false,
    params: {},
  },
  apply_scenario: {
    id: 'apply_scenario',
    description:
      'Apply a predefined scenario preset (manual settings plus scheduled events). Switches planet first if the scenario belongs to the other world.',
    planets: ['earth', 'mars'],
    requiresConfirmation: true,
    reversible: false,
    params: {
      scenario_id: { type: 'string', required: true },
    },
  },
}

export const EVENT_TYPE_PLANETS: Record<string, PlanetId[]> = {
  rain: ['earth'],
  cloud: ['earth'],
  'dust-storm': ['mars'],
  wind: ['earth', 'mars'],
  temperature: ['earth', 'mars'],
}

export const MAX_WIND_VECTOR_MAGNITUDE = 60

export interface NormalizedCommand {
  /** Unique id for acknowledgement and idempotency. */
  commandId: string
  command: WorldCommandId
  params: Record<string, unknown>
  planet: PlanetId
}

export interface CommandValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  requiresConfirmation: boolean
  experimentalOverride: boolean
}

export interface NormalizedProposal {
  normalized: NormalizedCommand | null
  validation: CommandValidation
}

function temperatureBoundsCelsius(planet: PlanetId): { min: number; max: number } {
  const bounds = getPlanet(planet).temperature
  return { min: bounds.min - 273.15, max: bounds.max - 273.15 }
}

function temperatureBoundsKelvin(planet: PlanetId): { min: number; max: number } {
  const bounds = getPlanet(planet).temperature
  return { min: bounds.min, max: bounds.max }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkFiniteNumber(
  value: unknown,
  label: string,
  errors: string[],
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`)
    return false
  }
  return true
}

/**
 * Pure validation/normalization of one proposed command against the registry.
 * Strict: out-of-range values are rejected (never silently clamped), unknown
 * commands and params are errors, and planet-incompatible events are refused.
 */
export function normalizeCommand(
  command: string,
  rawParams: unknown,
  planet: PlanetId,
  commandId?: string,
): NormalizedProposal {
  const errors: string[] = []
  const warnings: string[] = []
  const descriptor = (WORLD_COMMANDS as Record<string, CommandDescriptor>)[command]
  if (!descriptor) {
    return {
      normalized: null,
      validation: {
        ok: false,
        errors: [`Unknown command "${command}".`],
        warnings,
        requiresConfirmation: false,
        experimentalOverride: false,
      },
    }
  }
  if (!descriptor.planets.includes(planet)) {
    errors.push(`Command "${command}" is not supported on ${planet}.`)
  }
  if (rawParams !== undefined && !isRecord(rawParams)) {
    errors.push(`Params for "${command}" must be an object.`)
  }
  const params: Record<string, unknown> = {}
  const raw = isRecord(rawParams) ? rawParams : {}

  for (const [name, schema] of Object.entries(descriptor.params)) {
    const value = raw[name]
    if (value === undefined) {
      if (schema.required) {
        errors.push(`Missing required param "${name}" for "${command}".`)
      } else if (schema.default !== undefined) {
        params[name] = schema.default
      }
      continue
    }
    validateParam(command, name, schema, value, planet, params, errors)
  }
  for (const name of Object.keys(raw)) {
    if (!(name in descriptor.params)) {
      errors.push(`Unknown param "${name}" for "${command}".`)
    }
  }

  let requiresConfirmation = descriptor.requiresConfirmation
  let experimentalOverride = false
  if (errors.length === 0 && command === 'set_gravity') {
    const magnitude = params['magnitude_mps2'] as number
    const planetary = getPlanet(planet).gravity
    const ratio = magnitude / planetary
    if (magnitude !== planetary) {
      experimentalOverride = true
      warnings.push(
        `Gravity ${magnitude} m/s^2 differs from the ${planet} default (${planetary} m/s^2): experimental override, not realistic planetary physics.`,
      )
    }
    if (ratio > 2 || ratio < 0.5) {
      requiresConfirmation = true
      warnings.push('Extreme gravity override: confirmation required.')
    }
  }
  if (errors.length === 0 && command === 'start_weather_event') {
    const type = params['type'] as string
    const allowed = EVENT_TYPE_PLANETS[type] ?? []
    if (!allowed.includes(planet)) {
      errors.push(`Event type "${type}" cannot run on ${planet}.`)
    }
  }

  if (errors.length > 0) {
    return {
      normalized: null,
      validation: { ok: false, errors, warnings, requiresConfirmation: false, experimentalOverride: false },
    }
  }
  return {
    normalized: {
      commandId: commandId ?? defaultCommandId(),
      command: descriptor.id,
      params,
      planet,
    },
    validation: { ok: true, errors, warnings, requiresConfirmation, experimentalOverride },
  }
}

function validateParam(
  command: string,
  name: string,
  schema: CommandParamSchema,
  value: unknown,
  planet: PlanetId,
  params: Record<string, unknown>,
  errors: string[],
): void {
  const label = `"${name}" for "${command}"`
  switch (schema.type) {
    case 'number':
    case 'integer': {
      if (!checkFiniteNumber(value, label, errors)) return
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${label} must be an integer.`)
        return
      }
      const { min, max } = resolveRange(schema, planet)
      if (min !== undefined && value < min) {
        errors.push(`${label} must be >= ${min}.`)
        return
      }
      if (max !== undefined && value > max) {
        errors.push(`${label} must be <= ${max}.`)
        return
      }
      params[name] = value
      return
    }
    case 'string': {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`${label} must be a non-empty string.`)
        return
      }
      params[name] = value
      return
    }
    case 'enum': {
      if (typeof value !== 'string' || !(schema.values ?? []).includes(value)) {
        errors.push(`${label} must be one of: ${(schema.values ?? []).join(', ')}.`)
        return
      }
      params[name] = value
      return
    }
    case 'vector3': {
      if (!isRecord(value)) {
        errors.push(`${label} must be an {x, y, z} object.`)
        return
      }
      const x = value['x']
      const y = value['y']
      const z = value['z']
      if (
        !checkFiniteNumber(x, `${label}.x`, errors) ||
        !checkFiniteNumber(y, `${label}.y`, errors) ||
        !checkFiniteNumber(z, `${label}.z`, errors)
      ) {
        return
      }
      const magnitude = Math.hypot(x as number, y as number, z as number)
      if (magnitude > MAX_WIND_VECTOR_MAGNITUDE) {
        errors.push(`${label} magnitude must be <= ${MAX_WIND_VECTOR_MAGNITUDE} m/s.`)
        return
      }
      params[name] = { x, y, z }
      return
    }
    case 'event_targets': {
      if (!isRecord(value)) {
        errors.push(`${label} must be an object with at least one target channel.`)
        return
      }
      const targets: Record<string, unknown> = {}
      const entries = Object.entries(value)
      if (entries.length === 0) {
        errors.push(`${label} must include at least one target channel.`)
        return
      }
      for (const [channel, target] of entries) {
        validateTargetChannel(command, channel, target, planet, targets, errors)
      }
      params[name] = targets
      return
    }
  }
}

function validateTargetChannel(
  command: string,
  channel: string,
  target: unknown,
  planet: PlanetId,
  targets: Record<string, unknown>,
  errors: string[],
): void {
  const label = `target "${channel}" for "${command}"`
  switch (channel) {
    case 'wind': {
      if (!isRecord(target)) {
        errors.push(`${label} must be an {x, y, z} object.`)
        return
      }
      const { x, y, z } = target as Record<string, unknown>
      if (
        !checkFiniteNumber(x, `${label}.x`, errors) ||
        !checkFiniteNumber(y, `${label}.y`, errors) ||
        !checkFiniteNumber(z, `${label}.z`, errors)
      ) {
        return
      }
      if (Math.hypot(x as number, y as number, z as number) > MAX_WIND_VECTOR_MAGNITUDE) {
        errors.push(`${label} magnitude must be <= ${MAX_WIND_VECTOR_MAGNITUDE} m/s.`)
        return
      }
      targets[channel] = { x, y, z }
      return
    }
    case 'precipitation':
      if (!checkFiniteNumber(target, label, errors)) return
      if ((target as number) < 0 || (target as number) > 100) {
        errors.push(`${label} must be within 0..100 mm/h.`)
        return
      }
      targets[channel] = target
      return
    case 'dustTau':
      if (!checkFiniteNumber(target, label, errors)) return
      if ((target as number) < 0 || (target as number) > 5) {
        errors.push(`${label} must be within 0..5.`)
        return
      }
      targets[channel] = target
      return
    case 'temperature': {
      if (!checkFiniteNumber(target, label, errors)) return
      const bounds = temperatureBoundsKelvin(planet)
      if ((target as number) < bounds.min || (target as number) > bounds.max) {
        errors.push(`${label} must be within ${bounds.min}..${bounds.max} K on ${planet}.`)
        return
      }
      targets[channel] = target
      return
    }
    case 'cloudOpacity':
      if (!checkFiniteNumber(target, label, errors)) return
      if ((target as number) < 0 || (target as number) > 1) {
        errors.push(`${label} must be within 0..1.`)
        return
      }
      targets[channel] = target
      return
    default:
      errors.push(`Unknown ${label}. Supported channels: wind, precipitation, dustTau, temperature, cloudOpacity.`)
  }
}

function resolveRange(
  schema: CommandParamSchema,
  planet: PlanetId,
): { min?: number; max?: number } {
  if (schema.range === 'planet_temperature') {
    return temperatureBoundsCelsius(planet)
  }
  if (schema.range === 'planet_temperature_kelvin') {
    return temperatureBoundsKelvin(planet)
  }
  return { min: schema.min, max: schema.max }
}

function defaultCommandId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** Read-only commands never mutate simulation state. */
export function isReadOnlyCommand(command: WorldCommandId): boolean {
  return command === 'get_world_state' || command === 'list_capabilities'
}
