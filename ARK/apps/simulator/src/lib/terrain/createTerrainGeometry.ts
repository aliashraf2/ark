import * as THREE from 'three'

import type { Heightfield } from './generateHeightfield'
import type { TerrainColorFn } from './terrainMaterials'

export interface TerrainMeshData {
  /** Vertex positions [x, y, z] * nrows * ncols, row-major over the grid. */
  positions: Float32Array
  /** Triangle indices; vertex (row, col) is at row * ncols + col. */
  indices: Uint32Array
}

/**
 * Single source of terrain triangles: the SAME positions/indices feed both the
 * Three.js mesh and the Rapier trimesh collider, so rendered and physical
 * surfaces agree by construction (no resampling, no offsets, no diagonal
 * ambiguity). Vertex (row, col) sits exactly on the heightfield grid point.
 *
 * Quad triangulation: each cell splits along the (r,c+1)-(r+1,c) diagonal
 * into faces (a,c,b) and (b,c,d), counter-clockwise seen from +Y.
 */
export function buildTerrainMeshData(heightfield: Heightfield): TerrainMeshData {
  const { nrows, ncols, width, depth, heights } = heightfield
  const positions = new Float32Array(nrows * ncols * 3)
  const cellX = width / (ncols - 1)
  const cellZ = depth / (nrows - 1)

  for (let row = 0; row < nrows; row += 1) {
    const z = -depth / 2 + row * cellZ
    for (let col = 0; col < ncols; col += 1) {
      const vertex = row * ncols + col
      positions[vertex * 3] = -width / 2 + col * cellX
      positions[vertex * 3 + 1] = heights[vertex] ?? 0
      positions[vertex * 3 + 2] = z
    }
  }

  const quads = (nrows - 1) * (ncols - 1)
  const indices = new Uint32Array(quads * 6)
  let cursor = 0
  for (let row = 0; row < nrows - 1; row += 1) {
    for (let col = 0; col < ncols - 1; col += 1) {
      const a = row * ncols + col
      const b = row * ncols + col + 1
      const c = (row + 1) * ncols + col
      const d = (row + 1) * ncols + col + 1
      indices[cursor] = a
      indices[cursor + 1] = c
      indices[cursor + 2] = b
      indices[cursor + 3] = b
      indices[cursor + 4] = c
      indices[cursor + 5] = d
      cursor += 6
    }
  }

  return { positions, indices }
}

/**
 * Render mesh over the shared mesh data: smooth normals, per-vertex colors
 * from the planet's deterministic color function. The caller owns disposal.
 */
export function createTerrainGeometry(
  heightfield: Heightfield,
  colorAt: TerrainColorFn,
): THREE.BufferGeometry {
  const { nrows, ncols } = heightfield
  const { positions, indices } = buildTerrainMeshData(heightfield)
  const colors = new Float32Array(nrows * ncols * 3)

  for (let vertex = 0; vertex < nrows * ncols; vertex += 1) {
    const x = positions[vertex * 3] ?? 0
    const height = positions[vertex * 3 + 1] ?? 0
    const z = positions[vertex * 3 + 2] ?? 0
    const [r, g, b] = colorAt(x, z, height)
    colors[vertex * 3] = r
    colors[vertex * 3 + 1] = g
    colors[vertex * 3 + 2] = b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
