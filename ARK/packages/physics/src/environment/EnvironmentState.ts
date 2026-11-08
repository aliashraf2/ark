import type {
  EnvironmentState,
  EnvironmentalEvent,
  EventEnvelope,
  ManualOverrides,
} from '../types/EnvironmentTypes'
import type { Vector3 } from '../types/SimulationTypes'
import type { PlanetConfig } from '../worlds/PlanetConfig'

/** Wetness gain per (mm/h)/20 per second at zero wetness. */
const WETTING_RATE = 0.025
/** Wetness exponential drying rate per second. */
const DRYING_RATE = 0.004
/** Traction loss at full saturation: multiplier = 1 - 0.45 * wetness. */
const WET_TRACTION_LOSS = 0.45
/** Cloud opacity to optical-depth gain (full overcast ~= 0.11 illumination). */
const CLOUD_TAU_GAIN = 2.2
/** Visibility model: visibility = VIS_BASE * exp(-VIS_GAIN * tau), meters. */
const VIS_BASE = 15000
const VIS_GAIN = 1.6
const MIN_VISIBILITY = 30

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Event intensity envelope in 0..1 at a simulation time. Pure and
 * deterministic: smooth ramps up/down with a flat hold, zero outside
 * [startTime + delay, endTime].
 */
export function eventEnvelopeAt(event: EnvironmentalEvent, simTime: number): number {
  const { delay, rampUp, hold, rampDown } = event.envelope
  const t = simTime - event.startTime - Math.max(delay, 0)
  if (t < 0) return 0
  const up = Math.max(rampUp, 0)
  const holdEnd = up + Math.max(hold, 0)
  const end = holdEnd + Math.max(rampDown, 0)
  if (t >= end) return 0
  if (t < up) return smoothstep(0, up, t)
  if (t < holdEnd) return 1
  return 1 - smoothstep(holdEnd, end, t)
}

/** Simulation time when the event envelope reaches zero for good. */
export function eventEndTime(event: EnvironmentalEvent): number {
  const envelope: EventEnvelope = event.envelope
  return (
    event.startTime +
    Math.max(envelope.delay, 0) +
    Math.max(envelope.rampUp, 0) +
    Math.max(envelope.hold, 0) +
    Math.max(envelope.rampDown, 0)
  )
}

export function defaultManualOverrides(): ManualOverrides {
  return {
    wind: null,
    temperature: null,
    precipitation: null,
    cloudOpacity: null,
    dustTau: null,
    traction: 1,
    wetness: null,
    solarMultiplier: null,
  }
}

interface ChannelCandidate<T> {
  value: T
  envelope: number
  priority: number
  startTime: number
  id: string
}

function winningCandidate<T>(candidates: ChannelCandidate<T>[]): ChannelCandidate<T> | null {
  let best: ChannelCandidate<T> | null = null
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.priority > best.priority ||
      (candidate.priority === best.priority && candidate.startTime > best.startTime) ||
      (candidate.priority === best.priority &&
        candidate.startTime === best.startTime &&
        candidate.id < best.id)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Pure environment evaluation. Composition rule (deterministic, documented):
 * manual overrides form the base layer (priority 0); among active events
 * driving a channel, the highest (priority, startTime, id) wins, and the
 * channel blends base -> target by the winner's envelope. Overlapping events
 * therefore resolve in a fully predictable order — never silent last-write.
 */
export function evaluateEnvironment(
  config: PlanetConfig,
  events: EnvironmentalEvent[],
  manual: ManualOverrides,
  wetness: number,
  simTime: number,
): EnvironmentState {
  const planet = config.id
  const baseWind = manual.wind ?? { x: 0, y: 0, z: 0 }
  const baseTemperature = manual.temperature ?? config.temperature.baseline
  const basePrecipitation = manual.precipitation ?? 0
  const baseCloud = manual.cloudOpacity ?? 0
  const baseDust = manual.dustTau ?? 0

  const windCandidates: ChannelCandidate<Vector3>[] = []
  const scalarTargets: Record<string, ChannelCandidate<number>[]> = {
    temperature: [],
    precipitation: [],
    cloud: [],
    dust: [],
  }
  const activeEventIds: string[] = []

  for (const event of events) {
    if (!event.planets.includes(planet)) continue
    const envelope = eventEnvelopeAt(event, simTime)
    if (envelope <= 0) continue
    activeEventIds.push(event.id)
    const { targets } = event
    if (targets.wind) {
      windCandidates.push({
        value: targets.wind,
        envelope,
        priority: event.priority,
        startTime: event.startTime,
        id: event.id,
      })
    }
    const scalarEntries: Array<[string, number | undefined]> = [
      ['temperature', targets.temperature],
      ['precipitation', targets.precipitation],
      ['cloud', targets.cloudOpacity],
      ['dust', targets.dustTau],
    ]
    for (const [channel, target] of scalarEntries) {
      if (target === undefined) continue
      scalarTargets[channel]?.push({
        value: target,
        envelope,
        priority: event.priority,
        startTime: event.startTime,
        id: event.id,
      })
    }
  }

  const windWinner = winningCandidate(windCandidates)
  const wind = windWinner
    ? blendVector(baseWind, windWinner.value, windWinner.envelope)
    : { ...baseWind }
  const blendScalar = (base: number, channel: string): number => {
    const winner = winningCandidate(scalarTargets[channel] ?? [])
    return winner ? base + (winner.value - base) * winner.envelope : base
  }

  const temperature = blendScalar(baseTemperature, 'temperature')
  const precipitation = Math.max(blendScalar(basePrecipitation, 'precipitation'), 0)
  const cloudOpacity = clamp01(blendScalar(baseCloud, 'cloud'))
  const dustTau = Math.max(blendScalar(baseDust, 'dust'), 0)

  const tractionMultiplier = (1 - WET_TRACTION_LOSS * clamp01(wetness)) * manual.traction
  const opticalDepth = cloudOpacity * CLOUD_TAU_GAIN + dustTau
  const manualSolar = manual.solarMultiplier ?? 1
  const solarMultiplier = Math.exp(-opticalDepth) * manualSolar
  const solarIrradiance = config.solarConstantWm2 * solarMultiplier
  const visibility = Math.max(VIS_BASE * Math.exp(-VIS_GAIN * opticalDepth), MIN_VISIBILITY)

  return {
    planet,
    simTime,
    airDensity: config.atmosphere.density,
    pressure: config.atmosphere.pressure,
    wind,
    temperature,
    precipitation,
    cloudOpacity,
    dustTau,
    wetness: clamp01(wetness),
    tractionMultiplier,
    solarMultiplier,
    solarIrradiance,
    visibility,
    aeroEnabled: true,
    activeEventIds: activeEventIds.sort(),
  }
}

/**
 * Pure wetness integration over one step: rain wets toward saturation,
 * dry air dries exponentially. Bounded in 0..1. Documented approximation —
 * not a validated hydrological model.
 */
export function integrateWetness(wetness: number, precipitationMmH: number, dtSeconds: number): number {
  const w = clamp01(Number.isFinite(wetness) ? wetness : 0)
  const precip = Number.isFinite(precipitationMmH) && precipitationMmH > 0 ? precipitationMmH : 0
  const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0
  if (dt === 0) return w
  const wetting = (precip / 20) * WETTING_RATE * (1 - w)
  const drying = DRYING_RATE * w
  return clamp01(w + (wetting - drying) * dt)
}

function blendVector(base: Vector3, target: Vector3, envelope: number): Vector3 {
  return {
    x: base.x + (target.x - base.x) * envelope,
    y: base.y + (target.y - base.y) * envelope,
    z: base.z + (target.z - base.z) * envelope,
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}
