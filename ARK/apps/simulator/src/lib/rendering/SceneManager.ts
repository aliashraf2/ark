import * as THREE from 'three'

import { Ground } from '../objects/Ground'
import { Sphere } from '../objects/Sphere'
import type { Quaternion, Vector3 } from '../types/SimulationTypes'
import { DEFAULT_PHYSICS_CONFIG } from '../types/SimulationTypes'

export class SceneManager {
  public readonly scene = new THREE.Scene()
  public readonly camera: THREE.PerspectiveCamera
  public readonly renderer: THREE.WebGLRenderer
  public readonly ground: Ground
  public readonly sphere: Sphere

  private readonly axesHelper = new THREE.AxesHelper(2)
  private debugMode = false

  constructor(container: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
    this.camera.position.set(7, 5, 10)
    this.camera.lookAt(0, 1, 0)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x040a12, 1)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(0x050b14)
    this.scene.fog = new THREE.Fog(0x050b14, 12, 42)

    const hemiLight = new THREE.HemisphereLight(0xcfe8ff, 0x0d1720, 1.3)
    this.scene.add(hemiLight)

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4)
    dirLight.position.set(6, 12, 4)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.set(2048, 2048)
    dirLight.shadow.camera.left = -20
    dirLight.shadow.camera.right = 20
    dirLight.shadow.camera.top = 20
    dirLight.shadow.camera.bottom = -20
    dirLight.shadow.camera.near = 0.1
    dirLight.shadow.camera.far = 40
    this.scene.add(dirLight)

    this.ground = new Ground()
    this.sphere = new Sphere(DEFAULT_PHYSICS_CONFIG.sphereRadius)

    this.scene.add(this.ground.mesh)
    this.scene.add(this.sphere.mesh)

    this.axesHelper.position.set(0, 0.01, 0)
    this.axesHelper.visible = false
    this.scene.add(this.axesHelper)
  }

  public resize(width: number, height: number): void {
    if (!width || !height) {
      return
    }

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height, false)
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  public syncSphere(position: Vector3, rotation?: Quaternion): void {
    this.sphere.setPosition(position)
    if (rotation) {
      this.sphere.setRotation(rotation)
    }
  }

  public setDebugMode(enabled: boolean): void {
    this.debugMode = enabled
    this.axesHelper.visible = enabled
    this.sphere.mesh.material.wireframe = enabled
  }

  public get isDebugMode(): boolean {
    return this.debugMode
  }

  public dispose(): void {
    this.ground.dispose()
    this.sphere.dispose()
    this.axesHelper.dispose()
    this.renderer.dispose()

    const element = this.renderer.domElement
    if (element.parentNode) {
      element.parentNode.removeChild(element)
    }
  }
}
