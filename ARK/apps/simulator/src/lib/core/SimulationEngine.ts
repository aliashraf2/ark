import * as THREE from 'three'

import type { SimulationStatus, TelemetryState, Vector3 } from '../types/SimulationTypes'
import { surfaceAt } from '../environment/SurfaceSystem'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { CameraController } from '../rendering/CameraController'
import { SceneManager } from '../rendering/SceneManager'
import type { PlanetConfig, PlanetId } from '../worlds/PlanetConfig'
import { EnvironmentManager, SPAWN_CLEARANCE, type EnvironmentInfo } from './EnvironmentManager'
import { SimulationClock } from './SimulationClock'

/**
 * Owns the frame loop: fixed-step physics via an accumulator, interpolated
 * rendering (Rapier state is never modified by interpolation), and throttled telemetry.
 * Planet lifecycle (terrain, gravity, lighting) is delegated to the EnvironmentManager.
 */
export class SimulationEngine {
  public readonly physicsWorld: PhysicsWorld
  public readonly sceneManager: SceneManager
  public readonly environment: EnvironmentManager

  private readonly clock = new SimulationClock()
  private readonly cameraController: CameraController
  private readonly telemetryCallback?: (state: TelemetryState) => void
  private readonly environmentCallback?: (info: EnvironmentInfo) => void
  private readonly container: HTMLElement
  private readonly telemetryIntervalMs = 100

  private readonly previousPosition = new THREE.Vector3()
  private readonly currentPosition = new THREE.Vector3()
  private readonly previousRotation = new THREE.Quaternion()
  private readonly currentRotation = new THREE.Quaternion()
  private readonly interpolatedPosition = new THREE.Vector3()
  private readonly interpolatedRotation = new THREE.Quaternion()

  private animationFrameId: number | null = null
  private currentStatus: SimulationStatus = 'running'
  private lastTelemetryEmit = 0
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
    this.environment = new EnvironmentManager(this.physicsWorld, this.sceneManager, {
      pause: () => this.pauseForSwitch(),
      resume: () => this.resume(),
      resetClock: () => this.clock.reset(),
      refresh: (spawn, config) => this.refreshAfterSwitch(spawn, config),
    })

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

  public start(): void {
    if (this.animationFrameId !== null || this.destroyRequested) {
      return
    }

    const renderLoop = (timestamp: number) => {
      if (this.destroyRequested) {
        return
      }

      if (this.currentStatus === 'running') {
        const steps = this.clock.update(timestamp)
        if (steps > 0) {
          this.previousPosition.copy(this.currentPosition)
          this.previousRotation.copy(this.currentRotation)
          for (let i = 0; i < steps; i += 1) {
            this.physicsWorld.step(this.clock.fixedTimeStep)
          }
          this.captureCurrentState()
        }
        this.renderInterpolated()
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
    this.physicsWorld.resetSphere(this.environment.spawnPoint)
    this.snapshotPhysicsState()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  public drop(): void {
    this.clock.reset()
    this.physicsWorld.resetSphere(this.environment.spawnPoint)
    this.currentStatus = 'running'
    this.snapshotPhysicsState()
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

  public setDebugMode(enabled: boolean): void {
    this.sceneManager.setDebugMode(enabled)
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

  private refreshAfterSwitch(spawn: Vector3, config: PlanetConfig): void {
    this.lastConfig = config
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
    this.snapshotPhysicsState()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.sceneManager.resize(width, height)
  }

  private captureCurrentState(): void {
    const position = this.physicsWorld.spherePosition
    const rotation = this.physicsWorld.sphereRotation
    this.currentPosition.set(position.x, position.y, position.z)
    this.currentRotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }

  private snapshotPhysicsState(): void {
    this.captureCurrentState()
    this.previousPosition.copy(this.currentPosition)
    this.previousRotation.copy(this.currentRotation)
  }

  private renderInterpolated(): void {
    const alpha = this.clock.alpha
    this.interpolatedPosition.lerpVectors(this.previousPosition, this.currentPosition, alpha)
    this.interpolatedRotation.slerpQuaternions(
      this.previousRotation,
      this.currentRotation,
      alpha,
    )
    this.sceneManager.syncSphere(
      {
        x: this.interpolatedPosition.x,
        y: this.interpolatedPosition.y,
        z: this.interpolatedPosition.z,
      },
      {
        x: this.interpolatedRotation.x,
        y: this.interpolatedRotation.y,
        z: this.interpolatedRotation.z,
        w: this.interpolatedRotation.w,
      },
    )
  }

  private publishTelemetry(timestamp: number): void {
    const position = this.physicsWorld.spherePosition
    const telemetry: TelemetryState = {
      time: this.clock.elapsed,
      position,
      velocityY: this.physicsWorld.sphereVelocityY,
      gravity: this.physicsWorld.gravity,
      status: this.currentStatus,
      surface: this.surfaceUnderSphere(position),
    }

    this.lastTelemetryEmit = timestamp
    this.telemetryCallback?.(telemetry)
  }

  private surfaceUnderSphere(position: Vector3): string {
    if (!this.lastConfig) return '—'
    return surfaceAt(this.environment.heightfield, this.lastConfig.surfaceRules, position.x, position.z).label
  }
}
