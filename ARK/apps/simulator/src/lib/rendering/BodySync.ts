import * as THREE from 'three'

import type { Quaternion, Vector3 } from '../types/SimulationTypes'

/**
 * Reusable previous/current transform Blending for one rigid body's visuals.
 * Interpolates between fixed physics states at render rate; never modifies
 * physics state. One instance per visualized dynamic body.
 */
export class BodySync {
  private readonly previousPosition = new THREE.Vector3()
  private readonly currentPosition = new THREE.Vector3()
  private readonly previousRotation = new THREE.Quaternion()
  private readonly currentRotation = new THREE.Quaternion()
  private readonly interpolatedPosition = new THREE.Vector3()
  private readonly interpolatedRotation = new THREE.Quaternion()

  /** Records the latest physics state, shifting the old one to previous. */
  public push(position: Vector3, rotation: Quaternion): void {
    this.previousPosition.copy(this.currentPosition)
    this.previousRotation.copy(this.currentRotation)
    this.currentPosition.set(position.x, position.y, position.z)
    this.currentRotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }

  /** Snaps both states to the physics state (respawns, world switches). */
  public snap(position: Vector3, rotation: Quaternion): void {
    this.currentPosition.set(position.x, position.y, position.z)
    this.currentRotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
    this.previousPosition.copy(this.currentPosition)
    this.previousRotation.copy(this.currentRotation)
  }

  /**
   * Interpolates previous -> current by alpha. Returns internal reusable
   * objects (valid until the next call) to avoid per-frame allocation.
   */
  public interpolate(alpha: number): { position: THREE.Vector3; rotation: THREE.Quaternion } {
    this.interpolatedPosition.lerpVectors(this.previousPosition, this.currentPosition, alpha)
    this.interpolatedRotation.slerpQuaternions(
      this.previousRotation,
      this.currentRotation,
      alpha,
    )
    return { position: this.interpolatedPosition, rotation: this.interpolatedRotation }
  }
}
