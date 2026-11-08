import * as THREE from 'three'

import type { Quaternion, Vector3 } from '../types/SimulationTypes'

export class Sphere {
  public readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>

  constructor(radius: number) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0x74d7ff,
        emissive: 0x0d2438,
        metalness: 0.35,
        roughness: 0.22,
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
