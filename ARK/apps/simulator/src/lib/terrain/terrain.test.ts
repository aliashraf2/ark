import { describe, expect, it } from 'vitest'

import { getPlanet, resolveTerrainParams } from '../../../../../packages/physics/src/worlds/planetPresets'
import { createTerrainGeometry } from './createTerrainGeometry'
import { deriveCraters, generateHeightfield } from '../../../../../packages/physics/src/terrain/generateHeightfield'
import { makeTerrainColorFn } from '../../../../../packages/physics/src/terrain/terrainMaterials'
import { getTerrainHeight } from '../../../../../packages/physics/src/terrain/terrainSampling'

const EARTH_PARAMS = resolveTerrainParams(getPlanet('earth'))

describe('Test B: deterministic terrain', () => {
  it('produces identical heightfields for identical seed and params', () => {
    const first = generateHeightfield(EARTH_PARAMS, 12345)
    const second = generateHeightfield(EARTH_PARAMS, 12345)
    expect(first.heights).toEqual(second.heights)
    expect(first.nrows).toBe(first.ncols)
  })

  it('produces different terrain for different seeds', () => {
    const first = generateHeightfield(EARTH_PARAMS, 1)
    const second = generateHeightfield(EARTH_PARAMS, 2)
    let absoluteDiff = 0
    for (let i = 0; i < first.heights.length; i += 1) {
      absoluteDiff += Math.abs((first.heights[i] ?? 0) - (second.heights[i] ?? 0))
    }
    const meanDiff = absoluteDiff / first.heights.length
    expect(meanDiff).toBeGreaterThan(0.5)
  })

  it('derives identical crater layouts from the same seed', () => {
    const mars = resolveTerrainParams(getPlanet('mars'))
    expect(deriveCraters(mars, 777)).toEqual(deriveCraters(mars, 777))
    expect(deriveCraters(mars, 777)).not.toEqual(deriveCraters(mars, 778))
    expect(deriveCraters(mars, 777)).toHaveLength(mars.craterCount)
  })

  it('contains finite relief without holes', () => {
    for (const planet of ['earth', 'mars'] as const) {
      const heightfield = generateHeightfield(resolveTerrainParams(getPlanet(planet)), 42)
      let min = Infinity
      let max = -Infinity
      for (const height of heightfield.heights) {
        expect(Number.isFinite(height)).toBe(true)
        min = Math.min(min, height)
        max = Math.max(max, height)
      }
      // Distinguishable features, not a flat plane or uniform noise floor.
      expect(max - min).toBeGreaterThan(2)
    }
  })
})

describe('Test C: rendered geometry matches the heightfield', () => {
  it('places every vertex exactly on its height sample', () => {
    const heightfield = generateHeightfield(EARTH_PARAMS, 999)
    const geometry = createTerrainGeometry(
      heightfield,
      makeTerrainColorFn(heightfield, getPlanet('earth').surfaceRules, 999),
    )
    try {
      const positions = geometry.getAttribute('position')
      const colors = geometry.getAttribute('color')
      const normals = geometry.getAttribute('normal')
      const index = geometry.getIndex()
      expect(positions.count).toBe(heightfield.heights.length)
      expect(index?.count).toBe(
        (heightfield.nrows - 1) * (heightfield.ncols - 1) * 6,
      )

      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        expect(positions.getY(vertex)).toBeCloseTo(heightfield.heights[vertex] ?? NaN, 6)
        const r = colors.getX(vertex)
        const g = colors.getY(vertex)
        const b = colors.getZ(vertex)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(1)
        expect(g).toBeGreaterThanOrEqual(0)
        expect(g).toBeLessThanOrEqual(1)
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThanOrEqual(1)
        const nx = normals.getX(vertex)
        const ny = normals.getY(vertex)
        const nz = normals.getZ(vertex)
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4)
        expect(ny).toBeGreaterThan(0)
      }
    } finally {
      geometry.dispose()
    }
  })
})

describe('Test H: terrain sampling', () => {
  it('returns exact samples at grid nodes', () => {
    const heightfield = generateHeightfield(EARTH_PARAMS, 31337)
    const { nrows, ncols, width, depth } = heightfield
    const cellX = width / (ncols - 1)
    const cellZ = depth / (nrows - 1)
    for (const [row, col] of [[0, 0], [7, 3], [nrows - 1, ncols - 1], [nrows >> 1, ncols >> 1]]) {
      const x = -width / 2 + (col ?? 0) * cellX
      const z = -depth / 2 + (row ?? 0) * cellZ
      expect(getTerrainHeight(heightfield, x, z)).toBeCloseTo(
        heightfield.heights[(row ?? 0) * ncols + (col ?? 0)] ?? NaN,
        6,
      )
    }
  })

  it('bilinearly interpolates cell interiors (documented rule)', () => {
    const heightfield = generateHeightfield(EARTH_PARAMS, 31337)
    const { ncols, width, depth } = heightfield
    const cellX = width / (ncols - 1)
    // Center of cell (row 10, col 20) equals the mean of its four corners.
    const row = 10
    const col = 20
    const x = -width / 2 + (col + 0.5) * cellX
    const cellZ = depth / (heightfield.nrows - 1)
    const z = -depth / 2 + (row + 0.5) * cellZ
    const corners = [
      heightfield.heights[row * ncols + col] ?? 0,
      heightfield.heights[row * ncols + col + 1] ?? 0,
      heightfield.heights[(row + 1) * ncols + col] ?? 0,
      heightfield.heights[(row + 1) * ncols + col + 1] ?? 0,
    ]
    const mean = (corners[0]! + corners[1]! + corners[2]! + corners[3]!) / 4
    expect(getTerrainHeight(heightfield, x, z)).toBeCloseTo(mean, 6)
  })

  it('clamps coordinates outside the patch to the edge', () => {
    const heightfield = generateHeightfield(EARTH_PARAMS, 31337)
    const { heights } = heightfield
    expect(getTerrainHeight(heightfield, 1e6, 1e6)).toBe(
      heights[heights.length - 1] ?? NaN,
    )
    expect(getTerrainHeight(heightfield, -1e6, -1e6)).toBe(heights[0] ?? NaN)
  })
})
