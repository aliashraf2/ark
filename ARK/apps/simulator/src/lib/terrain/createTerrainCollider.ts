import RAPIER from '@dimforge/rapier3d-compat'

import { buildTerrainMeshData } from './createTerrainGeometry'
import type { Heightfield } from './generateHeightfield'

export interface TerrainColliderOptions {
  friction: number
  restitution: number
}

/**
 * Creates a fixed rigid body carrying a static trimesh collider built from the
 * SAME vertex/index arrays as the rendered mesh, so physical and visible
 * surfaces coincide exactly. Rapier copies the arrays into WASM memory, so
 * sharing them with the Three.js BufferAttributes is safe.
 *
 * NOTE: Milestone 2 specifies a preference for Rapier's heightfield collider,
 * but ColliderDesc.heightfield traps with `RuntimeError: unreachable` on valid
 * input in the pinned @dimforge/rapier3d-compat 0.21.0 (verified with a flat
 * 2x2 field under all flag variants). A trimesh over identical triangles is
 * the honest fallback: it removes triangulation ambiguity entirely rather than
 * papering over a broken binding. Revisit if the dependency is upgraded.
 */
export function createTerrainBody(
  world: RAPIER.World,
  heightfield: Heightfield,
  options: TerrainColliderOptions,
): RAPIER.RigidBody {
  const { positions, indices } = buildTerrainMeshData(heightfield)
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0))
  const collider = RAPIER.ColliderDesc.trimesh(positions, indices)
    .setFriction(options.friction)
    .setRestitution(options.restitution)
  world.createCollider(collider, body)
  return body
}
