import { EARTH_CONFIG } from './earth'
import { MARS_CONFIG } from './mars'
import type { PlanetConfig, PlanetId, TerrainGenParams } from './PlanetConfig'

/** Registry of known worlds. Look up by id; extend by adding a config. */
export const PLANETS: Record<PlanetId, PlanetConfig> = {
  earth: EARTH_CONFIG,
  mars: MARS_CONFIG,
}

export function getPlanet(id: PlanetId): PlanetConfig {
  return PLANETS[id]
}

/**
 * Predefined terrain profile: a named, planet-scoped override of the default
 * generation parameters. Pure data; resolution is shared by all profiles.
 */
export interface TerrainProfile {
  id: string
  label: string
  planet: PlanetId
  overrides: Partial<TerrainGenParams>
}

export const TERRAIN_PROFILES: readonly TerrainProfile[] = Object.freeze([
  { id: 'rolling-hills', label: 'Rolling Hills', planet: 'earth', overrides: {} },
  {
    id: 'plains',
    label: 'Plains',
    planet: 'earth',
    overrides: { amplitude: 5, roughness: 0.05, noiseScale: 0.01 },
  },
  {
    id: 'highlands',
    label: 'Highlands',
    planet: 'earth',
    overrides: { amplitude: 22, roughness: 0.45, noiseScale: 0.02 },
  },
  { id: 'cratered-plains', label: 'Cratered Plains', planet: 'mars', overrides: {} },
  {
    id: 'rugged-highlands',
    label: 'Rugged Highlands',
    planet: 'mars',
    overrides: { amplitude: 14, roughness: 0.85, craterCount: 5 },
  },
  {
    id: 'smooth-basin',
    label: 'Smooth Basin',
    planet: 'mars',
    overrides: { amplitude: 4, roughness: 0.3, craterCount: 14, craterMaxRadius: 12 },
  },
])

export function profilesForPlanet(id: PlanetId): TerrainProfile[] {
  return TERRAIN_PROFILES.filter((profile) => profile.planet === id)
}

export function defaultProfileForPlanet(id: PlanetId): TerrainProfile {
  const first = profilesForPlanet(id)[0]
  if (!first) throw new Error(`No terrain profiles defined for planet "${id}".`)
  return first
}

/** Pure merge of a planet's base terrain params with a profile's overrides. */
export function resolveTerrainParams(
  config: PlanetConfig,
  profileId: string = defaultProfileForPlanet(config.id).id,
): TerrainGenParams {
  const profile = profilesForPlanet(config.id).find((entry) => entry.id === profileId)
  if (!profile) throw new Error(`Unknown terrain profile "${profileId}" for planet "${config.id}".`)
  return { ...config.terrain, ...profile.overrides }
}
