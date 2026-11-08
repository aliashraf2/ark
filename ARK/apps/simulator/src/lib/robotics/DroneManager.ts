import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'
import { applyDroneAction, buildDroneObservation, createDroneBody, waypointDroneAction, type DroneRLAction } from '../../../../../packages/physics/src/robotics/DroneDynamics'

interface Drone { id: string; body: RAPIER.RigidBody; group: THREE.Group; target: Vector3 | null; policy: ((observation: Float32Array) => DroneRLAction) | null }

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
    const body = createDroneBody(this.world, { x, y, z })
    const group = new THREE.Group()
    const shell = new THREE.Mesh(new THREE.OctahedronGeometry(0.27, 0), new THREE.MeshStandardMaterial({ color: 0x49f1ff, emissive: 0x00a9c7, emissiveIntensity: 1.35, metalness: 0.35, roughness: 0.25 }))
    group.add(shell)
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0xa5f8ff, emissive: 0x168aaa, emissiveIntensity: 0.9, metalness: 0.35, roughness: 0.3 })
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.065, 0.085), armMaterial)
    group.add(arm)
    const crossArm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.065, 1.45), armMaterial)
    group.add(crossArm)
    const lens = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.24, 8), new THREE.MeshStandardMaterial({ color: 0xffd272, emissive: 0xff8420, emissiveIntensity: 1.2 }))
    lens.rotation.x = Math.PI / 2
    lens.position.set(0, 0, 0.22)
    group.add(lens)
    const propMaterial = new THREE.MeshStandardMaterial({ color: 0x9bffff, emissive: 0x42dfff, emissiveIntensity: 1.3, metalness: 0.1, roughness: 0.25 })
    for (const [px, pz] of [[-0.68, -0.68], [-0.68, 0.68], [0.68, -0.68], [0.68, 0.68]]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), armMaterial)
      mast.position.set(px!, 0.12, pz!)
      group.add(mast)
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.035, 20), propMaterial)
      rotor.position.set(px!, 0.24, pz!)
      group.add(rotor)
    }
    const beacon = new THREE.PointLight(0x43eeff, 12, 7)
    beacon.position.y = 0.2
    group.add(beacon)
    group.position.set(x, y, z)
    this.scene.add(group)
    this.drones.set(id, { id, body, group, target: null, policy: null })
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

  public velocity(id: string): Vector3 | null {
    const drone = this.drones.get(id)
    if (!drone) return null
    const v = drone.body.linvel()
    return { x: v.x, y: v.y, z: v.z }
  }

  public setPolicy(id: string, policy: ((observation: Float32Array) => DroneRLAction) | null): boolean {
    const drone = this.drones.get(id)
    if (!drone) return false
    drone.policy = policy
    return true
  }

  public preStep(dt: number, gravityMps2: number): void {
    for (const drone of this.drones.values()) {
      const p = drone.body.translation(), velocity = drone.body.linvel()
      const position = { x: p.x, y: p.y, z: p.z }
      const v = { x: velocity.x, y: velocity.y, z: velocity.z }
      const target = drone.target ?? { x: p.x, y: this.surfaceY(p.x, p.z) + 5, z: p.z }
      const waypoint = waypointDroneAction(position, v, target, gravityMps2)
      const learned = drone.policy?.(buildDroneObservation(position, v, target))
      // Keep learned exploration inside the stable waypoint envelope while
      // the PPO checkpoint is still experimental; trained PPO supplies a
      // small residual rather than taking over flight safety.
      const action: DroneRLAction = learned
        ? [0, 1, 2].map((index) => waypoint[index]! * 0.95 + learned[index]! * 0.05) as unknown as DroneRLAction
        : waypoint
      applyDroneAction(drone.body, action, gravityMps2)
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
