import * as THREE from 'three'

import type { Heightfield } from '../../../../../packages/physics/src/terrain/generateHeightfield'
import type { TerrainColorFn } from '../../../../../packages/physics/src/terrain/terrainMaterials'
import { buildTerrainMeshData } from '../../../../../packages/physics/src/terrain/terrainMeshData'

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
