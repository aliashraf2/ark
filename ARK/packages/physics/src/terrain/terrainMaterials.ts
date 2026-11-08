import type { SurfaceRule, SurfaceType } from '../worlds/PlanetConfig'
import { SURFACE_MATERIALS } from '../physics/PhysicalMaterials'
import type { Heightfield } from './generateHeightfield'
import { createSeededNoise2D, fractalNoise2D, type Noise2D } from './terrainNoise'
import { getTerrainSlope } from './terrainSampling'

/**
 * General classifier: first rule whose constraints all hold wins. Planet
 * differences come purely from the rule data, never from branched code.
 */
export function classifySurface(
  height: number,
  slope: number,
  rules: SurfaceRule[],
): SurfaceType {
  for (const rule of rules) {
    if (rule.minSlope !== undefined && slope < rule.minSlope) continue
    if (rule.maxSlope !== undefined && slope > rule.maxSlope) continue
    if (rule.minHeight !== undefined && height < rule.minHeight) continue
    if (rule.maxHeight !== undefined && height > rule.maxHeight) continue
    return rule.material
  }
  // Unreachable when the last rule is a fallthrough (enforced by validation).
  return rules[rules.length - 1]?.material ?? 'rock'
}

/** RGB vertex color, each channel in 0..1. */
export type VertexColor = [number, number, number]

export interface TerrainColorFn {
  (x: number, z: number, height: number): VertexColor
}

/**
 * Builds the deterministic per-vertex color function: rule classification plus
 * seeded mottling (two noise octaves, +/-8%) so surfaces read as natural
 * ground rather than flat fills. Pure closure over (heightfield, rules, seed).
 */
export function makeTerrainColorFn(
  heightfield: Heightfield,
  rules: SurfaceRule[],
  seed: number,
): TerrainColorFn {
  const mottle: Noise2D = createSeededNoise2D((seed ^ 0x51ed2707) >>> 0)
  return (x: number, z: number, height: number): VertexColor => {
    const slope = getTerrainSlope(heightfield, x, z)
    const material = SURFACE_MATERIALS[classifySurface(height, slope, rules)]
    const variation = 1 + fractalNoise2D(mottle, x * 0.08, z * 0.08, 2) * 0.08
    return [
      material.color[0] * variation,
      material.color[1] * variation,
      material.color[2] * variation,
    ]
  }
}
