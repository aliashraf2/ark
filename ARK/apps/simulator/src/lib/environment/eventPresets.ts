import { compassToWindVector } from '../physics/environmentalForces'
import type { PlanetId } from '../worlds/PlanetConfig'
import type { StartEventSpec } from './EnvironmentController'

export interface ScenarioPreset {
  id: string
  label: string
  description: string
  planet: PlanetId
  /** Manual settings applied when the scenario starts (cleared first). */
  manual?: {
    windSpeed?: number
    windDirection?: number
    temperatureCelsius?: number
    traction?: number
    wetness?: number
    cloudOpacity?: number
    dustTau?: number
    precipitation?: number
  }
  events: StartEventSpec[]
}

/**
 * Predefined scenarios. Each is declarative data applied through the same
 * typed controller operations as manual UI input — no privileged pathways.
 */
export const SCENARIO_PRESETS: readonly ScenarioPreset[] = Object.freeze([
  {
    id: 'earth-clear',
    label: 'Clear weather',
    description: 'Calm air, clear sky, dry ground.',
    planet: 'earth',
    manual: { windSpeed: 2, windDirection: 270, cloudOpacity: 0.05 },
    events: [],
  },
  {
    id: 'earth-rain',
    label: 'Rainfall',
    description: 'Moderate rain developing over a minute, then clearing.',
    planet: 'earth',
    events: [
      {
        id: 'scenario-rain',
        type: 'rain',
        rampUp: 20,
        hold: 90,
        rampDown: 20,
        priority: 1,
        targets: { precipitation: 12, cloudOpacity: 0.85 },
      },
    ],
  },
  {
    id: 'earth-wind',
    label: 'Strong wind',
    description: 'Sustained 15 m/s westerly with higher gusts via event ramp.',
    planet: 'earth',
    manual: { windSpeed: 9, windDirection: 270 },
    events: [
      {
        id: 'scenario-gale',
        type: 'wind',
        rampUp: 10,
        hold: 120,
        rampDown: 15,
        priority: 1,
        targets: { wind: compassToWindVector(16, 270) },
      },
    ],
  },
  {
    id: 'earth-wet',
    label: 'Wet and slippery',
    description: 'Saturated ground with reduced traction plus light rain.',
    planet: 'earth',
    manual: { wetness: 0.85 },
    events: [
      {
        id: 'scenario-drizzle',
        type: 'rain',
        rampUp: 10,
        hold: 120,
        rampDown: 10,
        priority: 1,
        targets: { precipitation: 3, cloudOpacity: 0.6 },
      },
    ],
  },
  {
    id: 'mars-clear',
    label: 'Clear Martian sky',
    description: 'Calm thin air, full sun.',
    planet: 'mars',
    manual: { windSpeed: 3, windDirection: 180 },
    events: [],
  },
  {
    id: 'mars-light-dust',
    label: 'Light dust',
    description: 'Hazy air with mildly reduced sun.',
    planet: 'mars',
    events: [
      {
        id: 'scenario-haze',
        type: 'dust-storm',
        rampUp: 30,
        hold: 120,
        rampDown: 30,
        priority: 1,
        targets: { dustTau: 0.8, wind: compassToWindVector(10, 200) },
      },
    ],
  },
  {
    id: 'mars-severe-storm',
    label: 'Severe dust storm',
    description: 'Dense dust with strongly reduced sun and visibility.',
    planet: 'mars',
    events: [
      {
        id: 'scenario-storm',
        type: 'dust-storm',
        rampUp: 45,
        hold: 150,
        rampDown: 60,
        priority: 1,
        targets: { dustTau: 2.6, wind: compassToWindVector(22, 200) },
      },
    ],
  },
  {
    id: 'mars-low-solar',
    label: 'Low solar illumination',
    description: 'Persistent dust veil dimming the sun without peak winds.',
    planet: 'mars',
    events: [
      {
        id: 'scenario-veil',
        type: 'dust-storm',
        rampUp: 60,
        hold: 240,
        rampDown: 60,
        priority: 1,
        targets: { dustTau: 1.5, wind: compassToWindVector(6, 160) },
      },
    ],
  },
])

export function scenariosForPlanet(planet: PlanetId): ScenarioPreset[] {
  return SCENARIO_PRESETS.filter((scenario) => scenario.planet === planet)
}

export function getScenario(id: string): ScenarioPreset {
  const scenario = SCENARIO_PRESETS.find((entry) => entry.id === id)
  if (!scenario) throw new Error(`Unknown scenario preset "${id}".`)
  return scenario
}
