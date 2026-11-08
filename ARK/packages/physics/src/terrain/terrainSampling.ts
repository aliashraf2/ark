import type { Vector3 } from '../types/SimulationTypes'
import type { Heightfield } from './generateHeightfield'

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

/**
 * Bilinear height lookup on the shared heightfield grid. Coordinates outside
 * the patch are clamped to the patch edge (documented rule, tested).
 * Uses the exact grid mapping from generateHeightfield — no offsets.
 */
export function getTerrainHeight(heightfield: Heightfield, x: number, z: number): number {
  const { nrows, ncols, width, depth, heights } = heightfield
  const fx = clamp01(x / width + 0.5) * (ncols - 1)
  const fz = clamp01(z / depth + 0.5) * (nrows - 1)
  const col = Math.min(Math.floor(fx), ncols - 2)
  const row = Math.min(Math.floor(fz), nrows - 2)
  const tx = Math.min(Math.max(fx - col, 0), 1)
  const tz = Math.min(Math.max(fz - row, 0), 1)

  const h00 = heights[row * ncols + col] ?? 0
  const h10 = heights[row * ncols + col + 1] ?? 0
  const h01 = heights[(row + 1) * ncols + col] ?? 0
  const h11 = heights[(row + 1) * ncols + col + 1] ?? 0

  const top = h00 * (1 - tx) + h10 * tx
  const bottom = h01 * (1 - tx) + h11 * tx
  return top * (1 - tz) + bottom * tz
}

/** Gradient magnitude (rise over run) via central differences on the grid. */
export function getTerrainSlope(heightfield: Heightfield, x: number, z: number): number {
  const { width, depth, ncols, nrows } = heightfield
  const epsX = width / (ncols - 1)
  const epsZ = depth / (nrows - 1)
  const dhdx = (getTerrainHeight(heightfield, x + epsX, z) - getTerrainHeight(heightfield, x - epsX, z)) / (2 * epsX)
  const dhdz = (getTerrainHeight(heightfield, x, z + epsZ) - getTerrainHeight(heightfield, x, z - epsZ)) / (2 * epsZ)
  return Math.hypot(dhdx, dhdz)
}

/** Unit surface normal from the heightfield gradient. Pure; no Three.js needed. */
export function getTerrainNormal(heightfield: Heightfield, x: number, z: number): Vector3 {
  const { width, depth, ncols, nrows } = heightfield
  const epsX = width / (ncols - 1)
  const epsZ = depth / (nrows - 1)
  const dhdx = (getTerrainHeight(heightfield, x + epsX, z) - getTerrainHeight(heightfield, x - epsX, z)) / (2 * epsX)
  const dhdz = (getTerrainHeight(heightfield, x, z + epsZ) - getTerrainHeight(heightfield, x, z - epsZ)) / (2 * epsZ)
  const length = Math.hypot(dhdx, 1, dhdz)
  return { x: -dhdx / length, y: 1 / length, z: -dhdz / length }
}
