import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type * as THREE from 'three'

import type { Vector3 } from '../types/SimulationTypes'

export class CameraController {
  public readonly controls: OrbitControls

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.controls = new OrbitControls(camera, canvas)
    this.controls.enableDamping = true
    this.controls.enablePan = true
    this.controls.enableZoom = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 2
    this.controls.maxDistance = 150
    this.controls.minPolarAngle = 0.05
    this.controls.maxPolarAngle = Math.PI / 2.05
    this.controls.target.set(0, 1.2, 0)
    this.controls.update()
  }

  /** Frames a world location (e.g. the sphere spawn) after a planet switch. */
  public frame(position: Vector3, target: Vector3): void {
    this.controls.object.position.set(position.x, position.y, position.z)
    this.controls.target.set(target.x, target.y, target.z)
    this.controls.update()
  }

  public focusTarget(target: Vector3, distance: number = 8): void {
    const currentPos = this.controls.object.position
    const dx = currentPos.x - this.controls.target.x
    const dy = currentPos.y - this.controls.target.y
    const dz = currentPos.z - this.controls.target.z
    const len = Math.hypot(dx, dy, dz) || 1
    const nx = dx / len
    const ny = Math.max(dy / len, 0.25)
    const nz = dz / len

    this.controls.target.set(target.x, target.y, target.z)
    this.controls.object.position.set(
      target.x + nx * distance,
      target.y + ny * distance,
      target.z + nz * distance,
    )
    this.controls.update()
  }

  public setTopDown(target: Vector3, height: number = 45): void {
    this.controls.target.set(target.x, target.y, target.z)
    this.controls.object.position.set(target.x, target.y + height, target.z + 0.1)
    this.controls.update()
  }

  public setLimits(minDistance: number, maxDistance: number, maxPolarAngle: number): void {
    this.controls.minDistance = minDistance
    this.controls.maxDistance = maxDistance
    this.controls.maxPolarAngle = maxPolarAngle
    this.controls.update()
  }

  public update(): void {
    this.controls.update()
  }

  public dispose(): void {
    this.controls.dispose()
  }
}
