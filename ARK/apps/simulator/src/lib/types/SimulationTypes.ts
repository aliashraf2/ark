export type Vector3 = {
  x: number
  y: number
  z: number
}

export type Quaternion = {
  x: number
  y: number
  z: number
  w: number
}

export type SimulationStatus = 'running' | 'paused'

export interface PhysicsConfig {
  gravity: Vector3
  groundHeight: number
  sphereRadius: number
  sphereDensity: number
  sphereInitialPosition: Vector3
  sphereRestitution: number
  groundRestitution: number
  sphereFriction: number
  groundFriction: number
}

/** Fixed physics timestep in seconds (60 Hz). Canonical constant for the whole sim. */
export const FIXED_TIME_STEP = 1 / 60

/** Largest wall-clock delta consumed in one frame; bounds catch-up after tab inactivity. */
export const MAX_FRAME_DELTA = 0.25

/**
 * Demonstration material parameters for Milestone 1 (not experimentally measured).
 * One world unit represents one meter; the ground surface sits at Y = 0.
 */
export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  gravity: { x: 0, y: -9.81, z: 0 },
  groundHeight: 0,
  sphereRadius: 0.5,
  sphereDensity: 1,
  sphereInitialPosition: { x: 0, y: 5, z: 0 },
  sphereRestitution: 0.35,
  groundRestitution: 0.35,
  sphereFriction: 0.6,
  groundFriction: 0.8,
}

export interface TelemetryState {
  time: number
  position: Vector3
  velocityY: number
  gravity: Vector3
  status: SimulationStatus
  /** Surface material under the sphere, e.g. "Regolith". */
  surface: string
}
