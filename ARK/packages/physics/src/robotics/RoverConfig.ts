import type { Vector3 } from '../types/SimulationTypes'

/** Normalized differential-drive command. Efforts saturate to [-1, 1]. */
export interface DriveAction {
  /** Left actuator effort, -1 (full reverse) .. 1 (full forward). */
  left: number
  /** Right actuator effort, -1 (full reverse) .. 1 (full forward). */
  right: number
  /** Friction brake engaged. */
  brake: boolean
  /** Emergency stop: full brake + zero drive effort this step. */
  eStop: boolean
}

export const NEUTRAL_ACTION: Readonly<DriveAction> = Object.freeze({
  left: 0,
  right: 0,
  brake: false,
  eStop: false,
})

export type SensorValidity = 'ok' | 'saturated' | 'invalid'

/** One distance-ray reading in meters. `distance === maxRange` means no hit. */
export interface RangeReading {
  angleRad: number
  distance: number
  hit: boolean
  validity: SensorValidity
}

/**
 * Ideal inertial readout. Labeled IDEAL: it reports simulator ground truth,
 * not a noisy MEMS device. Noise modeling is future work (see RoverDynamics).
 */
export interface InertialReading {
  kind: 'ideal-ground-truth'
  yawRad: number
  pitchRad: number
  rollRad: number
  linearVelocity: Vector3
  angularVelocity: Vector3
  speed: number
}

export interface BatteryReading {
  chargeJ: number
  capacityJ: number
  percent: number
  powerW: number
  depleted: boolean
}

/** Fixed-size RL-friendly observation vector. See OBSERVATION_SPEC. */
export type RoverObservation = readonly [
  targetDistanceNorm: number,
  targetBearingNorm: number,
  headingNorm: number,
  speedNorm: number,
  yawRateNorm: number,
  ray0: number,
  ray1: number,
  ray2: number,
  ray3: number,
  ray4: number,
  batteryNorm: number,
  tractionNorm: number,
]

export const OBSERVATION_SIZE = 12

export const OBSERVATION_SPEC: ReadonlyArray<{
  index: number
  name: string
  range: readonly [number, number]
  description: string
}> = Object.freeze([
  { index: 0, name: 'targetDistanceNorm', range: [0, 1], description: 'Distance to goal / 100 m, clipped' },
  { index: 1, name: 'targetBearingNorm', range: [-1, 1], description: 'Goal bearing / PI (left negative)' },
  { index: 2, name: 'headingNorm', range: [-1, 1], description: 'Yaw / PI' },
  { index: 3, name: 'speedNorm', range: [0, 1], description: 'Horizontal speed / 8 m/s, clipped' },
  { index: 4, name: 'yawRateNorm', range: [-1, 1], description: 'Yaw rate / 3 rad/s, clipped' },
  { index: 5, name: 'ray0', range: [0, 1], description: 'Range ray -40 deg / maxRange' },
  { index: 6, name: 'ray1', range: [0, 1], description: 'Range ray -20 deg / maxRange' },
  { index: 7, name: 'ray2', range: [0, 1], description: 'Range ray 0 deg / maxRange' },
  { index: 8, name: 'ray3', range: [0, 1], description: 'Range ray +20 deg / maxRange' },
  { index: 9, name: 'ray4', range: [0, 1], description: 'Range ray +40 deg / maxRange' },
  { index: 10, name: 'batteryNorm', range: [0, 1], description: 'Remaining charge fraction' },
  { index: 11, name: 'tractionNorm', range: [0, 1], description: 'Effective traction / 1.5, clipped' },
])

/** Immutable rover construction parameters. SI units throughout. */
export interface RoverConfig {
  /** Chassis cuboid half-extents (x, y, z), meters. Forward is local +Z. */
  readonly chassisHalfExtents: Vector3
  /** Chassis center height above the wheel contact plane, meters. */
  readonly chassisHeight: number
  /** Wheel collider radius, meters (compound balls on the chassis body). */
  readonly wheelRadius: number
  /** Wheel center offsets (x, z) for the 4 wheels, meters. */
  readonly wheelOffsets: ReadonlyArray<Readonly<{ x: number; z: number }>>
  /** Material density for all rover colliders, kg/m^3. */
  readonly density: number
    /** Chassis friction coefficient against terrain (belly skid-plate). */
  readonly friction: number
  /**
   * Wheel-collider friction. Deliberately low: the wheels are locked to the
   * chassis (no rolling joints), so low Coulomb friction emulates free
   * rolling; lateral grip and traction limits are enforced by drive
   * computation instead. Park on slopes with the brake held.
   */
  readonly wheelFriction: number
  /** Restitution for rover colliders. */
  readonly restitution: number
  /** Motor-curve top speed, m/s (DC-motor-style back-EMF approximation). */
  readonly maxSpeed: number
  /** Peak drive force per side at effort 1, Newtons. */
  readonly maxDriveForce: number
  /** Peak yaw torque at full differential, Newton-meters. */
  readonly maxYawTorque: number
  /** Peak braking force, Newtons (traction-limited at runtime). */
  readonly maxBrakeForce: number
  /** Lateral grip gain: counter-force per (m/s) of sideways slip, 1/s. */
  readonly lateralGrip: number
  /** Rolling resistance rate, 1/s (exponential velocity decay). */
  readonly rollingResistance: number
  /** Battery capacity, Joules. */
  readonly batteryCapacityJ: number
  /** Idle hotel load, Watts. */
  readonly idlePowerW: number
  /** Peak drive power at full effort, Watts. */
  readonly drivePowerW: number
  /** Distance-sensor max range, meters. */
  readonly sensorRange: number
  /** Distance-sensor ray angles, radians, 0 = forward. */
  readonly sensorAngles: ReadonlyArray<number>
  /** Sensor origin height above chassis center, meters. */
  readonly sensorHeight: number
  /** Optional per-ray gaussian noise sigma in meters (0 = deterministic). */
  readonly sensorNoiseSigma: number
  /**
   * Angular damping, 1/s. Emulates shock absorbers: without it the rigid
   * suspension-less body cartwheels off bumps at speed.
   */
  readonly angularDamping: number
}

export const DEFAULT_ROVER_CONFIG: RoverConfig = Object.freeze({
  // Short belly inside the wheelbase: the low-friction wheels lead fore and
  // aft, so no high-friction structure can kickstand on slopes.
  chassisHalfExtents: Object.freeze({ x: 0.3, y: 0.14, z: 0.28 }),
  // Belly 0.19 m over the contact plane; wheels outboard (±0.42) like a real
  // rover's outriggers for roll/pitch stability (static tip ~55°).
  chassisHeight: 0.33,
  wheelRadius: 0.16,
  wheelOffsets: Object.freeze([
    Object.freeze({ x: -0.42, z: 0.42 }),
    Object.freeze({ x: 0.42, z: 0.42 }),
    Object.freeze({ x: -0.42, z: -0.42 }),
    Object.freeze({ x: 0.42, z: -0.42 }),
  ]),
  density: 110,
  // Belly skid-plate: low enough to slide off crests instead of anchoring.
  friction: 0.4,
  wheelFriction: 0.05,
  maxSpeed: 6,
  restitution: 0.05,
  // 40 N per side (80 N peak ≈ 0.45 g): stronger motors wheelie the light
  // chassis into backflips. Earth is motor-limited; Mars traction-limits first.
  maxDriveForce: 40,
  // 1.5 N·m peak yaw torque. The compound inertia is small (~0.4 kg·m²),
  // so even single-digit torques spin violently: 120 N·m pinned Rapier's
  // angular-velocity cap in a few steps, and 6 N·m still rocked the body into
  // chaotic rattleback-like reversals the controller could not settle.
  // 1.5 N·m turns briskly (~1 rad/s) without exciting rocking.
  maxYawTorque: 1.5,
  maxBrakeForce: 400,
  lateralGrip: 6,
  rollingResistance: 0.35,
  batteryCapacityJ: 20000,
  idlePowerW: 3,
  drivePowerW: 260,
  sensorRange: 15,
  sensorAngles: Object.freeze([-0.6981, -0.3491, 0, 0.3491, 0.6981]),
  sensorHeight: 0.32,
  sensorNoiseSigma: 0,
  angularDamping: 1.0,
})

/** Rover construction overrides; unspecified fields keep defaults. */
export type RoverConfigOverrides = {
  readonly [K in keyof RoverConfig]?: RoverConfig[K]
}

export function resolveRoverConfig(overrides: RoverConfigOverrides = {}): RoverConfig {
  return Object.freeze({ ...DEFAULT_ROVER_CONFIG, ...overrides })
}

/** Point-in-time rover snapshot for UI, audit, and debugging (not the RL obs). */
export interface RoverSnapshot {
  id: string
  position: Vector3
  yawRad: number
  speed: number
  battery: BatteryReading
  ranges: ReadonlyArray<RangeReading>
  missionStatus: string
  depleted: boolean
}
