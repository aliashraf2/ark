import * as THREE from 'three'

import { LightingSystem } from '../environment/LightingSystem'
import { WeatherRenderer, type WeatherQuality } from '../environment/WeatherRenderer'
import { Sphere } from '../objects/Sphere'
import { TestBox } from '../objects/TestBox'
import type { EnvironmentState } from '../types/EnvironmentTypes'
import type { Quaternion, Vector3 } from '../types/SimulationTypes'
import { DEFAULT_PHYSICS_CONFIG } from '../types/SimulationTypes'
import type { PlanetConfig } from '../worlds/PlanetConfig'

export class SceneManager {
  public readonly scene = new THREE.Scene()
  public readonly camera: THREE.PerspectiveCamera
  public readonly renderer: THREE.WebGLRenderer
  public readonly sphere: Sphere
  public readonly testBox: TestBox
  public readonly lighting = new LightingSystem()
  public readonly weather: WeatherRenderer

  private readonly terrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  })
  private terrainMesh: THREE.Mesh<THREE.BufferGeometry, typeof this.terrainMaterial> | null = null
  private readonly axesHelper = new THREE.AxesHelper(2)
  private debugMode = false

  constructor(container: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
    this.camera.position.set(18, 16, 24)
    this.camera.lookAt(0, 1, 0)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x040a12, 1)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    container.appendChild(this.renderer.domElement)

    // Neutral defaults; EnvironmentManager applies the planet preset on load.
    this.scene.background = new THREE.Color(0x050b14)
    this.scene.fog = new THREE.Fog(0x050b14, 90, 420)
    this.lighting.attach(this.scene)

    this.sphere = new Sphere(DEFAULT_PHYSICS_CONFIG.sphereRadius)
    this.scene.add(this.sphere.mesh)

    this.testBox = new TestBox()
    this.scene.add(this.testBox.mesh)

    this.weather = new WeatherRenderer(this.scene)

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

  public syncBox(position: Vector3, rotation?: Quaternion): void {
    this.testBox.setPosition(position)
    if (rotation) {
      this.testBox.setRotation(rotation)
    }
  }

  /** Applies dynamic atmosphere + weather visuals at render rate. */
  public syncEnvironment(wallDt: number, env: EnvironmentState, viewCenter: Vector3): void {
    this.lighting.applySolar(this.scene, env.solarMultiplier, env.visibility)
    this.weather.update(wallDt, env, viewCenter)
  }

  public setWeatherQuality(quality: WeatherQuality): void {
    this.weather.setQuality(quality)
  }

  /**
   * Swaps the active terrain mesh. The previous geometry is disposed; the
   * material is shared across planets (colors live in vertices).
   */
  public setTerrainGeometry(geometry: THREE.BufferGeometry): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh)
      this.terrainMesh.geometry.dispose()
    }
    this.terrainMesh = new THREE.Mesh(geometry, this.terrainMaterial)
    this.terrainMesh.receiveShadow = true
    this.terrainMesh.castShadow = false
    this.scene.add(this.terrainMesh)
  }

  public applyEnvironment(config: PlanetConfig): void {
    this.lighting.apply(config, this.scene)
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
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh)
      this.terrainMesh.geometry.dispose()
      this.terrainMesh = null
    }
    this.terrainMaterial.dispose()
    this.sphere.dispose()
    this.testBox.dispose()
    this.weather.dispose()
    this.axesHelper.dispose()
    this.renderer.dispose()

    const element = this.renderer.domElement
    if (element.parentNode) {
      element.parentNode.removeChild(element)
    }
  }
}
