import * as THREE from 'three'

import { mulberry32 } from '../terrain/terrainNoise'
import type { EnvironmentState } from '../types/EnvironmentTypes'
import type { Vector3 } from '../types/SimulationTypes'

export type WeatherQuality = 'low' | 'high'

const QUALITY_COUNTS: Record<WeatherQuality, { rain: number; dust: number }> = {
  low: { rain: 600, dust: 800 },
  high: { rain: 2200, dust: 2600 },
}

/** Horizontal extent of the particle volume in meters. */
const VOLUME_SIZE = 120
/** Particle volume height in meters. */
const VOLUME_HEIGHT = 50

interface ParticleVolume {
  points: THREE.Points
  positions: Float32Array
  seeds: Float32Array
  count: number
}

/**
 * GPU-friendly rain and dust visualization. Two THREE.Points clouds recycled
 * inside a box around the view target — no per-frame allocation, no physics
 * bodies. Strictly visual: particle motion reflects the environment state
 * (wind, precipitation, dust) but never feeds back into physics.
 */
export class WeatherRenderer {
  private readonly scene: THREE.Scene
  private quality: WeatherQuality
  private rain: ParticleVolume | null = null
  private dust: ParticleVolume | null = null

  constructor(scene: THREE.Scene, quality: WeatherQuality = 'high') {
    this.scene = scene
    this.quality = quality
    this.rebuild()
  }

  public setQuality(quality: WeatherQuality): void {
    if (quality === this.quality) return
    this.quality = quality
    this.rebuild()
  }

  public get particleCounts(): { rain: number; dust: number } {
    return { ...QUALITY_COUNTS[this.quality] }
  }

  /**
   * Advances particle visuals. Called at render rate with wall-clock delta;
   * determinism is not required (visual only), but motion derives solely from
   * the passed environment state and the view center.
   */
  public update(wallDt: number, env: EnvironmentState, center: Vector3): void {
    const dt = Math.min(Math.max(wallDt, 0), 0.1)
    // Snap the volume to a coarse grid so particles don't swim with the camera.
    const baseX = Math.round(center.x / 4) * 4
    const baseZ = Math.round(center.z / 4) * 4
    const baseY = Math.max(center.y - 6, 0)

    if (this.rain) {
      const intensity = Math.min(env.precipitation / 12, 1)
      this.rain.points.visible = intensity > 0.01
      if (this.rain.points.visible) {
        ;(this.rain.points.material as THREE.PointsMaterial).opacity = 0.25 + 0.55 * intensity
        this.updateRain(this.rain, dt, env, baseX, baseY, baseZ)
      }
    }

    if (this.dust) {
      const intensity = Math.min(env.dustTau / 2.5, 1)
      this.dust.points.visible = intensity > 0.01
      if (this.dust.points.visible) {
        ;(this.dust.points.material as THREE.PointsMaterial).opacity = 0.15 + 0.5 * intensity
        this.updateDust(this.dust, dt, env, baseX, baseY, baseZ)
      }
    }
  }

  public dispose(): void {
    for (const volume of [this.rain, this.dust]) {
      if (!volume) continue
      this.scene.remove(volume.points)
      volume.points.geometry.dispose()
      ;(volume.points.material as THREE.Material).dispose()
    }
    this.rain = null
    this.dust = null
  }

  private rebuild(): void {
    this.dispose()
    const counts = QUALITY_COUNTS[this.quality]
    this.rain = this.createVolume(counts.rain, 0x9fc8ff, 0.35, 1234)
    this.dust = this.createVolume(counts.dust, 0xd8a06a, 0.55, 987)
  }

  private createVolume(
    count: number,
    color: number,
    size: number,
    seed: number,
  ): ParticleVolume {
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count * 2)
    const random = mulberry32(seed)
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = random() * VOLUME_SIZE
      positions[i * 3 + 1] = random() * VOLUME_HEIGHT
      positions[i * 3 + 2] = random() * VOLUME_SIZE
      seeds[i * 2] = random()
      seeds[i * 2 + 1] = random()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.visible = false
    this.scene.add(points)
    return { points, positions, seeds, count }
  }

  private updateRain(
    volume: ParticleVolume,
    dt: number,
    env: EnvironmentState,
    baseX: number,
    baseY: number,
    baseZ: number,
  ): void {
    // Positions stay volume-local; the Points object itself is offset so the
    // cloud follows the view. Terminal velocity ~9 m/s; wind advects drops.
    const { positions, seeds, count } = volume
    const windX = env.wind.x * 0.6
    const windZ = env.wind.z * 0.6
    for (let i = 0; i < count; i += 1) {
      const fall = (8 + (seeds[i * 2] ?? 0) * 3) * dt
      let y = (positions[i * 3 + 1] ?? 0) - fall
      let x = (positions[i * 3] ?? 0) + windX * dt
      let z = (positions[i * 3 + 2] ?? 0) + windZ * dt
      if (y < 0) {
        y += VOLUME_HEIGHT
        x = (seeds[i * 2 + 1] ?? 0) * VOLUME_SIZE
        z = (seeds[i * 2] ?? 0) * VOLUME_SIZE
      }
      positions[i * 3] = wrapPositive(x, VOLUME_SIZE)
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = wrapPositive(z, VOLUME_SIZE)
    }
    volume.points.geometry.getAttribute('position').needsUpdate = true
    volume.points.position.set(baseX - VOLUME_SIZE / 2, baseY, baseZ - VOLUME_SIZE / 2)
  }

  private updateDust(
    volume: ParticleVolume,
    dt: number,
    env: EnvironmentState,
    baseX: number,
    baseY: number,
    baseZ: number,
  ): void {
    // Dust drifts with the wind plus per-particle jitter, slowly settling.
    const { positions, seeds, count } = volume
    const speed = Math.hypot(env.wind.x, env.wind.z)
    const drift = Math.max(speed, 1.5)
    const dirX = speed > 0.01 ? env.wind.x / speed : 1
    const dirZ = speed > 0.01 ? env.wind.z / speed : 0
    for (let i = 0; i < count; i += 1) {
      const jitterX = ((seeds[i * 2] ?? 0) - 0.5) * 2
      const jitterZ = ((seeds[i * 2 + 1] ?? 0) - 0.5) * 2
      const x = (positions[i * 3] ?? 0) + (dirX * drift + jitterX) * dt
      const z = (positions[i * 3 + 2] ?? 0) + (dirZ * drift + jitterZ) * dt
      let y = (positions[i * 3 + 1] ?? 0) - 0.35 * dt
      if (y < 0) y += VOLUME_HEIGHT
      positions[i * 3] = wrapPositive(x, VOLUME_SIZE)
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = wrapPositive(z, VOLUME_SIZE)
    }
    volume.points.geometry.getAttribute('position').needsUpdate = true
    volume.points.position.set(baseX - VOLUME_SIZE / 2, baseY, baseZ - VOLUME_SIZE / 2)
  }
}

function wrapPositive(value: number, size: number): number {
  return ((value % size) + size) % size
}
