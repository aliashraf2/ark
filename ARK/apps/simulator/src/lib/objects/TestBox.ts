import * as THREE from 'three'

import type { Quaternion, Vector3 } from '../types/SimulationTypes'

/** Lightweight amber cube mirroring the wind-test physics box. */
export class TestBox {
  public readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>

  constructor(size = 0.5) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({
        color: 0xf0a832,
        emissive: 0x3a2408,
        metalness: 0.1,
        roughness: 0.6,
      }),
    )

    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
  }

  public setPosition(position: Vector3): void {
    this.mesh.position.set(position.x, position.y, position.z)
  }

  public setRotation(rotation: Quaternion): void {
    this.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }

  public setTransform(position: Vector3, rotation: Quaternion): void {
    this.setPosition(position)
    this.setRotation(rotation)
  }

  public dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
