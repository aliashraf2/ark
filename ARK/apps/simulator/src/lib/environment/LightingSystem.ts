import * as THREE from 'three'

import type { PlanetConfig } from '../../../../../packages/physics/src/worlds/PlanetConfig'

/**
 * Shared planetary lighting + atmosphere appearance. One sun (directional with
 * shadows), one hemisphere fill, plus scene background and fog — all driven by
 * the active planet config. No custom scattering: established Three.js systems.
 *
 * Atmospheric RENDERING (sky color, haze) is separate from atmospheric PHYSICS
 * (density/pressure), which Milestone 2 carries as reference data only.
 */
export class LightingSystem {
  public readonly sun: THREE.DirectionalLight
  public readonly hemisphere: THREE.HemisphereLight

  private baseSunIntensity = 1
  private baseHemiIntensity = 1
  private baseFogNear = 90
  private baseFogFar = 420

  constructor() {
    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0x000000, 1)
    this.sun = new THREE.DirectionalLight(0xffffff, 1)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0002
    this.sun.shadow.normalBias = 0.6
  }

  /** Attaches the lights to the scene (idempotent across planet switches). */
  public attach(scene: THREE.Scene): void {
    scene.add(this.hemisphere)
    scene.add(this.sun)
    scene.add(this.sun.target)
  }

  /** Applies a planet's lighting preset; safe to call on every switch. */
  public apply(config: PlanetConfig, scene: THREE.Scene): void {
    const light = config.lighting

    this.sun.color.setHex(light.sunColor)
    this.sun.intensity = light.sunIntensity
    this.sun.position.set(light.sunPosition.x, light.sunPosition.y, light.sunPosition.z)
    this.sun.target.position.set(0, 0, 0)

    const shadow = this.sun.shadow.camera
    shadow.left = -light.shadowExtent
    shadow.right = light.shadowExtent
    shadow.top = light.shadowExtent
    shadow.bottom = -light.shadowExtent
    shadow.near = 1
    shadow.far = light.sunPosition.y * 2 + light.shadowExtent * 2
    shadow.updateProjectionMatrix()

    this.hemisphere.color.setHex(light.hemiSky)
    this.hemisphere.groundColor.setHex(light.hemiGround)
    this.hemisphere.intensity = light.hemiIntensity

    scene.background = new THREE.Color(light.background)
    scene.fog = new THREE.Fog(light.fogColor, light.fogNear, light.fogFar)

    this.baseSunIntensity = light.sunIntensity
    this.baseHemiIntensity = light.hemiIntensity
    this.baseFogNear = light.fogNear
    this.baseFogFar = light.fogFar
  }

  /**
   * Applies dynamic atmosphere: scales sunlight by the solar multiplier and
   * closes fog to the visibility distance. Called at render rate; cheap.
   */
  public applySolar(scene: THREE.Scene, solarMultiplier: number, visibilityMeters: number): void {
    const multiplier = Math.min(Math.max(solarMultiplier, 0), 1)
    this.sun.intensity = this.baseSunIntensity * multiplier
    // Skylight persists under haze: it dims less than direct sun.
    this.hemisphere.intensity = this.baseHemiIntensity * (0.35 + 0.65 * multiplier)

    const fog = scene.fog
    if (fog instanceof THREE.Fog) {
      const visibility = Math.max(visibilityMeters, 10)
      fog.near = Math.min(this.baseFogNear, visibility * 0.25)
      fog.far = Math.min(this.baseFogFar, visibility)
    }
  }
}
