import type { PlanetId } from '../worlds/PlanetConfig'
import type { Vector3 } from './SimulationTypes'

/**
 * Complete dynamic environment state. SI units unless noted; dimensionless
 * fields document their range and meaning. Evaluated on the shared simulation
 * clock — there is no separate environment clock.
 */
export interface EnvironmentState {
  planet: PlanetId
  /** Simulation time in seconds (same clock as physics). */
  simTime: number
  /** Air density in kg/m^3 (planet reference value in M3). */
  airDensity: number
  /** Atmospheric pressure in Pa (planet reference value in M3). */
  pressure: number
  /** Air velocity in world frame, m/s. Positive components point along +X/+Y/+Z. */
  wind: Vector3
  /** Ambient temperature in Kelvin. Displayed as C; no physics coupling in M3. */
  temperature: number
  /** Precipitation intensity in mm/h. 0 = dry; ~2.5 light rain; ~25 heavy rain. */
  precipitation: number
  /** Cloud opacity 0..1 (Earth). 0 = clear sky, 1 = full overcast. */
  cloudOpacity: number
  /** Dust optical depth tau >= 0 (Mars). 0 = clear; ~2.5 severe storm. */
  dustTau: number
  /** Surface wetness 0..1. 0 = dry, 1 = saturated. Bounded state variable. */
  wetness: number
  /**
   * Traction multiplier (derived): (1 - 0.45 * wetness) * manualTraction.
   * Multiplies the terrain's base friction. Documented approximation, not a
   * validated soil-mechanics model.
   */
  tractionMultiplier: number
  /** Relative solar illumination 0..1 (derived): exp(-opticalDepth). */
  solarMultiplier: number
  /** Estimated solar irradiance in W/m^2 (derived): solarConstant * multiplier. */
  solarIrradiance: number
  /** Visibility distance in meters (derived approximation). */
  visibility: number
  /** Master switch for aerodynamic forces on registered bodies. */
  aeroEnabled: boolean
  /** IDs of events with nonzero envelope at this sim time. */
  activeEventIds: string[]
}

/** JSON-safe subset of EnvironmentState published to the UI at telemetry rate. */
export type EnvironmentSnapshot = Readonly<EnvironmentState>

export type EventType = 'rain' | 'wind' | 'dust-storm' | 'temperature' | 'cloud'

/** Envelope phases in seconds. All >= 0. */
export interface EventEnvelope {
  /** Delay after startTime before onset begins. */
  delay: number
  /** Smooth ramp from 0 to peak intensity. */
  rampUp: number
  /** Hold at peak intensity. */
  hold: number
  /** Smooth ramp from peak back to 0. */
  rampDown: number
}

export interface EventTargets {
  wind?: Vector3
  precipitation?: number
  dustTau?: number
  temperature?: number
  cloudOpacity?: number
}

export interface EnvironmentalEvent {
  id: string
  type: EventType
  /** Planets this event may run on. Enforced at start. */
  planets: PlanetId[]
  /** Simulation time in seconds when the envelope timeline begins. */
  startTime: number
  envelope: EventEnvelope
  /**
   * Composition priority. When several active events drive the same channel,
   * the highest priority wins; ties break by later startTime, then by id.
   */
  priority: number
  targets: EventTargets
}

export interface ManualOverrides {
  wind: Vector3 | null
  temperature: number | null
  precipitation: number | null
  cloudOpacity: number | null
  dustTau: number | null
  /** Manual traction factor, default 1. */
  traction: number
  /** Direct wetness set by operations (null = purely integrated). */
  wetness: number | null
  /** Manual solar multiplier 0..1 (null = unmodified derived attenuation). */
  solarMultiplier: number | null
}

export type EnvironmentErrorCode =
  | 'INVALID_VALUE'
  | 'OUT_OF_RANGE'
  | 'INCOMPATIBLE_PLANET'
  | 'UNKNOWN_EVENT_TYPE'
  | 'DUPLICATE_EVENT_ID'
  | 'EVENT_LIMIT'

export class EnvironmentError extends Error {
  public readonly code: EnvironmentErrorCode

  constructor(code: EnvironmentErrorCode, message: string) {
    super(message)
    this.name = 'EnvironmentError'
    this.code = code
  }
}
