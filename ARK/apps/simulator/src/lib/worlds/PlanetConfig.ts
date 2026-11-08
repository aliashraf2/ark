import type { Vector3 } from '../types/SimulationTypes'

/** Supported planetary environments. New worlds are added by supplying a config, not new engine code. */
export type PlanetId = 'earth' | 'mars'

/**
 * Representative atmospheric values. These are approximations for a reference
 * location — they do not apply at all altitudes, and Milestone 2 implements no
 * aerodynamic forces: changing them does not affect object motion.
 */
export interface AtmosphereParams {
  /** Representative air density in kg/m^3. */
  density: number
  /** Representative pressure in Pa. */
  pressure: number
  /** Human-readable qualifier, e.g. "sea-level reference". */
  reference: string
}

export interface TerrainGenParams {
  /** Patch width along X in meters. */
  width: number
  /** Patch depth along Z in meters. */
  depth: number
  /** Grid cells per side; samples per side = subdivisions + 1. */
  subdivisions: number
  /** Height scale in meters; relief spans roughly +/- amplitude around baseHeight. */
  amplitude: number
  /** Mean terrain elevation in meters. */
  baseHeight: number
  /** Noise frequency in features per meter (larger = smaller features). */
  noiseScale: number
  /** Fractal octaves, >= 1. */
  octaves: number
  /** 0 = smooth fBm hills, 1 = fully ridged/rugged. Range 0..1. */
  roughness: number
  /** Number of deterministic impact craters carved into the heightfield. */
  craterCount: number
  /** Crater radius range in meters. */
  craterMinRadius: number
  craterMaxRadius: number
  /** Crater bowl depth as a fraction of its radius. */
  craterDepthScale: number
}

export type SurfaceType = 'grass' | 'soil' | 'sand' | 'rock' | 'regolith'

/**
 * Data-driven classification rule. Rules are evaluated in order; the first
 * rule whose constraints all hold wins. The last rule should be a fallthrough
 * (no constraints). Slope is rise-over-run magnitude; height is in meters.
 */
export interface SurfaceRule {
  material: SurfaceType
  minSlope?: number
  maxSlope?: number
  minHeight?: number
  maxHeight?: number
}

export interface LightingParams {
  sunColor: number
  sunIntensity: number
  /** Directional light position in meters (relative to world origin). */
  sunPosition: Vector3
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  background: number
  fogColor: number
  /** Fog range in meters. */
  fogNear: number
  fogFar: number
  /** Half-size of the shadow camera ortho box in meters. */
  shadowExtent: number
}

export interface CameraParams {
  /** Camera position relative to the framed terrain target, in meters. */
  offset: Vector3
  /** Target height above the local terrain surface in meters. */
  targetHeight: number
  minDistance: number
  maxDistance: number
  /** Maximum polar angle in radians; keeps the camera above the terrain. */
  maxPolarAngle: number
}

export interface PlanetConfig {
  id: PlanetId
  displayName: string
  /** Gravitational acceleration magnitude in m/s^2. */
  gravity: number
  atmosphere: AtmosphereParams
  terrain: TerrainGenParams
  surfaceRules: SurfaceRule[]
  /**
   * DOCUMENTED LIMITATION (Milestone 2): Rapier heightfield colliders carry a
   * single friction coefficient, so per-surface friction cannot be physically
   * resolved per contact. This uniform value applies to the whole terrain;
   * the per-surface friction data model is retained for future zoned colliders.
   */
  terrainFriction: number
  terrainRestitution: number
  lighting: LightingParams
  camera: CameraParams
  defaultSeed: number
  description: string
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    const record = value as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) {
      deepFreeze(record[key])
    }
    Object.freeze(value)
  }
  return value
}

/** Builds an immutable planet configuration. Configs are frozen after creation. */
export function definePlanet(config: PlanetConfig): PlanetConfig {
  return deepFreeze({ ...config })
}

/** Pure validation: returns a list of problems (empty = valid). All units SI. */
export function validatePlanetConfig(config: PlanetConfig): string[] {
  const errors: string[] = []
  const t = config.terrain

  if (!(config.gravity > 0)) errors.push('gravity must be positive')
  if (!(config.atmosphere.density >= 0)) errors.push('atmospheric density must be non-negative')
  if (!(config.atmosphere.pressure >= 0)) errors.push('atmospheric pressure must be non-negative')
  if (!(t.width > 0)) errors.push('terrain width must be positive')
  if (!(t.depth > 0)) errors.push('terrain depth must be positive')
  if (!Number.isInteger(t.subdivisions) || t.subdivisions < 8) {
    errors.push('terrain subdivisions must be an integer >= 8')
  }
  if (!(t.amplitude >= 0)) errors.push('terrain amplitude must be non-negative')
  if (!(t.noiseScale > 0)) errors.push('noise scale must be positive')
  if (!Number.isInteger(t.octaves) || t.octaves < 1) errors.push('octaves must be an integer >= 1')
  if (!(t.roughness >= 0 && t.roughness <= 1)) errors.push('roughness must be in 0..1')
  if (!Number.isInteger(t.craterCount) || t.craterCount < 0) {
    errors.push('crater count must be a non-negative integer')
  }
  if (t.craterCount > 0) {
    if (!(t.craterMinRadius > 0)) errors.push('crater min radius must be positive')
    if (!(t.craterMaxRadius >= t.craterMinRadius)) {
      errors.push('crater max radius must be >= min radius')
    }
    if (!(t.craterDepthScale > 0)) errors.push('crater depth scale must be positive')
  }
  if (!(config.terrainFriction >= 0)) errors.push('terrain friction must be non-negative')
  if (!(config.terrainRestitution >= 0 && config.terrainRestitution <= 1)) {
    errors.push('terrain restitution must be in 0..1')
  }
  if (!(config.lighting.fogFar > config.lighting.fogNear)) {
    errors.push('fog far must exceed fog near')
  }
  if (!(config.lighting.shadowExtent > 0)) errors.push('shadow extent must be positive')
  if (!(config.camera.maxDistance > config.camera.minDistance)) {
    errors.push('camera max distance must exceed min distance')
  }
  if (config.surfaceRules.length === 0) errors.push('at least one surface rule is required')
  const last = config.surfaceRules[config.surfaceRules.length - 1]
  if (
    last !== undefined &&
    (last.minSlope !== undefined ||
      last.maxSlope !== undefined ||
      last.minHeight !== undefined ||
      last.maxHeight !== undefined)
  ) {
    errors.push('the last surface rule must be an unconstrained fallthrough')
  }

  return errors
}
