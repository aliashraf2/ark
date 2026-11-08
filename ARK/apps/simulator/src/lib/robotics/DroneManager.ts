import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'

interface Drone { id: string; body: RAPIER.RigidBody; group: THREE.Group; target: Vector3 | null }

/** Small quadrotor fleet sharing the simulator's Rapier world and terrain. */
export class DroneManager {
  private readonly drones = new Map<string, Drone>()
  private sequence = 0
  constructor(
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly surfaceY: (x: number, z: number) => number,
  ) {}

  public ids(): string[] { return [...this.drones.keys()] }

  public deploy(x: number, z: number): string {
    this.sequence += 1
    const id = `drone-${this.sequence}`
    const y = this.surfaceY(x, z) + 5
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(2.5).setAngularDamping(8).lockRotations(),
    )
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.08, 0.3).setDensity(1.4), body)
    const group = new THREE.Group()
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.12, 8), new THREE.MeshStandardMaterial({ color: 0x26394b, metalness: 0.65, roughness: 0.35 }))
    group.add(shell)
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x64e4ff, emissive: 0x168aaa, emissiveIntensity: 0.5 })
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.07), armMaterial)
    group.add(arm)
    const crossArm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.9), armMaterial)
    group.add(crossArm)
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffc45c, emissive: 0xff8420, emissiveIntensity: 0.8 }))
    lens.position.set(0, 0, 0.22)
    group.add(lens)
    const propMaterial = new THREE.MeshStandardMaterial({ color: 0x9fb3c7, transparent: true, opacity: 0.45 })
    for (const [px, pz] of [[-0.4, -0.4], [-0.4, 0.4], [0.4, -0.4], [0.4, 0.4]]) {
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.015, 20), propMaterial)
      rotor.position.set(px!, 0.08, pz!)
      group.add(rotor)
    }
    group.position.set(x, y, z)
    this.scene.add(group)
    this.drones.set(id, { id, body, group, target: null })
    return id
  }

  public command(id: string, x: number, z: number): boolean {
    const drone = this.drones.get(id)
    if (!drone) return false
    drone.target = { x, y: this.surfaceY(x, z) + 5, z }
    return true
  }

  public position(id: string): Vector3 | null {
    const drone = this.drones.get(id)
    if (!drone) return null
    const p = drone.body.translation()
    return { x: p.x, y: p.y, z: p.z }
  }

  public preStep(dt: number, gravityMps2: number): void {
    for (const drone of this.drones.values()) {
      const p = drone.body.translation(), v = drone.body.linvel()
      const target = drone.target ?? { x: p.x, y: this.surfaceY(p.x, p.z) + 5, z: p.z }
      const desiredX = Math.max(-4, Math.min(4, (target.x - p.x) * 1.3))
      const desiredZ = Math.max(-4, Math.min(4, (target.z - p.z) * 1.3))
      const desiredY = Math.max(-2, Math.min(2, (target.y - p.y) * 2))
      const mass = drone.body.mass()
      drone.body.addForce({ x: mass * (desiredX - v.x) * 2, y: mass * (gravityMps2 + (desiredY - v.y) * 3), z: mass * (desiredZ - v.z) * 2 }, true)
      if (drone.target && Math.hypot(target.x - p.x, target.z - p.z) < 1) drone.target = null
    }
    void dt
  }

  public sync(): void {
    for (const drone of this.drones.values()) {
      const p = drone.body.translation()
      drone.group.position.set(p.x, p.y, p.z)
    }
  }

  public remove(id: string): boolean {
    const drone = this.drones.get(id)
    if (!drone) return false
    this.scene.remove(drone.group)
    drone.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); const m = obj.material; if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose() }
    })
    this.world.removeRigidBody(drone.body)
    this.drones.delete(id)
    return true
  }

  public dispose(): void { for (const id of this.ids()) this.remove(id) }
}
