import RAPIER from '@dimforge/rapier3d-compat'

import { downhillYaw, findSpawnSite, footprintSpawnHeight } from '../robotics/RoverDynamics'
import { ExternalController } from '../robotics/controllers'
import { NEUTRAL_ACTION, resolveRoverConfig, type DriveAction } from '../robotics/RoverConfig'
import { RobotManager } from '../robotics/RobotManager'
import { createTerrainBody, type TerrainBody } from '../terrain/createTerrainCollider'
import { generateHeightfield, type Heightfield } from '../terrain/generateHeightfield'
import { getTerrainHeight } from '../terrain/terrainSampling'
import { FIXED_TIME_STEP } from '../types/SimulationTypes'
import type { Vector3 } from '../types/SimulationTypes'
import { getPlanet, resolveTerrainParams } from '../worlds/planetPresets'
import type { PlanetId } from '../worlds/PlanetConfig'

export interface SimulationOptions {
  planet: PlanetId
  seed: number
  /** Fixed physics timestep, seconds. Defaults to 1/60. */
  timestep?: number
}

export interface RobotStateSnapshot {
  id: string
  position: Vector3
  linearVelocity: Vector3
  yawRad: number
  batteryPercent: number
  ranges: ReadonlyArray<{ angleRad: number; distance: number; hit: boolean }>
}

export interface SimulationStateSnapshot {
  planet: PlanetId
  seed: number
  simTimeS: number
  stepCount: number
  robots: RobotStateSnapshot[]
}

/**
 * Headless-first simulation facade over the SAME modules the browser uses
 * (worlds, terrain, physics, robotics — no copies, no rendering). One fixed
 * step per step() call; simulation time advances only through stepping.
 */
export class SimulationCore {
  private static initPromise: Promise<void> | null = null

  private readonly options: Required<SimulationOptions>
  private readonly planet: ReturnType<typeof getPlanet>
  private world: RAPIER.World
  private terrainBody: TerrainBody
  private heightfield: Heightfield
  private manager: RobotManager
  private roverId: string
  private pendingAction: DriveAction = { ...NEUTRAL_ACTION }
  private stepCount = 0

  private constructor(options: Required<SimulationOptions>) {
    this.options = options
    this.planet = getPlanet(options.planet)
    const built = this.build(options.seed)
    this.world = built.world
    this.terrainBody = built.terrainBody
    this.heightfield = built.heightfield
    this.manager = built.manager
    this.roverId = built.roverId
  }

  /** Initializes Rapier once per process, then builds the world. */
  public static async create(options: SimulationOptions): Promise<SimulationCore> {
    if (!SimulationCore.initPromise) {
      SimulationCore.initPromise = RAPIER.init().then(() => undefined)
    }
    await SimulationCore.initPromise
    return new SimulationCore({
      planet: options.planet,
      seed: options.seed,
      timestep: options.timestep ?? FIXED_TIME_STEP,
    })
  }

  /** Advances exactly one fixed timestep. */
  public step(): void {
    this.manager.preStep({
      dt: this.options.timestep,
      gravityMps2: this.planet.gravity,
      traction: this.planet.terrainFriction,
    })
    this.world.step()
    this.manager.postStep(this.options.timestep, {
      halfExtent: this.heightfield.width / 2,
    })
    this.stepCount += 1
  }

  /** Stages the action applied to the rover on subsequent steps. */
  public applyRobotAction(robotId: string, action: DriveAction): void {
    if (robotId !== this.roverId) throw new Error(`Unknown robot "${robotId}".`)
    this.pendingAction = { ...action }
  }

  public getState(): SimulationStateSnapshot {
    const robot = this.getRobotState(this.roverId)
    if (!robot) throw new Error('Headless rover missing.')
    return {
      planet: this.options.planet,
      seed: this.options.seed,
      simTimeS: this.stepCount * this.options.timestep,
      stepCount: this.stepCount,
      robots: [robot],
    }
  }

  public getRobotState(robotId: string): RobotStateSnapshot | null {
    const rover = this.manager.get(robotId)
    if (!rover) return null
    return {
      id: rover.id,
      position: { ...rover.position },
      linearVelocity: { ...rover.linearVelocity },
      yawRad: rover.yawRad,
      batteryPercent: rover.battery().percent,
      ranges: rover.ranges.map((reading) => ({
        angleRad: reading.angleRad,
        distance: reading.distance,
        hit: reading.hit,
      })),
    }
  }

  /** Rebuilds the world from scratch (optionally with a new seed). */
  public reset(seed?: number): void {
    if (seed !== undefined) this.options.seed = seed
    this.manager.dispose()
    this.world.free()
    const built = this.build(this.options.seed)
    this.world = built.world
    this.terrainBody = built.terrainBody
    this.heightfield = built.heightfield
    this.manager = built.manager
    this.roverId = built.roverId
    this.pendingAction = { ...NEUTRAL_ACTION }
    this.stepCount = 0
  }

  public dispose(): void {
    this.manager.dispose()
    this.world.free()
  }

  private build(seed: number): {
    world: RAPIER.World
    terrainBody: TerrainBody
    heightfield: Heightfield
    manager: RobotManager
    roverId: string
  } {
    const world = new RAPIER.World({ x: 0, y: -this.planet.gravity, z: 0 })
    world.timestep = this.options.timestep
    const heightfield = generateHeightfield(resolveTerrainParams(this.planet), seed)
    const terrainBody = createTerrainBody(world, heightfield, {
      friction: this.planet.terrainFriction,
      restitution: this.planet.terrainRestitution,
    })
    const manager = new RobotManager(world, null)
    const sample = (x: number, z: number) => getTerrainHeight(heightfield, x, z)
    // Same spawn policy as the browser engine: gentle site, downhill yaw,
    // footprint-clearing drop height.
    const site = findSpawnSite(sample, 6, 0)
    const yaw = downhillYaw(
      (sample(site.x + 1.5, site.z) - sample(site.x - 1.5, site.z)) / 3,
      (sample(site.x, site.z + 1.5) - sample(site.x, site.z - 1.5)) / 3,
    )
    const wheels = resolveRoverConfig({}).wheelOffsets
    const roverId = manager.spawn(
      {
        position: {
          x: site.x,
          y: footprintSpawnHeight(sample, site.x, site.z, yaw, wheels),
          z: site.z,
        },
        yawRad: yaw,
      },
      {},
      seed,
    )
    manager.setController(roverId, new ExternalController(() => this.pendingAction))
    return { world, terrainBody, heightfield, manager, roverId }
  }
}
