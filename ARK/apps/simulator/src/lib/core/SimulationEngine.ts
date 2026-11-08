import * as THREE from 'three'

import type { SimulationStatus, TelemetryState } from '../types/SimulationTypes'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { CameraController } from '../rendering/CameraController'
import { SceneManager } from '../rendering/SceneManager'
import { SimulationClock } from './SimulationClock'

/**
 * Owns the frame loop: fixed-step physics via an accumulator, interpolated
 * rendering (Rapier state is never modified by interpolation), and throttled telemetry.
 */
export class SimulationEngine {
  public readonly physicsWorld: PhysicsWorld
  public readonly sceneManager: SceneManager

  private readonly clock = new SimulationClock()
  private readonly cameraController: CameraController
  private readonly telemetryCallback?: (state: TelemetryState) => void
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

  constructor(container: HTMLElement, telemetryCallback?: (state: TelemetryState) => void) {
    this.container = container
    this.telemetryCallback = telemetryCallback

    this.sceneManager = new SceneManager(container)
    this.cameraController = new CameraController(
      this.sceneManager.camera,
      this.sceneManager.renderer.domElement,
    )
    this.physicsWorld = new PhysicsWorld()

    this.snapshotPhysicsState()
    this.sceneManager.syncSphere(
      this.physicsWorld.spherePosition,
      this.physicsWorld.sphereRotation,
    )
    this.handleResize()
    this.publishTelemetry(0)

    window.addEventListener('resize', this.handleResize)
  }

  public get status(): SimulationStatus {
    return this.currentStatus
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
    this.physicsWorld.resetSphere()
    this.snapshotPhysicsState()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
  }

  public drop(): void {
    this.clock.reset()
    this.physicsWorld.resetSphere()
    this.currentStatus = 'running'
    this.snapshotPhysicsState()
    this.renderInterpolated()
    this.publishTelemetry(this.lastTelemetryEmit + this.telemetryIntervalMs)
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
    }

    this.lastTelemetryEmit = timestamp
    this.telemetryCallback?.(telemetry)
  }
}
