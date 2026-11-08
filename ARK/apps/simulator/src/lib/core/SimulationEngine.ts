import { EnvironmentController, type StartEventSpec } from '../environment/EnvironmentController'
import { getScenario } from '../environment/eventPresets'
import { surfaceAt } from '../environment/SurfaceSystem'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { CameraController } from '../rendering/CameraController'
import { BodySync } from '../rendering/BodySync'
import { SceneManager } from '../rendering/SceneManager'
import { getTerrainHeight } from '../terrain/terrainSampling'
import type { EnvironmentSnapshot } from '../types/EnvironmentTypes'
import type { SimulationStatus, TelemetryState, Vector3 } from '../types/SimulationTypes'
import type { PlanetConfig, PlanetId } from '../worlds/PlanetConfig'
import { getPlanet } from '../worlds/planetPresets'
import { EnvironmentManager, SPAWN_CLEARANCE, type EnvironmentInfo } from './EnvironmentManager'
import { SimulationClock } from './SimulationClock'

export type { StartEventSpec }

/** Horizontal offset of the wind-test box spawn from the sphere spawn. */
const BOX_SPAWN_OFFSET = { x: 3.5, z: 1.5 }

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

  private readonly clock = new SimulationClock()
  private readonly cameraController: CameraController
  private readonly telemetryCallback?: (state: TelemetryState) => void
  private readonly environmentCallback?: (info: EnvironmentInfo) => void
  private readonly container: HTMLElement
  private readonly telemetryIntervalMs = 100

  private readonly sphereSync = new BodySync()
  private readonly boxSync = new BodySync()

  private animationFrameId: number | null = null
  private currentStatus: SimulationStatus = 'running'
  private lastTelemetryEmit = 0
  private lastFrameTimestamp = 0
  private destroyRequested = false
  private lastConfig: PlanetConfig | null = null

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
    this.physicsWorld = new PhysicsWorld()
    this.physicsWorld.setAeroEnabled(true)
    this.envController = new EnvironmentController(getPlanet('earth'))
    this.environment = new EnvironmentManager(this.physicsWorld, this.sceneManager, {
      pause: () => this.pauseForSwitch(),
      resume: () => this.resume(),
      resetClock: () => this.clock.reset(),
      refresh: (spawn, config) => this.refreshAfterSwitch(spawn, config),
    })

    this.environment.switchPlanet('earth')
    this.physicsWorld.createWindTestBox(this.boxSpawnPoint())
    this.snapBoxToPhysics()
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
      sphere: {
        position: this.physicsWorld.spherePosition,
        velocityY: this.physicsWorld.sphereVelocityY,
      },
      box: this.physicsWorld.hasWindTestBox
        ? {
            position: this.physicsWorld.boxPosition,
            velocityY: this.physicsWorld.boxVelocityY,
          }
        : null,
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
            this.physicsWorld.step(dt)
          }
          this.pushBodyStates()
        }
        this.renderInterpolated()
      }

      // Environment visuals follow state at render rate; frozen while paused.
      this.sceneManager.syncEnvironment(
        this.currentStatus === 'running' ? wallDt : 0,
        this.envController.getState(),
        this.cameraController.controls.target,
      )
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
    this.physicsWorld.resetSphere(this.environment.spawnPoint)
    this.physicsWorld.resetWindTestBox(this.boxSpawnPoint())
    this.snapshotBodies()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  public drop(): void {
    this.clock.reset()
    this.envController.snapToTime(0)
    this.physicsWorld.resetSphere(this.environment.spawnPoint)
    this.physicsWorld.resetWindTestBox(this.boxSpawnPoint())
    this.currentStatus = 'running'
    this.snapshotBodies()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  public switchPlanet(planet: PlanetId): void {
    const info = this.environment.switchPlanet(planet)
    this.environmentCallback?.(info)
  }

  public regenerateTerrain(seed?: number): void {
    const info = this.environment.regenerate(seed)
    this.environmentCallback?.(info)
  }

  public setTerrainProfile(profileId: string): void {
    const info = this.environment.setProfile(profileId)
    this.environmentCallback?.(info)
  }

  public resetWorld(): void {
    const info = this.environment.resetWorld()
    this.environmentCallback?.(info)
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

  public focusSphere(): void {
    const pos = this.physicsWorld.spherePosition
    this.cameraController.focusTarget(pos, 8)
  }

  public focusBox(): void {
    if (this.physicsWorld.hasWindTestBox) {
      const pos = this.physicsWorld.boxPosition
      this.cameraController.focusTarget(pos, 8)
    }
  }

  public setTopDownView(): void {
    const pos = this.physicsWorld.spherePosition
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
    this.sceneManager.dispose()
    this.physicsWorld.dispose()
  }

  private pauseForSwitch(): boolean {
    const wasRunning = this.currentStatus === 'running'
    this.currentStatus = 'paused'
    return wasRunning
  }

  private boxSpawnPoint(): Vector3 {
    const surfaceY = getTerrainHeight(
      this.environment.heightfield,
      BOX_SPAWN_OFFSET.x,
      BOX_SPAWN_OFFSET.z,
    )
    return {
      x: BOX_SPAWN_OFFSET.x,
      y: surfaceY + SPAWN_CLEARANCE,
      z: BOX_SPAWN_OFFSET.z,
    }
  }

  private refreshAfterSwitch(spawn: Vector3, config: PlanetConfig): void {
    this.lastConfig = config
    this.envController.resetForPlanet(config)
    this.physicsWorld.resetWindTestBox(this.boxSpawnPoint())
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
    this.snapshotBodies()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.sceneManager.resize(width, height)
  }

  private pushBodyStates(): void {
    this.sphereSync.push(this.physicsWorld.spherePosition, this.physicsWorld.sphereRotation)
    if (this.physicsWorld.hasWindTestBox) {
      this.boxSync.push(this.physicsWorld.boxPosition, this.physicsWorld.boxRotation)
    }
  }

  private snapshotBodies(): void {
    this.sphereSync.snap(this.physicsWorld.spherePosition, this.physicsWorld.sphereRotation)
    this.snapBoxToPhysics()
  }

  private snapBoxToPhysics(): void {
    if (this.physicsWorld.hasWindTestBox) {
      this.boxSync.snap(this.physicsWorld.boxPosition, this.physicsWorld.boxRotation)
    }
  }

  private renderInterpolated(): void {
    const alpha = this.clock.alpha
    const sphere = this.sphereSync.interpolate(alpha)
    this.sceneManager.syncSphere(
      { x: sphere.position.x, y: sphere.position.y, z: sphere.position.z },
      { x: sphere.rotation.x, y: sphere.rotation.y, z: sphere.rotation.z, w: sphere.rotation.w },
    )
    if (this.physicsWorld.hasWindTestBox) {
      const box = this.boxSync.interpolate(alpha)
      this.sceneManager.syncBox(
        { x: box.position.x, y: box.position.y, z: box.position.z },
        { x: box.rotation.x, y: box.rotation.y, z: box.rotation.z, w: box.rotation.w },
      )
    }
  }

  private publishTelemetry(timestamp: number): void {
    const position = this.physicsWorld.spherePosition
    const velocity = this.physicsWorld.sphereVelocity
    const telemetry: TelemetryState = {
      time: this.clock.elapsed,
      position,
      velocityY: this.physicsWorld.sphereVelocityY,
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
