import type RAPIER from '@dimforge/rapier3d-compat'

import type { Quaternion, Vector3 } from '../types/SimulationTypes'
import { footprintSpawnHeight, goalDistanceXZ } from './RoverDynamics'
import { resolveRoverConfig, type RoverConfig, type RoverConfigOverrides, type RoverSnapshot } from './RoverConfig'
import { Rover, type RoverSpawn } from './Rover'
import { MissionManager, type MissionBounds, type NavigationMission } from './MissionManager'
import {
  ManualController,
  type ControlInput,
  type Controller,
} from './controllers'

export interface RobotStepEnvironment {
  dt: number
  gravityMps2: number
  traction: number
}

export interface WorldChangeSampler {
  surfaceY: (x: number, z: number) => number
  halfExtent: number
}

/**
 * Structural view contract (implemented by the Three.js RoverView in the
 * browser adapter). Headless runtimes pass no factory and get no views,
 * so this module never imports Three.js.
 */
export interface RobotView {
  readonly group: unknown
  snap(position: Vector3, rotation: Quaternion): void
  push(position: Vector3, rotation: Quaternion): void
  sync(alpha: number, rover: Rover): void
  setRaysVisible(visible: boolean): void
  dispose(): void
}

export type RoverViewFactory = (accentColor: number, config: RoverConfig) => RobotView

/** Structural scene contract: add/remove only. */
export interface RobotScene {
  add(object: unknown): void
  remove(object: unknown): void
}

const ROVER_COLORS = [0x35d0ff, 0xffb02e, 0x7dff6a, 0xff6a8a, 0xc9a6ff, 0x8a8f9e]

/**
 * Owns every rover's lifecycle: spawn/remove, per-step controller→actuator
 * fan-out, sensor refresh, missions, and (optionally) Three.js views.
 * No global robot state — all state lives on the Rover instances and their
 * controllers. Engine-agnostic: the SimulationEngine just calls preStep /
 * postStep inside its fixed-step loop.
 */
export class RobotManager {
  public readonly missions = new MissionManager()

  private readonly world: RAPIER.World
  private readonly scene: RobotScene | null
  private readonly viewFactory: RoverViewFactory | null
  private readonly rovers = new Map<string, Rover>()
  private readonly controllers = new Map<string, Controller>()
  private readonly views = new Map<string, RobotView>()
  private sequence = 0

  constructor(world: RAPIER.World, scene: RobotScene | null = null, viewFactory?: RoverViewFactory) {
    this.world = world
    this.scene = scene
    this.viewFactory = viewFactory ?? null
  }

  public get count(): number {
    return this.rovers.size
  }

  public ids(): string[] {
    return [...this.rovers.keys()]
  }

  public get(id: string): Rover | null {
    return this.rovers.get(id) ?? null
  }

  public getController(id: string): Controller | null {
    return this.controllers.get(id) ?? null
  }

  public setController(id: string, controller: Controller): void {
    if (!this.rovers.has(id)) throw new Error(`No rover ${id}.`)
    this.controllers.set(id, controller)
  }

  public disableDriveMotor(id: string): void {
    const rover = this.rovers.get(id)
    if (!rover) throw new Error(`No rover ${id}.`)
    rover.disableDriveMotor()
  }

  public enableDriveMotor(id: string): void {
    const rover = this.rovers.get(id)
    if (!rover) throw new Error(`No rover ${id}.`)
    rover.enableDriveMotor()
  }

  public applyExternalForce(id: string, force: Vector3): void {
    const rover = this.rovers.get(id)
    if (!rover) throw new Error(`No rover ${id}.`)
    rover.applyExternalForce(force)
  }

  /** Spawns a rover; id is `rover-N`. View is created when a scene is bound. */
  public spawn(spawn: RoverSpawn, overrides: RoverConfigOverrides = {}, seed?: number): string {
    this.sequence += 1
    const id = `rover-${this.sequence}`
    const config = resolveRoverConfig(overrides)
    const rover = new Rover(this.world, id, config, spawn, seed ?? this.sequence * 7919)
    this.rovers.set(id, rover)
    this.controllers.set(id, new ManualController())
    if (this.scene && this.viewFactory) {
      const view = this.viewFactory(
        ROVER_COLORS[(this.sequence - 1) % ROVER_COLORS.length] ?? 0x35d0ff,
        config,
      )
      view.snap(rover.position, rover.rotation)
      this.scene.add(view.group)
      this.views.set(id, view)
    }
    rover.senseRanges()
    return id
  }

  public remove(id: string): boolean {
    const rover = this.rovers.get(id)
    if (!rover) return false
    rover.dispose()
    this.rovers.delete(id)
    this.controllers.delete(id)
    const view = this.views.get(id)
    if (view) {
      this.scene?.remove(view.group)
      view.dispose()
      this.views.delete(id)
    }
    this.missions.removeRoverMissions(id)
    return true
  }

  /** Runs controllers and applies actions. Called once per fixed step, pre-physics. */
  public preStep(env: RobotStepEnvironment): void {
    for (const [id, rover] of this.rovers) {
      const controller = this.controllers.get(id)
      if (!controller) continue
      rover.updateYawRate(env.dt)
      const input = this.controlInputFor(id, rover, env.traction)
      const action = controller.update(input, env.dt)
      rover.applyAction(action, { gravityMps2: env.gravityMps2, traction: env.traction, dt: env.dt })
    }
  }

  /** Refreshes sensors and missions after physics steps. */
  public postStep(dt: number, bounds: MissionBounds | null): void {
    const positions = new Map<string, Vector3>()
    for (const [id, rover] of this.rovers) {
      rover.senseRanges()
      positions.set(id, rover.position)
    }
    this.missions.update(dt, positions, bounds)
  }

  public controlInputFor(id: string, rover: Rover, traction: number): ControlInput {
    const mission = this.missions.missionForRover(id)
    const target = mission ? mission.target : null
    const arrived =
      mission !== null &&
      (mission.status === 'succeeded' ||
        (target !== null && goalDistanceXZ(rover.position, target) <= mission.toleranceM))
    return {
      position: rover.position,
      yawRad: rover.yawRad,
      yawRateRadS: rover.yawRate,
      speed: rover.inertial.speed,
      ranges: rover.ranges,
      target,
      arrived,
      batteryPercent: rover.battery().percent,
      traction,
      roverConfig: rover.config,
    }
  }

  public snapshot(id: string): RoverSnapshot | null {
    const rover = this.rovers.get(id)
    if (!rover) return null
    const mission: NavigationMission | null = this.missions.missionForRover(id)
    return {
      id,
      position: rover.position,
      yawRad: rover.yawRad,
      speed: rover.inertial.speed,
      battery: rover.battery(),
      ranges: rover.ranges,
      missionStatus: mission ? mission.status : 'none',
      depleted: rover.depleted,
    }
  }

  /** Records current physics transforms for render interpolation. */
  public pushVisuals(): void {
    for (const [id, view] of this.views) {
      const rover = this.rovers.get(id)
      if (rover) view.push(rover.position, rover.rotation)
    }
  }

  /** Interpolates + renders every rover view (raycast viz included). */
  public syncVisuals(alpha: number): void {
    for (const [id, view] of this.views) {
      const rover = this.rovers.get(id)
      if (rover) view.sync(alpha, rover)
    }
  }

  public setRaysVisible(visible: boolean): void {
    for (const view of this.views.values()) view.setRaysVisible(visible)
  }

  /**
   * Safely re-seats every rover after planet switch / terrain regeneration:
   * clamps to the new patch, drops onto the new surface, zeroes velocities,
   * refills batteries, and parks missions back to pending. Controllers reset.
   */
  public handleWorldChange(sampler: WorldChangeSampler, seed: number): void {
    for (const [id, rover] of this.rovers) {
      const position = rover.position
      const x = Math.max(-sampler.halfExtent + 2, Math.min(sampler.halfExtent - 2, position.x))
      const z = Math.max(-sampler.halfExtent + 2, Math.min(sampler.halfExtent - 2, position.z))
      const dropY = footprintSpawnHeight(
        sampler.surfaceY,
        x,
        z,
        0,
        rover.config.wheelOffsets,
      )
      rover.reset({ position: { x, y: dropY, z }, yawRad: 0 }, seed)
      this.controllers.get(id)?.reset()
      const mission = this.missions.missionForRover(id)
      if (mission) this.missions.resetMission(mission.id)
      const view = this.views.get(id)
      if (view) view.snap(rover.position, rover.rotation)
    }
  }

  public dispose(): void {
    for (const id of [...this.rovers.keys()]) this.remove(id)
  }
}
