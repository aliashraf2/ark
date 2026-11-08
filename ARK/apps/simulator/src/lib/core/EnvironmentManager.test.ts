import type * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'

import type { Heightfield } from '../../../../../packages/physics/src/terrain/generateHeightfield'
import { getTerrainHeight } from '../../../../../packages/physics/src/terrain/terrainSampling'
import type { Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'
import type { PlanetConfig, PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import { getPlanet } from '../../../../../packages/physics/src/worlds/planetPresets'
import {
  EnvironmentManager,
  SPAWN_CLEARANCE,
  type EngineControls,
  type EnvironmentInfo,
  type PhysicsEnvironment,
  type SceneEnvironment,
} from './EnvironmentManager'

beforeAll(async () => {
  await RAPIER.init()
})

class FakePhysics implements PhysicsEnvironment {
  public gravity = 9.81
  public readonly terrainSets: Array<{ samples: number; friction: number; restitution: number }> = []
  public readonly resets: Vector3[] = []

  public setGravity(magnitude: number): void {
    this.gravity = magnitude
  }

  public setTerrain(heightfield: Heightfield, friction: number, restitution: number): void {
    this.terrainSets.push({ samples: heightfield.heights.length, friction, restitution })
  }

  public resetSphere(position: Vector3): void {
    this.resets.push({ ...position })
  }
}

class FakeScene implements SceneEnvironment {
  public readonly geometries: THREE.BufferGeometry[] = []
  public readonly configs: PlanetConfig[] = []

  public setTerrainGeometry(geometry: THREE.BufferGeometry): void {
    this.geometries.push(geometry)
  }

  public applyEnvironment(config: PlanetConfig): void {
    this.configs.push(config)
  }
}

class FakeControls implements EngineControls {
  public wasRunning = true
  public pauses = 0
  public resumes = 0
  public clockResets = 0
  public readonly refreshes: Array<{ spawn: Vector3; planet: PlanetId }> = []

  public pause(): boolean {
    this.pauses += 1
    return this.wasRunning
  }

  public resume(): void {
    this.resumes += 1
  }

  public resetClock(): void {
    this.clockResets += 1
  }

  public refresh(spawn: Vector3, config: PlanetConfig): void {
    this.refreshes.push({ spawn: { ...spawn }, planet: config.id })
  }
}

function createManager(): { manager: EnvironmentManager; physics: FakePhysics; scene: FakeScene; controls: FakeControls } {
  const physics = new FakePhysics()
  const scene = new FakeScene()
  const controls = new FakeControls()
  return { manager: new EnvironmentManager(physics, scene, controls), physics, scene, controls }
}

describe('Test F: planet switching', () => {
  it('switches Earth -> Mars -> Earth -> Mars with exactly one active terrain', () => {
    const { manager, physics, scene, controls } = createManager()
    const infos: EnvironmentInfo[] = []
    for (const planet of ['earth', 'mars', 'earth', 'mars'] as const) {
      infos.push(manager.switchPlanet(planet))
    }

    // Correct planet + gravity at every step.
    expect(infos.map((info) => info.planet)).toEqual(['earth', 'mars', 'earth', 'mars'])
    expect(physics.gravity).toBeCloseTo(3.71, 2)
    expect(scene.configs.map((config) => config.id)).toEqual(['earth', 'mars', 'earth', 'mars'])

    // One terrain set + one mesh per switch (replacement, never accumulation).
    expect(physics.terrainSets).toHaveLength(4)
    expect(scene.geometries).toHaveLength(4)
    expect(new Set(scene.geometries).size).toBe(4)
    expect(physics.terrainSets[1]?.friction).toBeCloseTo(0.7, 6)

    // Sphere respawned above the local surface every time.
    expect(physics.resets).toHaveLength(4)
    for (const spawn of physics.resets) {
      expect(spawn.x).toBe(0)
      expect(spawn.z).toBe(0)
    }
    const lastSpawn = physics.resets[3]
    const surface = getTerrainHeight(manager.heightfield, 0, 0)
    expect(lastSpawn?.y).toBeCloseTo(surface + SPAWN_CLEARANCE, 6)

    // Lifecycle: pause each switch, reset clock, resume when running.
    expect(controls.pauses).toBe(4)
    expect(controls.clockResets).toBe(4)
    expect(controls.resumes).toBe(4)
    expect(controls.refreshes.map((refresh) => refresh.planet)).toEqual([
      'earth',
      'mars',
      'earth',
      'mars',
    ])
  })

  it('stays paused across a switch when the simulation was paused', () => {
    const { manager, controls } = createManager()
    controls.wasRunning = false
    manager.switchPlanet('mars')
    expect(controls.pauses).toBe(1)
    expect(controls.resumes).toBe(0)
    expect(controls.clockResets).toBe(1)
  })

  it('regenerates, changes profiles, and resets the world', () => {
    const { manager } = createManager()
    manager.switchPlanet('earth')
    const firstSeed = manager.info.seed

    const regenerated = manager.regenerate(424242)
    expect(regenerated.seed).toBe(424242)
    expect(regenerated.planet).toBe('earth')

    const randomized = manager.regenerate()
    expect(randomized.seed).not.toBe(regenerated.seed)

    const profiled = manager.setProfile('highlands')
    expect(profiled.profileId).toBe('highlands')
    expect(() => manager.setProfile('nope')).toThrow()

    const reset = manager.resetWorld()
    expect(reset.seed).toBe(getPlanet('earth').defaultSeed)
    expect(reset.profileId).toBe('rolling-hills')
    expect(firstSeed).toBe(reset.seed)
  })

  it('records complete world metadata for reproducibility', () => {
    const { manager } = createManager()
    const info = manager.switchPlanet('mars', { seed: 7, profileId: 'smooth-basin' })
    expect(info).toMatchObject({
      planet: 'mars',
      displayName: 'Mars',
      seed: 7,
      profileId: 'smooth-basin',
      terrainWidth: 200,
      terrainDepth: 200,
      subdivisions: 160,
      simVersion: 'ark-m3-1',
    })
    expect(info.gravity).toBeCloseTo(3.71, 2)
    expect(info.atmospherePressure).toBe(600)
  })
})
