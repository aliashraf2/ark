import type { SurfaceType } from '../worlds/PlanetConfig'

export interface SurfaceMaterialDef {
  label: string
  /** Base sRGB color as [r, g, b] in 0..1. */
  color: [number, number, number]
  roughness: number
  /**
   * Data-model friction per surface. Milestone 2 physics applies one uniform
   * terrain friction per world (see PlanetConfig.terrainFriction); these values
   * drive the telemetry readout and future zoned colliders, not current contacts.
   */
  friction: number
  restitution: number
}

/** Shared material registry: one definition per surface type, all planets. */
export const SURFACE_MATERIALS: Record<SurfaceType, SurfaceMaterialDef> = {
  grass: {
    label: 'Grass',
    color: [0.26, 0.5, 0.22],
    roughness: 0.95,
    friction: 0.9,
    restitution: 0.1,
  },
  soil: {
    label: 'Soil',
    color: [0.4, 0.28, 0.18],
    roughness: 0.97,
    friction: 0.8,
    restitution: 0.15,
  },
  sand: {
    label: 'Sand',
    color: [0.8, 0.69, 0.47],
    roughness: 0.9,
    friction: 0.6,
    restitution: 0.2,
  },
  rock: {
    label: 'Rock',
    color: [0.44, 0.43, 0.41],
    roughness: 0.85,
    friction: 0.7,
    restitution: 0.3,
  },
  regolith: {
    label: 'Regolith',
    color: [0.6, 0.29, 0.16],
    roughness: 0.96,
    friction: 0.65,
    restitution: 0.2,
  },
}

for (const key of Object.keys(SURFACE_MATERIALS) as SurfaceType[]) {
  Object.freeze(SURFACE_MATERIALS[key].color)
  Object.freeze(SURFACE_MATERIALS[key])
}
Object.freeze(SURFACE_MATERIALS)
