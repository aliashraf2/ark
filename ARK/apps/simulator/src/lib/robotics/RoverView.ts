import * as THREE from 'three'

import { BodySync } from '../rendering/BodySync'
import type { Quaternion, Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'
import type { Rover } from '../../../../../packages/physics/src/robotics/Rover'
import type { RoverConfig } from '../../../../../packages/physics/src/robotics/RoverConfig'
import { forwardFromYaw } from '../../../../../packages/physics/src/robotics/RoverDynamics'

const RAY_COUNT = 5

/**
 * Three.js visualization for one rover: chassis box, 4 spinning wheels, a
 * heading mast, and optional sensor-ray lines. Pure follower of Rapier state
 * via BodySync interpolation — it never influences physics. Wheel spin is a
 * visual odometer (distance / radius), not a joint simulation.
 */
export class RoverView {
  public readonly group = new THREE.Group()

  private readonly blend = new BodySync()
  private readonly wheels: THREE.Mesh[] = []
  private readonly rayLines: THREE.LineSegments
  private readonly rayPositions: Float32Array
  private wheelSpin = 0
  private readonly wheelRadius: number

  constructor(accentColor: number, config: RoverConfig) {
    const wheelRadius = config.wheelRadius
    const chassisY = config.chassisHeight
    const half = config.chassisHalfExtents
    this.wheelRadius = wheelRadius

    const chassisMaterial = new THREE.MeshStandardMaterial({
      color: 0x1c2635,
      metalness: 0.55,
      roughness: 0.4,
    })
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 0.55,
      metalness: 0.2,
      roughness: 0.5,
    })
    const wheelMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b0f16,
      metalness: 0.1,
      roughness: 0.9,
    })

    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
      chassisMaterial,
    )
    chassis.position.y = chassisY
    chassis.castShadow = true
    chassis.receiveShadow = true
    this.group.add(chassis)

    // Sensor mast + forward stripe: heading readable at a glance.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.5), accentMaterial)
    stripe.position.set(0, chassisY + half.y + 0.01, 0.15)
    this.group.add(stripe)
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), chassisMaterial)
    mast.position.set(0, chassisY + half.y + 0.14, -0.3)
    mast.castShadow = true
    this.group.add(mast)
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 12), accentMaterial)
    beacon.position.set(0, chassisY + half.y + 0.32, -0.3)
    this.group.add(beacon)

    const wheelGeometry = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.12, 18)
    wheelGeometry.rotateZ(Math.PI / 2)
    for (const offset of config.wheelOffsets) {
      const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial)
      wheel.position.set(offset.x, wheelRadius, offset.z)
      wheel.castShadow = true
      this.group.add(wheel)
      this.wheels.push(wheel)
    }

    this.rayPositions = new Float32Array(RAY_COUNT * 2 * 3)
    const rayGeometry = new THREE.BufferGeometry()
    rayGeometry.setAttribute('position', new THREE.BufferAttribute(this.rayPositions, 3).setUsage(THREE.DynamicDrawUsage))
    this.rayLines = new THREE.LineSegments(
      rayGeometry,
      new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.65 }),
    )
    this.rayLines.visible = false
    this.rayLines.frustumCulled = false
    this.group.add(this.rayLines)
  }

  public push(position: Vector3, rotation: Quaternion): void {
    this.blend.push(position, rotation)
  }

  public snap(position: Vector3, rotation: Quaternion): void {
    this.blend.snap(position, rotation)
    this.group.position.set(position.x, position.y, position.z)
    this.group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }

  public setRaysVisible(visible: boolean): void {
    this.rayLines.visible = visible
  }

  /** Interpolates the group transform and refreshes wheels + rays from the rover. */
  public sync(alpha: number, rover: Rover): void {
    const { position, rotation } = this.blend.interpolate(alpha)
    const previousX = this.group.position.x
    const previousZ = this.group.position.z
    this.group.position.copy(position)
    this.group.quaternion.copy(rotation)

    // Visual odometer: spin wheels by horizontal distance traveled.
    const traveled = Math.hypot(position.x - previousX, position.z - previousZ)
    this.wheelSpin += traveled / this.wheelRadius
    for (const wheel of this.wheels) {
      wheel.rotation.x = this.wheelSpin
    }

    if (this.rayLines.visible) {
      // Sensor-local frame: the group rotation already applies the yaw.
      const sensorLocalY = rover.config.chassisHeight + rover.config.sensorHeight
      const ranges = rover.ranges
      for (let i = 0; i < RAY_COUNT; i += 1) {
        const reading = ranges[i]
        const dir = forwardFromYaw(reading?.angleRad ?? 0)
        const dist = reading?.distance ?? rover.config.sensorRange
        const base = i * 6
        this.rayPositions[base] = 0
        this.rayPositions[base + 1] = sensorLocalY
        this.rayPositions[base + 2] = 0
        this.rayPositions[base + 3] = dir.x * dist
        this.rayPositions[base + 4] = sensorLocalY
        this.rayPositions[base + 5] = dir.z * dist
      }
      const attribute = this.rayLines.geometry.getAttribute('position')
      if (attribute instanceof THREE.BufferAttribute) {
        attribute.needsUpdate = true
        this.rayLines.geometry.computeBoundingSphere()
      }
    }
  }

  public dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        const material = object.material
        if (Array.isArray(material)) {
          for (const entry of material) entry.dispose()
        } else {
          material.dispose()
        }
      }
    })
  }
}
