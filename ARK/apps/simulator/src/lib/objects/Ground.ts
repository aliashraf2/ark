import * as THREE from 'three'

export class Ground {
  public readonly mesh = new THREE.Group()

  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly grid: THREE.GridHelper

  constructor() {
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({
        color: 0x111e2c,
        emissive: 0x0a1520,
        metalness: 0.2,
        roughness: 0.78,
      }),
    )
    this.plane.rotation.x = -Math.PI / 2
    this.plane.receiveShadow = true
    this.plane.position.y = 0

    this.grid = new THREE.GridHelper(40, 40, 0x7bd3ff, 0x1d2f3e)
    this.grid.position.y = 0.001

    this.mesh.add(this.plane)
    this.mesh.add(this.grid)
  }

  public dispose(): void {
    this.plane.geometry.dispose()
    this.plane.material.dispose()
    const material = this.grid.material
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose())
    } else {
      material.dispose()
    }
  }
}
