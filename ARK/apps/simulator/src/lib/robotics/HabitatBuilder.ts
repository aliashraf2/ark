import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

/** Places a visible, collidable habitat at a builder rover's reached waypoint. */
export class HabitatBuilder {
  private sequence = 0
  constructor(private readonly world: RAPIER.World, private readonly scene: THREE.Scene) {}

  public build(x: number, z: number, groundY: number): string {
    this.sequence += 1
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, groundY, z))
    const addWall = (hx: number, hy: number, hz: number, ox: number, oy: number, oz: number) => {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz).setFriction(0.9), body)
    }
    // Foundation, four walls, and two sloped roof panels are colliders on the
    // same fixed body; the visual shell uses matching dimensions/materials.
    addWall(1.7, 0.12, 1.7, 0, 0.12, 0)
    addWall(1.65, 1.2, 0.12, 0, 1.42, -1.55)
    addWall(1.65, 1.2, 0.12, 0, 1.42, 1.55)
    addWall(0.12, 1.2, 1.43, -1.55, 1.42, 0)
    addWall(0.12, 1.2, 1.43, 1.55, 1.42, 0)
    const group = new THREE.Group()
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xc58a50, roughness: 0.86 })
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x526c7e, metalness: 0.35, roughness: 0.65 })
    const shell = new THREE.Mesh(new THREE.BoxGeometry(3.1, 2.4, 3.1), wallMat)
    shell.position.y = 1.42
    group.add(shell)
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.65, 0.04), new THREE.MeshStandardMaterial({ color: 0x263640 }))
    door.position.set(0, 0.95, 1.58)
    group.add(door)
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x71d9e8, emissive: 0x164f5b, metalness: 0.35, roughness: 0.2 })
    for (const wx of [-1, 1]) { const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.52, 0.05), windowMat); windowMesh.position.set(wx, 1.65, 1.58); group.add(windowMesh) }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.55, 4), roofMat)
    roof.rotation.y = Math.PI / 4
    roof.position.y = 3.38
    group.add(roof)
    group.position.set(x, groundY, z)
    group.traverse((obj) => { if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true } })
    this.scene.add(group)
    return `habitat-${this.sequence}`
  }
}
