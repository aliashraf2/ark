import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

interface CachedSample { body: RAPIER.RigidBody; mesh: THREE.Group }

/** Physical sample markers that are removed only after a rover reaches them. */
export class SampleManager {
  private sequence = 0
  private readonly samples = new Map<string, CachedSample>()
  constructor(private readonly world: RAPIER.World, private readonly scene: THREE.Scene) {}

  public place(x: number, z: number, groundY: number): string {
    this.sequence += 1
    const id = `sample-${this.sequence}`
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, groundY + 0.35, z))
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.35, 0.28).setFriction(0.65), body)
    const mesh = new THREE.Group()
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0xdcae5f, metalness: 0.35, roughness: 0.42 }))
    jar.position.y = 0.35
    mesh.add(jar)
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12), new THREE.MeshStandardMaterial({ color: 0x48dfd6, emissive: 0x126c65, emissiveIntensity: 0.8 }))
    cap.position.y = 0.64
    mesh.add(cap)
    const marker = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.035, 6, 28), new THREE.MeshBasicMaterial({ color: 0x48f5dc }))
    marker.rotation.x = -Math.PI / 2
    marker.position.y = 0.03
    mesh.add(marker)
    mesh.position.set(x, groundY, z)
    this.scene.add(mesh)
    this.samples.set(id, { body, mesh })
    return id
  }

  public collect(id: string): boolean {
    const sample = this.samples.get(id)
    if (!sample) return false
    this.scene.remove(sample.mesh)
    sample.mesh.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        const material = object.material
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
        else material.dispose()
      }
    })
    this.world.removeRigidBody(sample.body)
    this.samples.delete(id)
    return true
  }
}
