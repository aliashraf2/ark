import { EnvironmentController, type StartEventSpec } from '../../../../../packages/physics/src/environment/EnvironmentController'
import { getScenario } from '../../../../../packages/physics/src/environment/eventPresets'
import { surfaceAt } from '../../../../../packages/physics/src/environment/SurfaceSystem'
import { PhysicsWorld } from '../../../../../packages/physics/src/physics/PhysicsWorld'
import { RobotManager } from '../../../../../packages/physics/src/robotics/RobotManager'
import { RoverView } from '../robotics/RoverView'
import { resolveRoverConfig } from '../../../../../packages/physics/src/robotics/RoverConfig'
import { downhillYaw, findSpawnSite, footprintSpawnHeight } from '../../../../../packages/physics/src/robotics/RoverDynamics'
import { CameraController } from '../rendering/CameraController'
import { SceneManager } from '../rendering/SceneManager'
import { getTerrainHeight } from '../../../../../packages/physics/src/terrain/terrainSampling'
import type { EnvironmentSnapshot } from '../../../../../packages/physics/src/types/EnvironmentTypes'
import type { SimulationStatus, TelemetryState, Vector3 } from '../../../../../packages/physics/src/types/SimulationTypes'
import type { PlanetConfig, PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import { getPlanet } from '../../../../../packages/physics/src/worlds/planetPresets'
import { EnvironmentManager, SPAWN_CLEARANCE, type EnvironmentInfo } from './EnvironmentManager'
import { SimulationClock } from '../../../../../packages/physics/src/core/SimulationClock'
import { CooperativeRescueCoordinator } from '../robotics/coordination/CooperativeRescueCoordinator'
import { DroneManager } from '../robotics/DroneManager'
import { HabitatBuilder } from '../robotics/HabitatBuilder'
import { SampleManager } from '../robotics/SampleManager'

export type { StartEventSpec }

/**
 * Owns the frame loop: fixed-step physics via an accumulator, interpolated
 * rendering (Rapier state is never modified by interpolation), and throttled telemetry.
 * Planet lifecycle (terrain, gravity, lighting) is delegated to the EnvironmentManager;
 * dynamic environment (wind, weather, solar) to the EnvironmentController, which
 * runs on this same simulation clock.
 */
export class SimulationEngine {
  public readonly physicsWorld: PhysicsWorld
  public readonly sceneManager: SceneManager
  public readonly environment: EnvironmentManager
  public readonly envController: EnvironmentController
  public readonly robots: RobotManager
  public readonly cooperation: CooperativeRescueCoordinator
  public readonly drones: DroneManager
  public readonly habitats: HabitatBuilder
  public readonly samples: SampleManager

  private readonly clock = new SimulationClock()
  private readonly cameraController: CameraController
  private readonly telemetryCallback?: (state: TelemetryState) => void
  private readonly environmentCallback?: (info: EnvironmentInfo) => void
  private readonly container: HTMLElement
  private readonly telemetryIntervalMs = 100


  private animationFrameId: number | null = null
  private currentStatus: SimulationStatus = 'running'
  private lastTelemetryEmit = 0
  private lastFrameTimestamp = 0
  private destroyRequested = false
  private lastConfig: PlanetConfig | null = null
  private followRoverId: string | null = null
  private followDroneId: string | null = null

  constructor(
    container: HTMLElement,
    telemetryCallback?: (state: TelemetryState) => void,
    environmentCallback?: (info: EnvironmentInfo) => void,
  ) {
    this.container = container
    this.telemetryCallback = telemetryCallback
    this.environmentCallback = environmentCallback

    this.sceneManager = new SceneManager(container)
    this.cameraController = new CameraController(
      this.sceneManager.camera,
      this.sceneManager.renderer.domElement,
    )
    this.physicsWorld = new PhysicsWorld({}, { includeTestSphere: false })
    this.physicsWorld.setAeroEnabled(true)
    this.envController = new EnvironmentController(getPlanet('earth'))
    this.environment = new EnvironmentManager(this.physicsWorld, this.sceneManager, {
      pause: () => this.pauseForSwitch(),
      resume: () => this.resume(),
      resetClock: () => this.clock.reset(),
      refresh: (spawn, config) => this.refreshAfterSwitch(spawn, config),
    })

    // RobotManager before the first planet load: refreshAfterSwitch reseats rovers.
    this.robots = new RobotManager(
      this.physicsWorld.world,
      this.sceneManager.scene,
      (accentColor, config) => new RoverView(accentColor, config),
    )
    this.drones = new DroneManager(this.physicsWorld.world, this.sceneManager.scene, (x, z) => getTerrainHeight(this.environment.heightfield, x, z))
    this.habitats = new HabitatBuilder(this.physicsWorld.world, this.sceneManager.scene)
    this.samples = new SampleManager(this.physicsWorld.world, this.sceneManager.scene)
    this.cooperation = new CooperativeRescueCoordinator(this.robots, (x, z, seed) => this.spawnRover(x, z, seed))
    this.environment.switchPlanet('earth')
    this.handleResize()
    this.publishTelemetry(0)

    window.addEventListener('resize', this.handleResize)
  }

  public get status(): SimulationStatus {
    return this.currentStatus
  }

  public get environmentInfo(): EnvironmentInfo {
    return this.environment.info
  }

  public get environmentState(): EnvironmentSnapshot {
    return this.envController.getState()
  }

  /** Verified point-in-time world snapshot for Mission Control and audit trails. */
  public getWorldState(): import('../mission/MissionTypes').WorldStateSnapshot {
    const info = this.environment.info
    return {
      planet: info.planet,
      planetDisplayName: info.displayName,
      simTime: this.clock.elapsed,
      status: this.currentStatus,
      gravity: { ...this.physicsWorld.gravity },
      sphere: { position: this.environment.spawnPoint, velocityY: 0 },
      box: null,
      environment: this.envController.getState(),
      seed: info.seed,
      profileId: info.profileId,
    }
  }

  public start(): void {
    if (this.animationFrameId !== null || this.destroyRequested) {
      return
    }

    const renderLoop = (timestamp: number) => {
      if (this.destroyRequested) {
        return
      }

      const wallDt = this.lastFrameTimestamp === 0 ? 0 : (timestamp - this.lastFrameTimestamp) / 1000
      this.lastFrameTimestamp = timestamp

      if (this.currentStatus === 'running') {
        const dt = this.clock.fixedTimeStep
        const steps = this.clock.update(timestamp)
        if (steps > 0) {
          const frameStartTime = this.clock.elapsed - steps * dt
          for (let i = 0; i < steps; i += 1) {
            const simTime = frameStartTime + i * dt
            const env = this.envController.update(simTime, dt)
            this.physicsWorld.applyEnvironment(env)
            this.robots.preStep({
              dt,
              gravityMps2: Math.abs(this.physicsWorld.gravity.y),
              traction: this.physicsWorld.terrainFriction,
            })
            this.drones.preStep(dt, Math.abs(this.physicsWorld.gravity.y))
            this.cooperation.beforePhysics()
            this.physicsWorld.step(dt)
            this.robots.postStep(dt, { halfExtent: this.environment.info.terrainWidth / 2 })
            this.cooperation.update(dt, simTime + dt)
          }
          this.robots.pushVisuals()
          this.drones.sync()
        }
        this.renderInterpolated()
      }

      // Environment visuals follow state at render rate; frozen while paused.
      this.sceneManager.syncEnvironment(
        this.currentStatus === 'running' ? wallDt : 0,
        this.envController.getState(),
        this.cameraController.controls.target,
      )
      if (this.followRoverId) {
        const followed = this.robots.get(this.followRoverId)
        if (followed) {
          this.cameraController.trackTarget(followed.position)
        } else {
          this.followRoverId = null
        }
      }
      if (this.followDroneId) {
        const position = this.drones.position(this.followDroneId)
        if (position) this.cameraController.trackTarget(position)
        else this.followDroneId = null
      }
      this.cameraController.update()
      this.sceneManager.render()

      if (timestamp - this.lastTelemetryEmit >= this.telemetryIntervalMs) {
        this.publishTelemetry(timestamp)
      }

      this.animationFrameId = window.requestAnimationFrame(renderLoop)
    }

    this.animationFrameId = window.requestAnimationFrame(renderLoop)
  }

  public pause(): void {
    this.currentStatus = 'paused'
  }

  public resume(): void {
    this.currentStatus = 'running'
  }

  public togglePause(): void {
    this.currentStatus = this.currentStatus === 'running' ? 'paused' : 'running'
  }

  public reset(): void {
    this.clock.reset()
    this.envController.snapToTime(0)
    this.reseatRobots()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  public switchPlanet(planet: PlanetId): void {
    const info = this.environment.switchPlanet(planet)
    this.environmentCallback?.(info)
  }

  /** Starts the physical multi-rover Mars rescue scenario in the current world. */
  public startMarsRescue(seed = this.environment.info.seed): string {
    if (this.environment.info.planet !== 'mars') this.switchPlanet('mars')
    this.cooperation.dispose()
    // A rescue is for communication and physical recovery, not a terrain
    // solvability contest; use Mars's existing low-relief basin profile.
    if (this.environment.info.profileId !== 'smooth-basin') this.setTerrainProfile('smooth-basin')
    return this.cooperation.startMarsRescue(seed, this.clock.elapsed)
  }

  public regenerateTerrain(seed?: number): void {
    const info = this.environment.regenerate(seed)
    this.reseatRobots()
    this.environmentCallback?.(info)
  }

  public setTerrainProfile(profileId: string): void {
    const info = this.environment.setProfile(profileId)
    this.reseatRobots()
    this.environmentCallback?.(info)
  }

  public resetWorld(): void {
    const info = this.environment.resetWorld()
    this.reseatRobots()
    this.environmentCallback?.(info)
  }

  /**
   * Spawns a rover near (x, z) on a drivable slope, facing downhill, dropped
   * from a footprint-clearing height. Returns the rover id.
   */
  public spawnRover(x: number, z: number, seed?: number): string {
    const heightfield = this.environment.heightfield
    const sample = (sx: number, sz: number) => getTerrainHeight(heightfield, sx, sz)
    const site = findSpawnSite(sample, x, z)
    const wheels = resolveRoverConfig({}).wheelOffsets
    const yaw = downhillYaw(
      (sample(site.x + 1.5, site.z) - sample(site.x - 1.5, site.z)) / 3,
      (sample(site.x, site.z + 1.5) - sample(site.x, site.z - 1.5)) / 3,
    )
    return this.robots.spawn(
      {
        position: { x: site.x, y: footprintSpawnHeight(sample, site.x, site.z, yaw, wheels), z: site.z },
        yawRad: yaw,
      },
      {},
      seed ?? this.environment.info.seed,
    )
  }

  public deployDrone(x: number, z: number): string { return this.drones.deploy(x, z) }

  public buildHabitat(x: number, z: number): string {
    return this.habitats.build(x, z, getTerrainHeight(this.environment.heightfield, x, z))
  }

  public placeSample(x: number, z: number): string {
    return this.samples.place(x, z, getTerrainHeight(this.environment.heightfield, x, z))
  }

  public collectSample(id: string): boolean { return this.samples.collect(id) }

  public removeRover(id: string): boolean {
    if (this.followRoverId === id) this.followRoverId = null
    return this.robots.remove(id)
  }

  public focusRover(id: string): void {
    const rover = this.robots.get(id)
    if (rover) this.cameraController.focusTarget(rover.position, 9, 4)
  }

  public setFollowRover(id: string | null): void {
    this.followRoverId = id && this.robots.get(id) ? id : null
    if (this.followRoverId) this.followDroneId = null
  }

  public setFollowDrone(id: string | null): void {
    this.followDroneId = id && this.drones.position(id) ? id : null
    if (this.followDroneId) this.followRoverId = null
  }

  public get followRover(): string | null {
    return this.followRoverId
  }

  /** Re-seats all rovers onto the current terrain (reset / switch / regen). */
  private reseatRobots(): void {
    const info = this.environment.info
    const heightfield = this.environment.heightfield
    this.robots.handleWorldChange(
      {
        surfaceY: (x: number, z: number) => getTerrainHeight(heightfield, x, z),
        halfExtent: info.terrainWidth / 2,
      },
      info.seed,
    )
  }

  // ---- Typed environment operations (future CSP surface) ----

  public setWind(speedMps: number, directionFromDeg: number): EnvironmentSnapshot {
    return this.envController.setWind(speedMps, directionFromDeg)
  }

  public setTemperatureCelsius(celsius: number): EnvironmentSnapshot {
    return this.envController.setTemperatureCelsius(celsius)
  }

  public setTractionMultiplier(multiplier: number): EnvironmentSnapshot {
    return this.envController.setTractionMultiplier(multiplier)
  }

  public setSurfaceWetness(wetness: number): EnvironmentSnapshot {
    return this.envController.setSurfaceWetness(wetness)
  }

  public setCloudOpacity(opacity: number): EnvironmentSnapshot {
    return this.envController.setCloudOpacity(opacity)
  }

  public setDustTau(tau: number): EnvironmentSnapshot {
    return this.envController.setDustTau(tau)
  }

  public setPrecipitation(precipitationMmH: number): EnvironmentSnapshot {
    return this.envController.setPrecipitation(precipitationMmH)
  }

  public setAeroEnabled(enabled: boolean): EnvironmentSnapshot {
    return this.envController.setAeroEnabled(enabled)
  }

  public setSolarMultiplier(multiplier: number): EnvironmentSnapshot {
    return this.envController.setSolarMultiplier(multiplier)
  }

  /**
   * Experimental gravity override in m/s^2. Values far from the planetary
   * default are labeled overrides by the mission validator, not realistic physics.
   */
  public setGravity(magnitude: number): void {
    this.physicsWorld.setGravity(magnitude)
  }

  public startEvent(spec: StartEventSpec): EnvironmentSnapshot {
    return this.envController.startEvent(spec)
  }

  public stopEvent(id: string): boolean {
    return this.envController.stopEvent(id)
  }

  public resetEnvironment(): EnvironmentSnapshot {
    return this.envController.reset()
  }

  /** Applies a scenario preset: fresh conditions, then its manual settings and events. */
  public applyScenario(scenarioId: string): EnvironmentSnapshot {
    const scenario = getScenario(scenarioId)
    if (scenario.planet !== this.environment.info.planet) {
      this.switchPlanet(scenario.planet)
    }
    this.envController.reset()
    const manual = scenario.manual
    if (manual?.windSpeed !== undefined) {
      this.envController.setWind(manual.windSpeed, manual.windDirection ?? 270)
    }
    if (manual?.temperatureCelsius !== undefined) {
      this.envController.setTemperatureCelsius(manual.temperatureCelsius)
    }
    if (manual?.traction !== undefined) this.envController.setTractionMultiplier(manual.traction)
    if (manual?.wetness !== undefined) this.envController.setSurfaceWetness(manual.wetness)
    if (manual?.cloudOpacity !== undefined) this.envController.setCloudOpacity(manual.cloudOpacity)
    if (manual?.dustTau !== undefined) this.envController.setDustTau(manual.dustTau)
    if (manual?.precipitation !== undefined) {
      this.envController.setPrecipitation(manual.precipitation)
    }
    for (const event of scenario.events) {
      this.envController.startEvent({ ...event, targets: { ...event.targets } })
    }
    return this.envController.getState()
  }

  public setDebugMode(enabled: boolean): void {
    this.sceneManager.setDebugMode(enabled)
  }

  public setWeatherQuality(quality: 'low' | 'high'): void {
    this.sceneManager.setWeatherQuality(quality)
  }

  public setTopDownView(): void {
    const pos = this.environment.spawnPoint
    this.cameraController.setTopDown(pos, 45)
  }

  public resetCamera(): void {
    if (this.lastConfig) {
      const spawn = this.environment.spawnPoint
      const groundY = spawn.y - SPAWN_CLEARANCE
      const target = { x: spawn.x, y: groundY + this.lastConfig.camera.targetHeight, z: spawn.z }
      this.cameraController.frame(
        {
          x: target.x + this.lastConfig.camera.offset.x,
          y: target.y + this.lastConfig.camera.offset.y,
          z: target.z + this.lastConfig.camera.offset.z,
        },
        target,
      )
    }
  }

  public destroy(): void {
    if (this.destroyRequested) {
      return
    }

    this.destroyRequested = true
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }

    window.removeEventListener('resize', this.handleResize)
    this.cameraController.dispose()
    this.cooperation.dispose()
    this.drones.dispose()
    this.robots.dispose()
    this.sceneManager.dispose()
    this.physicsWorld.dispose()
  }

  private pauseForSwitch(): boolean {
    const wasRunning = this.currentStatus === 'running'
    this.currentStatus = 'paused'
    return wasRunning
  }

  private refreshAfterSwitch(spawn: Vector3, config: PlanetConfig): void {
    this.lastConfig = config
    this.envController.resetForPlanet(config)
    this.reseatRobots()
    const groundY = spawn.y - SPAWN_CLEARANCE
    const target = { x: spawn.x, y: groundY + config.camera.targetHeight, z: spawn.z }
    this.cameraController.frame(
      {
        x: target.x + config.camera.offset.x,
        y: target.y + config.camera.offset.y,
        z: target.z + config.camera.offset.z,
      },
      target,
    )
    this.cameraController.setLimits(
      config.camera.minDistance,
      config.camera.maxDistance,
      config.camera.maxPolarAngle,
    )
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.sceneManager.resize(width, height)
  }

  private renderInterpolated(): void {
    this.robots.syncVisuals(this.clock.alpha)
  }

  private publishTelemetry(timestamp: number): void {
    const roverId = this.robots.ids()[0]
    const rover = roverId ? this.robots.get(roverId) : null
    const droneId = this.drones.ids()[0]
    const position = rover?.position ?? (droneId ? this.drones.position(droneId) : null) ?? this.environment.spawnPoint
    const velocity = rover?.inertial.linearVelocity ?? { x: 0, y: 0, z: 0 }
    const telemetry: TelemetryState = {
      time: this.clock.elapsed,
      position,
      velocityY: velocity.y,
      velocity,
      gravity: this.physicsWorld.gravity,
      status: this.currentStatus,
      surface: this.surfaceUnderSphere(position),
      environment: this.envController.getState(),
    }

    this.lastTelemetryEmit = timestamp
    this.telemetryCallback?.(telemetry)
  }

  private surfaceUnderSphere(position: Vector3): string {
    if (!this.lastConfig) return '—'
    return surfaceAt(this.environment.heightfield, this.lastConfig.surfaceRules, position.x, position.z).label
  }
}
