import type * as THREE from 'three'

import { createTerrainGeometry } from '../terrain/createTerrainGeometry'
import type { Heightfield } from '../../../../../packages/physics/src/terrain/generateHeightfield'
import { generateHeightfield } from '../../../../../packages/physics/src/terrain/generateHeightfield'
import { makeTerrainColorFn } from '../../../../../packages/physics/src/terrain/terrainMaterials'
import { getTerrainHeight } from '../../../../../packages/physics/src/terrain/terrainSampling'
import type { PlanetConfig, PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import {
  defaultProfileForPlanet,
  getPlanet,
  profilesForPlanet,
  resolveTerrainParams,
} from '../../../../../packages/physics/src/worlds/planetPresets'
import type { Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'

/** Simulation build tag recorded with every generated world. */
export const SIM_VERSION = 'ark-m3-1'

/** Spawn clearance above the local terrain surface in meters. */
export const SPAWN_CLEARANCE = 6

/** Narrow structural contracts: real engine subsystems satisfy these implicitly. */
export interface PhysicsEnvironment {
  setGravity(magnitude: number): void
  setTerrain(heightfield: Heightfield, friction: number, restitution: number): void
  resetSphere(position: Vector3): void
}

export interface SceneEnvironment {
  setTerrainGeometry(geometry: THREE.BufferGeometry): void
  applyEnvironment(config: PlanetConfig): void
}

export interface EngineControls {
  /** Pauses stepping; returns true if the simulation was running. */
  pause(): boolean
  resume(): void
  resetClock(): void
  /** Re-syncs visuals/camera/telemetry after a world swap. */
  refresh(spawn: Vector3, config: PlanetConfig): void
}

export interface EnvironmentInfo {
  planet: PlanetId
  displayName: string
  gravity: number
  atmosphereDensity: number
  atmospherePressure: number
  atmosphereReference: string
  seed: number
  profileId: string
  profileLabel: string
  terrainWidth: number
  terrainDepth: number
  subdivisions: number
  simVersion: string
}

export interface SwitchOptions {
  seed?: number
  profileId?: string
}

/**
 * Owns world lifecycle: planet configs, seeds, profiles, and the active
 * heightfield. Switching is synchronous and idempotent-safe: pause, swap
 * physics + visuals, respawn, reset clock, resume.
 *
 * DOCUMENTED TIME RULE: every planet switch, regeneration, and profile change
 * resets simulation time to zero — each loaded world starts a fresh experiment.
 */
export class EnvironmentManager {
  private readonly physics: PhysicsEnvironment
  private readonly scene: SceneEnvironment
  private readonly engine: EngineControls

  private activeConfig: PlanetConfig = getPlanet('earth')
  private activeHeightfield: Heightfield | null = null
  private activeSeed = 0
  private activeProfileId = ''

  constructor(physics: PhysicsEnvironment, scene: SceneEnvironment, engine: EngineControls) {
    this.physics = physics
    this.scene = scene
    this.engine = engine
  }

  public get heightfield(): Heightfield {
    if (!this.activeHeightfield) throw new Error('No environment loaded yet.')
    return this.activeHeightfield
  }

  /** Spawn point: patch center, SPAWN_CLEARANCE above the local surface. */
  public get spawnPoint(): Vector3 {
    const surfaceY = getTerrainHeight(this.heightfield, 0, 0)
    return { x: 0, y: surfaceY + SPAWN_CLEARANCE, z: 0 }
  }

  public get info(): EnvironmentInfo {
    const terrain = resolveTerrainParams(this.activeConfig, this.activeProfileId || undefined)
    const profile =
      profilesForPlanet(this.activeConfig.id).find((entry) => entry.id === this.activeProfileId) ??
      defaultProfileForPlanet(this.activeConfig.id)
    return {
      planet: this.activeConfig.id,
      displayName: this.activeConfig.displayName,
      gravity: this.activeConfig.gravity,
      atmosphereDensity: this.activeConfig.atmosphere.density,
      atmospherePressure: this.activeConfig.atmosphere.pressure,
      atmosphereReference: this.activeConfig.atmosphere.reference,
      seed: this.activeSeed,
      profileId: profile.id,
      profileLabel: profile.label,
      terrainWidth: terrain.width,
      terrainDepth: terrain.depth,
      subdivisions: terrain.subdivisions,
      simVersion: SIM_VERSION,
    }
  }

  public switchPlanet(planet: PlanetId, options: SwitchOptions = {}): EnvironmentInfo {
    const config = getPlanet(planet)
    const profileId = options.profileId ?? defaultProfileForPlanet(planet).id
    const seed = options.seed ?? config.defaultSeed
    this.loadWorld(config, seed, profileId)
    return this.info
  }

  /** Regenerates the active planet's terrain with a new seed (random if omitted). */
  public regenerate(seed?: number): EnvironmentInfo {
    const nextSeed = seed ?? Math.floor(Math.random() * 2 ** 31)
    this.loadWorld(this.activeConfig, nextSeed, this.activeProfileId || undefined)
    return this.info
  }

  public setProfile(profileId: string): EnvironmentInfo {
    this.loadWorld(this.activeConfig, this.activeSeed, profileId)
    return this.info
  }

  /** Restores the planet's default seed and profile. */
  public resetWorld(): EnvironmentInfo {
    return this.switchPlanet(this.activeConfig.id)
  }

  private loadWorld(config: PlanetConfig, seed: number, profileId?: string): void {
    const resolvedProfile = profileId ?? defaultProfileForPlanet(config.id).id
    const params = resolveTerrainParams(config, resolvedProfile)
    const heightfield = generateHeightfield(params, seed)

    const wasRunning = this.engine.pause()
    try {
      this.physics.setGravity(config.gravity)
      this.physics.setTerrain(heightfield, config.terrainFriction, config.terrainRestitution)

      this.activeConfig = config
      this.activeHeightfield = heightfield
      this.activeSeed = seed
      this.activeProfileId = resolvedProfile

      const geometry = createTerrainGeometry(
        heightfield,
        makeTerrainColorFn(heightfield, config.surfaceRules, seed),
      )
      this.scene.setTerrainGeometry(geometry)
      this.scene.applyEnvironment(config)

      const spawn = this.spawnPoint
      this.physics.resetSphere(spawn)
      this.engine.resetClock()
      this.engine.refresh(spawn, config)
    } finally {
      if (wasRunning) this.engine.resume()
    }
  }
}
