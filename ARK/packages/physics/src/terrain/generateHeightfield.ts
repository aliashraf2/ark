import type { TerrainGenParams } from '../worlds/PlanetConfig'
import { createSeededNoise2D, fractalNoise2D, mulberry32, ridgedNoise2D } from './terrainNoise'

/**
 * Shared heightfield model consumed by the renderer, the physics collider,
 * and the sampling utility — one source of height truth.
 *
 * COORDINATE CONVENTION (meters, 1 unit = 1 m):
 * - X: horizontal, Z: horizontal, Y: vertical (up).
 * - Samples are row-major: heights[row * ncols + col].
 * - Sample (row, col) sits at x = (col / (ncols - 1) - 0.5) * width,
 *   z = (row / (nrows - 1) - 0.5) * depth. The patch is centered on the origin.
 */
export interface Heightfield {
  readonly nrows: number
  readonly ncols: number
  readonly width: number
  readonly depth: number
  readonly heights: Float32Array
}

export interface Crater {
  /** Center in meters, patch-local coordinates. */
  x: number
  z: number
  /** Rim radius in meters. */
  radius: number
  /** Bowl depth in meters. */
  depth: number
}

/** Deterministic crater placement derived purely from the world seed. */
export function deriveCraters(params: TerrainGenParams, seed: number): Crater[] {
  const random = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const margin = params.craterMaxRadius + 2
  const craters: Crater[] = []
  for (let i = 0; i < params.craterCount; i += 1) {
    const radius =
      params.craterMinRadius + random() * (params.craterMaxRadius - params.craterMinRadius)
    craters.push({
      x: (random() * 2 - 1) * (params.width / 2 - margin),
      z: (random() * 2 - 1) * (params.depth / 2 - margin),
      radius,
      depth: radius * params.craterDepthScale,
    })
  }
  return craters
}

/**
 * Generates a deterministic heightfield. Pure: identical params + seed always
 * produce identical heights. No Math.random, no I/O, no cached state.
 *
 * Relief = smooth fBm blended toward ridged noise by `roughness`, with
 * optional crater bowls (cosine profile) plus raised rims (gaussian ring).
 */
export function generateHeightfield(params: TerrainGenParams, seed: number): Heightfield {
  const ncols = params.subdivisions + 1
  const nrows = params.subdivisions + 1
  const heights = new Float32Array(nrows * ncols)
  const noise = createSeededNoise2D(seed)
  const cellX = params.width / params.subdivisions
  const cellZ = params.depth / params.subdivisions

  for (let row = 0; row < nrows; row += 1) {
    const z = -params.depth / 2 + row * cellZ
    for (let col = 0; col < ncols; col += 1) {
      const x = -params.width / 2 + col * cellX
      const nx = x * params.noiseScale
      const nz = z * params.noiseScale
      const smooth = fractalNoise2D(noise, nx, nz, params.octaves)
      const ridged = ridgedNoise2D(noise, nx + 13.7, nz - 7.3, params.octaves) * 2 - 1
      const mixed = smooth * (1 - params.roughness) + ridged * params.roughness
      heights[row * ncols + col] = params.baseHeight + params.amplitude * mixed
    }
  }

  for (const crater of deriveCraters(params, seed)) {
    carveCrater(heights, nrows, ncols, cellX, cellZ, params, crater)
  }

  return { nrows, ncols, width: params.width, depth: params.depth, heights }
}

function carveCrater(
  heights: Float32Array,
  nrows: number,
  ncols: number,
  cellX: number,
  cellZ: number,
  params: TerrainGenParams,
  crater: Crater,
): void {
  const minCol = Math.max(0, Math.floor(((crater.x - crater.radius * 1.4) / params.width + 0.5) * (ncols - 1)))
  const maxCol = Math.min(ncols - 1, Math.ceil(((crater.x + crater.radius * 1.4) / params.width + 0.5) * (ncols - 1)))
  const minRow = Math.max(0, Math.floor(((crater.z - crater.radius * 1.4) / params.depth + 0.5) * (nrows - 1)))
  const maxRow = Math.min(nrows - 1, Math.ceil(((crater.z + crater.radius * 1.4) / params.depth + 0.5) * (nrows - 1)))

  for (let row = minRow; row <= maxRow; row += 1) {
    const z = -params.depth / 2 + row * cellZ
    for (let col = minCol; col <= maxCol; col += 1) {
      const x = -params.width / 2 + col * cellX
      const distance = Math.hypot(x - crater.x, z - crater.z)
      const t = distance / crater.radius
      if (t >= 1.4) continue
      let delta = 0
      if (t < 1) {
        // Bowl: full depth at center, smooth cosine falloff to the rim.
        delta -= crater.depth * (Math.cos(t * Math.PI) * 0.5 + 0.5)
      }
      // Raised rim ring peaking at t = 1.
      const rim = (t - 1) / 0.12
      delta += crater.depth * 0.35 * Math.exp(-rim * rim)
      heights[row * ncols + col] += delta
    }
  }
}
