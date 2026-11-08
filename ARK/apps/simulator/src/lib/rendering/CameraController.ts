import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type * as THREE from 'three'

export class CameraController {
  public readonly controls: OrbitControls

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.controls = new OrbitControls(camera, canvas)
    this.controls.enableDamping = true
    this.controls.enablePan = true
    this.controls.enableZoom = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 4
    this.controls.maxDistance = 25
    this.controls.minPolarAngle = 0.5
    this.controls.maxPolarAngle = Math.PI / 2.1
    this.controls.target.set(0, 1.2, 0)
    this.controls.update()
  }

  public update(): void {
    this.controls.update()
  }

  public dispose(): void {
    this.controls.dispose()
  }
}
