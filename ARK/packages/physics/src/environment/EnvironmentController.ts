import { compassToWindVector, MAX_WIND_SPEED } from '../physics/environmentalForces'
import type {
  EnvironmentSnapshot,
  EnvironmentState,
  EnvironmentalEvent,
  EventType,
  ManualOverrides,
} from '../types/EnvironmentTypes'
import { EnvironmentError } from '../types/EnvironmentTypes'
import type { Vector3 } from '../types/SimulationTypes'
import type { PlanetConfig } from '../worlds/PlanetConfig'
import {
  defaultManualOverrides,
  evaluateEnvironment,
  eventEndTime,
  integrateWetness,
} from './EnvironmentState'

/** Maximum simultaneous events; bounds per-step evaluation cost. */
export const MAX_ACTIVE_EVENTS = 32

const EVENT_PLANETS: Record<EventType, PlanetConfig['id'][]> = {
  rain: ['earth'],
  cloud: ['earth'],
  'dust-storm': ['mars'],
  wind: ['earth', 'mars'],
  temperature: ['earth', 'mars'],
}

export interface StartEventSpec {
  id?: string
  type: EventType
  /** Simulation time when the envelope starts. Defaults to the controller's current time. */
  startTime?: number
  delay?: number
  rampUp?: number
  hold?: number
  rampDown?: number
  priority?: number
  targets: EnvironmentalEvent['targets']
}

export interface CapabilityDescriptor {
  name: string
  description: string
  planets: PlanetConfig['id'][]
}

/**
 * Stateful environment operator: owns the event schedule, manual overrides,
 * and integrated accumulators (wetness) for the active planet. All operations
 * are typed, validated take-planet-into-account commands returning fresh state
 * snapshots — the future CSP surface. Numerical evaluation itself is pure
 * (EnvironmentState.ts); this class only holds the inputs.
 */
export class EnvironmentController {
  private config: PlanetConfig
  private events: EnvironmentalEvent[] = []
  private manual: ManualOverrides = defaultManualOverrides()
  private wetness = 0
  private aeroEnabled = true
  private simTime = 0
  private nextAutoId = 1
  private lastState: EnvironmentState

  constructor(config: PlanetConfig) {
    this.config = config
    this.lastState = this.evaluate(0)
  }

  /** Switches the active planet: clears events/overrides and restores base. */
  public resetForPlanet(config: PlanetConfig): EnvironmentSnapshot {
    this.config = config
    return this.reset()
  }

  /** Clears events, overrides, and accumulators; restores the planet base. */
  public reset(): EnvironmentSnapshot {
    this.events = []
    this.manual = defaultManualOverrides()
    this.wetness = 0
    this.aeroEnabled = true
    this.simTime = 0
    this.lastState = this.evaluate(0)
    return this.snapshot()
  }

  /**
   * Advances environment state to a simulation time over a step dt. Called once
   * per fixed physics step with the shared clock — never while paused, so
   * pausing freezes events and wetness automatically. Prunes completed events.
   */
  public update(simTime: number, dt: number): EnvironmentSnapshot {
    if (!Number.isFinite(simTime) || !Number.isFinite(dt) || dt < 0) {
      throw new EnvironmentError('INVALID_VALUE', 'simTime and dt must be finite with dt >= 0.')
    }
    this.events = this.events.filter((event) => eventEndTime(event) >= simTime)
    const evaluated = this.evaluate(simTime)
    const base = this.manual.wetness ?? this.wetness
    this.wetness = integrateWetness(base, evaluated.precipitation, dt)
    // Manual wetness is a one-shot set: integration takes over from there.
    this.manual.wetness = null
    this.simTime = simTime
    this.lastState = this.evaluate(simTime)
    this.lastState.wetness = this.wetness
    this.lastState.tractionMultiplier =
      (1 - 0.45 * this.wetness) * this.manual.traction
    return this.snapshot()
  }

  /**
   * Moves the controller's time cursor without clearing events (used when the
   * simulation clock resets for a fresh drop: surviving events replay from t=0).
   */
  public snapToTime(simTime: number): EnvironmentSnapshot {
    if (!Number.isFinite(simTime)) {
      throw new EnvironmentError('INVALID_VALUE', 'simTime must be finite.')
    }
    this.simTime = Math.max(simTime, 0)
    return this.refresh()
  }

  public getState(): EnvironmentSnapshot {
    return this.snapshot()
  }

  public setWindVector(wind: Vector3): EnvironmentSnapshot {
    this.requireFiniteVector(wind, 'wind')
    const speed = Math.hypot(wind.x, wind.y, wind.z)
    const clamped =
      speed > MAX_WIND_SPEED
        ? { x: (wind.x / speed) * MAX_WIND_SPEED, y: (wind.y / speed) * MAX_WIND_SPEED, z: (wind.z / speed) * MAX_WIND_SPEED }
        : { ...wind }
    this.manual.wind = clamped
    return this.refresh()
  }

  public setWind(speedMps: number, directionFromDeg: number): EnvironmentSnapshot {
    this.requireFinite(speedMps, 'wind speed')
    this.requireFinite(directionFromDeg, 'wind direction')
    this.manual.wind = compassToWindVector(speedMps, directionFromDeg)
    return this.refresh()
  }

  public setTemperatureCelsius(celsius: number): EnvironmentSnapshot {
    this.requireFinite(celsius, 'temperature')
    const kelvin = celsius + 273.15
    const bounds = this.config.temperature
    this.manual.temperature = Math.min(Math.max(kelvin, bounds.min), bounds.max)
    return this.refresh()
  }

  public setTractionMultiplier(multiplier: number): EnvironmentSnapshot {
    this.requireFinite(multiplier, 'traction multiplier')
    this.manual.traction = Math.min(Math.max(multiplier, 0.2), 1.5)
    return this.refresh()
  }

  public setSurfaceWetness(wetness: number): EnvironmentSnapshot {
    this.requireFinite(wetness, 'wetness')
    const clamped = Math.min(Math.max(wetness, 0), 1)
    this.manual.wetness = clamped
    this.wetness = clamped
    return this.refresh()
  }

  public setCloudOpacity(opacity: number): EnvironmentSnapshot {
    this.requireFinite(opacity, 'cloud opacity')
    this.manual.cloudOpacity = Math.min(Math.max(opacity, 0), 1)
    return this.refresh()
  }

  public setDustTau(tau: number): EnvironmentSnapshot {
    this.requireFinite(tau, 'dust optical depth')
    this.manual.dustTau = Math.min(Math.max(tau, 0), 5)
    return this.refresh()
  }

  public setPrecipitation(precipitationMmH: number): EnvironmentSnapshot {
    this.requireFinite(precipitationMmH, 'precipitation')
    this.manual.precipitation = Math.min(Math.max(precipitationMmH, 0), 100)
    return this.refresh()
  }

  public setAeroEnabled(enabled: boolean): EnvironmentSnapshot {
    this.aeroEnabled = enabled
    return this.refresh()
  }

  public setSolarMultiplier(multiplier: number): EnvironmentSnapshot {
    this.requireFinite(multiplier, 'solar multiplier')
    this.manual.solarMultiplier = Math.min(Math.max(multiplier, 0), 1)
    return this.refresh()
  }

  public startEvent(spec: StartEventSpec): EnvironmentSnapshot {
    const allowed = EVENT_PLANETS[spec.type]
    if (!allowed) {
      throw new EnvironmentError('UNKNOWN_EVENT_TYPE', `Unknown event type: ${String(spec.type)}.`)
    }
    if (!allowed.includes(this.config.id)) {
      throw new EnvironmentError(
        'INCOMPATIBLE_PLANET',
        `Event type "${spec.type}" cannot run on ${this.config.displayName}.`,
      )
    }
    if (this.events.length >= MAX_ACTIVE_EVENTS) {
      throw new EnvironmentError('EVENT_LIMIT', `At most ${MAX_ACTIVE_EVENTS} events may be active.`)
    }
    const id = spec.id ?? `${spec.type}-${this.nextAutoId++}`
    if (this.events.some((event) => event.id === id)) {
      throw new EnvironmentError('DUPLICATE_EVENT_ID', `An event with id "${id}" already exists.`)
    }
    const startTime = spec.startTime ?? this.simTime
    this.requireFinite(startTime, 'startTime')
    const envelope = {
      delay: this.requireNonNegative(spec.delay ?? 0, 'delay'),
      rampUp: this.requireNonNegative(spec.rampUp ?? 5, 'rampUp'),
      hold: this.requireNonNegative(spec.hold ?? 30, 'hold'),
      rampDown: this.requireNonNegative(spec.rampDown ?? 5, 'rampDown'),
    }
    const priority = Number.isFinite(spec.priority ?? 1) ? (spec.priority ?? 1) : 1
    this.validateTargets(spec.type, spec.targets)
    this.events.push({
      id,
      type: spec.type,
      planets: [...allowed],
      startTime,
      envelope,
      priority,
      targets: { ...spec.targets },
    })
    return this.refresh()
  }

  /** Removes an event by id. Returns true when an event was actually removed. */
  public stopEvent(id: string): boolean {
    const before = this.events.length
    this.events = this.events.filter((event) => event.id !== id)
    if (this.events.length !== before) this.refresh()
    return this.events.length !== before
  }

  public clearEvents(): EnvironmentSnapshot {
    this.events = []
    return this.refresh()
  }

  public listCapabilities(): CapabilityDescriptor[] {
    return [
      { name: 'setWind', description: 'Set manual wind by speed (m/s) and compass direction.', planets: ['earth', 'mars'] },
      { name: 'setTemperature', description: 'Set ambient temperature in Celsius (planet-bounded).', planets: ['earth', 'mars'] },
      { name: 'setTraction', description: 'Set manual surface traction multiplier (0.2..1.5).', planets: ['earth', 'mars'] },
      { name: 'setWetness', description: 'Set surface wetness directly (0..1).', planets: ['earth', 'mars'] },
      { name: 'setCloud', description: 'Set manual cloud opacity (0..1).', planets: ['earth'] },
      { name: 'setDust', description: 'Set manual dust optical depth (0..5).', planets: ['mars'] },
      { name: 'setPrecipitation', description: 'Set manual precipitation (mm/h).', planets: ['earth'] },
      { name: 'setSolarMultiplier', description: 'Set manual solar multiplier 0..1 (experimental shade).', planets: ['earth', 'mars'] },
      { name: 'setAero', description: 'Enable or disable aerodynamic forces.', planets: ['earth', 'mars'] },
      { name: 'startEvent', description: 'Start a scheduled weather event (rain, wind, dust-storm, temperature, cloud).', planets: ['earth', 'mars'] },
      { name: 'stopEvent', description: 'Cancel a running event by id.', planets: ['earth', 'mars'] },
      { name: 'resetEnvironment', description: 'Clear events and restore planet base conditions.', planets: ['earth', 'mars'] },
    ]
  }

  private evaluate(simTime: number): EnvironmentState {
    const state = evaluateEnvironment(this.config, this.events, this.manual, this.wetness, simTime)
    return { ...state, aeroEnabled: this.aeroEnabled }
  }

  private refresh(): EnvironmentSnapshot {
    this.lastState = this.evaluate(this.simTime)
    return this.snapshot()
  }

  private snapshot(): EnvironmentSnapshot {
    return {
      ...this.lastState,
      wind: { ...this.lastState.wind },
      activeEventIds: [...this.lastState.activeEventIds],
    }
  }

  private validateTargets(type: EventType, targets: EnvironmentalEvent['targets']): void {
    if (targets.wind !== undefined) this.requireFiniteVector(targets.wind, 'wind target')
    const scalars: Array<[string, number | undefined, number, number]> = [
      ['precipitation', targets.precipitation, 0, 100],
      ['dustTau', targets.dustTau, 0, 5],
      ['temperature', targets.temperature, this.config.temperature.min, this.config.temperature.max],
      ['cloudOpacity', targets.cloudOpacity, 0, 1],
    ]
    for (const [name, value, min, max] of scalars) {
      if (value === undefined) continue
      this.requireFinite(value, `${type} target ${name}`)
      if (value < min || value > max) {
        throw new EnvironmentError(
          'OUT_OF_RANGE',
          `${type} target ${name}=${value} is outside [${min}, ${max}].`,
        )
      }
    }
    if (Object.keys(targets).length === 0) {
      throw new EnvironmentError('INVALID_VALUE', `Event type "${type}" needs at least one target.`)
    }
  }

  private requireFinite(value: number, name: string): void {
    if (!Number.isFinite(value)) {
      throw new EnvironmentError('INVALID_VALUE', `${name} must be a finite number.`)
    }
  }

  private requireNonNegative(value: number, name: string): number {
    this.requireFinite(value, name)
    if (value < 0) {
      throw new EnvironmentError('OUT_OF_RANGE', `${name} must be >= 0.`)
    }
    return value
  }

  private requireFiniteVector(vector: Vector3, name: string): void {
    if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
      throw new EnvironmentError('INVALID_VALUE', `${name} must have finite x/y/z components.`)
    }
  }
}
