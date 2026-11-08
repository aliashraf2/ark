import type { SurfaceRule, SurfaceType } from '../worlds/PlanetConfig'
import { SURFACE_MATERIALS } from '../physics/PhysicalMaterials'
import type { Heightfield } from '../terrain/generateHeightfield'
import { classifySurface } from '../terrain/terrainMaterials'
import { getTerrainHeight, getTerrainSlope } from '../terrain/terrainSampling'

export interface SurfaceSample {
  type: SurfaceType
  label: string
  /** Registry friction for this surface (informational in Milestone 2). */
  friction: number
}

/**
 * Surface lookup at a world position. Pure: same heightfield + rules + point
 * always yields the same surface. Powers terrain coloring (per-vertex) and the
 * "surface under sphere" telemetry readout.
 */
export function surfaceAt(
  heightfield: Heightfield,
  rules: SurfaceRule[],
  x: number,
  z: number,
): SurfaceSample {
  const height = getTerrainHeight(heightfield, x, z)
  const slope = getTerrainSlope(heightfield, x, z)
  const type = classifySurface(height, slope, rules)
  const material = SURFACE_MATERIALS[type]
  return { type, label: material.label, friction: material.friction }
}
