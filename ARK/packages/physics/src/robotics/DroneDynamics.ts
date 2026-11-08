import RAPIER from '@dimforge/rapier3d-compat'
import type { Vector3 } from '../types/SimulationTypes'

export type DroneRLAction = readonly [ax: number, lift: number, az: number]
export const DRONE_OBSERVATION_SIZE = 9
export const DRONE_ACTION_SIZE = 3
export const DRONE_MAX_ACCEL_MPS2 = 6

function clip(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

/** Create the same orientation-stabilized point-mass quadrotor used by the UI. */
export function createDroneBody(world: RAPIER.World, position: Vector3): RAPIER.RigidBody {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(1.6)
      .setAngularDamping(8)
      .lockRotations()
      .setCanSleep(false),
  )
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.42, 0.1, 0.42).setDensity(1.4), body)
  return body
}

/**
 * Three normalized PPO outputs command translational acceleration. The
 * proportional velocity damping and gravity compensation are part of the
 * shared aircraft dynamics, not a learned per-frame LLM action.
 */
export function applyDroneAction(body: RAPIER.RigidBody, action: DroneRLAction, gravityMps2: number): void {
  const v = body.linvel()
  const mass = body.mass()
  const damping = 1.6
  const ax = clip(action[0]) * DRONE_MAX_ACCEL_MPS2 - v.x * damping
  // Compensate gravity so the normalized vertical output is a thrust offset
  // around hover: zero holds altitude on both Earth and Mars.
  const ay = (1 + clip(action[1])) * gravityMps2 - v.y * damping
  const az = clip(action[2]) * DRONE_MAX_ACCEL_MPS2 - v.z * damping
  body.addForce({ x: mass * ax, y: mass * ay, z: mass * az }, true)
}

/** Fixed-size normalized state for the drone PPO policy. */
export function buildDroneObservation(position: Vector3, velocity: Vector3, target: Vector3): Float32Array {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const dz = target.z - position.z
  const distance = Math.hypot(dx, dy, dz)
  return new Float32Array([
    clip(dx / 40), clip(dz / 40), clip(distance / 60), clip(dy / 10),
    clip(velocity.x / 8), clip(velocity.y / 8), clip(velocity.z / 8),
    clip(position.x / 50), clip(position.z / 50),
  ])
}

/** Stable bounded action used before a learned checkpoint is available. */
export function waypointDroneAction(position: Vector3, velocity: Vector3, target: Vector3, gravityMps2: number): DroneRLAction {
  const desired = (error: number): number => Math.max(-4, Math.min(4, error * 1.3))
  return [
    clip((desired(target.x - position.x) - velocity.x) * 2 / DRONE_MAX_ACCEL_MPS2),
    clip(((target.y - position.y) * 2 - velocity.y * 0.4) / gravityMps2),
    clip((desired(target.z - position.z) - velocity.z) * 2 / DRONE_MAX_ACCEL_MPS2),
  ]
}
