import type { Quaternion, Vector3 } from '../types/SimulationTypes'
import type {
  BatteryReading,
  DriveAction,
  InertialReading,
  RangeReading,
  RoverConfig,
  RoverObservation,
} from './RoverConfig'

/**
 * Pure rover mathematics: action validation, drive-force computation, energy,
 * observations, rewards, and navigation laws. No Rapier, no Three.js, no
 * mutable state — the Rover class feeds these functions and applies results.
 *
 * Documented model (single-body differential drive):
 * - The rover is ONE dynamic rigid body; drive/steer/brake are forces and
 *   torques applied to it each fixed step. There are no jointed wheels or
 *   suspension; wheel colliders are compound shapes for contact only.
 * - Drive force is traction-limited: F <= mu_eff * m * g_local, where mu_eff
 *   is the world's effective terrain friction. Lower gravity (Mars) therefore
 *   genuinely reduces available traction — no per-planet speed hacks.
 * - Lateral tire grip is emulated by damping the velocity component
 *   perpendicular to the heading. This is an approximation, not a Pacejka model.
 */

export interface ValidatedAction {
  left: number
  right: number
  brake: boolean
  eStop: boolean
  /** True when an effort was outside [-1, 1] and got saturated. */
  saturated: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validates one action: rejects NaN/infinite/non-number efforts and non-flags.
 * Out-of-range efforts saturate to [-1, 1] (reported via `saturated`).
 */
export function validateAction(action: DriveAction): ValidatedAction {
  if (!isFiniteNumber(action.left) || !isFiniteNumber(action.right)) {
    throw new Error('Drive efforts must be finite numbers.')
  }
  if (typeof action.brake !== 'boolean' || typeof action.eStop !== 'boolean') {
    throw new Error('Drive brake/eStop flags must be booleans.')
  }
  const left = Math.max(-1, Math.min(1, action.left))
  const right = Math.max(-1, Math.min(1, action.right))
  return {
    left,
    right,
    brake: action.brake,
    eStop: action.eStop,
    saturated: left !== action.left || right !== action.right,
  }
}

/** Yaw/pitch/roll (radians) from a unit quaternion, Y-up convention. */
export function eulerFromQuaternion(q: Quaternion): { yaw: number; pitch: number; roll: number } {
  const { x, y, z, w } = q
  const sinPitch = 2 * (w * x - y * z)
  const pitch = Math.abs(sinPitch) >= 1 ? (Math.sign(sinPitch) * Math.PI) / 2 : Math.asin(sinPitch)
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x))
  const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (z * z + x * x))
  return { yaw, pitch, roll }
}

/** Unit forward vector for a yaw angle. Forward is local +Z at yaw 0. */
export function forwardFromYaw(yawRad: number): Vector3 {
  return { x: Math.sin(yawRad), y: 0, z: Math.cos(yawRad) }
}

/** Signed smallest angle from `from` to `to`, in [-PI, PI]. */
export function angleDifference(fromRad: number, toRad: number): number {
  let diff = (toRad - fromRad) % (2 * Math.PI)
  if (diff > Math.PI) diff -= 2 * Math.PI
  if (diff < -Math.PI) diff += 2 * Math.PI
  return diff
}

export interface DriveContext {
  massKg: number
  gravityMps2: number
  /** Effective terrain friction (base × traction multiplier), dimensionless. */
  traction: number
  yawRad: number
  velocity: Vector3
  dt: number
  chargeJ: number
}

export interface DriveOutput {
  /** World-space force to apply at the center of mass, Newtons. */
  force: Vector3
  /** World-space torque to apply, Newton-meters (yaw only). */
  torque: Vector3
  /** True when zero horizontal velocity should be snapped (stopped + brake). */
  snapStop: boolean
}

/**
 * Computes the force/torque for one validated action over one fixed step.
 * Depleted battery (chargeJ <= 0) yields zero drive effort; brakes still work.
 */
export function computeDrive(
  config: RoverConfig,
  action: ValidatedAction,
  ctx: DriveContext,
): DriveOutput {
  const forward = forwardFromYaw(ctx.yawRad)
  const tractionLimit = Math.max(ctx.traction, 0) * ctx.massKg * ctx.gravityMps2
  const canDrive = ctx.chargeJ > 0 && !action.eStop

  const throttle = canDrive ? (action.left + action.right) / 2 : 0
  const turn = canDrive ? (action.right - action.left) / 2 : 0

  // Longitudinal drive along the heading, traction-limited.
  let driveForce = throttle * config.maxDriveForce * 2
  driveForce = Math.max(-tractionLimit, Math.min(tractionLimit, driveForce))
  const force: Vector3 = {
    x: forward.x * driveForce,
    y: 0,
    z: forward.z * driveForce,
  }

  const torque: Vector3 = { x: 0, y: turn * config.maxYawTorque, z: 0 }

  // Lateral grip: oppose sideways slip, capped by remaining traction budget.
  const vForward = ctx.velocity.x * forward.x + ctx.velocity.z * forward.z
  const slipX = ctx.velocity.x - forward.x * vForward
  const slipZ = ctx.velocity.z - forward.z * vForward
  const gripBudget = Math.max(tractionLimit - Math.abs(driveForce), 0)
  let gripX = -slipX * config.lateralGrip * ctx.massKg
  let gripZ = -slipZ * config.lateralGrip * ctx.massKg
  const gripMag = Math.hypot(gripX, gripZ)
  if (gripMag > gripBudget && gripMag > 0) {
    const scale = gripBudget / gripMag
    gripX *= scale
    gripZ *= scale
  }
  force.x += gripX
  force.z += gripZ

  // Rolling resistance opposes horizontal motion.
  const rr = config.rollingResistance * ctx.massKg
  force.x += -ctx.velocity.x * rr
  force.z += -ctx.velocity.z * rr

  const braking = action.brake || action.eStop
  let snapStop = false
  if (braking) {
    const speed = Math.hypot(ctx.velocity.x, ctx.velocity.z)
    if (speed < 0.08) {
      snapStop = true
    } else {
      const brakeMag = Math.min(config.maxBrakeForce + tractionLimit, (speed * ctx.massKg) / ctx.dt)
      force.x += (-ctx.velocity.x / speed) * brakeMag
      force.z += (-ctx.velocity.z / speed) * brakeMag
    }
  }

  return { force, torque, snapStop }
}

/** Instantaneous power draw in Watts for an action (toy model, documented). */
export function powerDrawW(config: RoverConfig, action: ValidatedAction): number {
  const effort = (Math.abs(action.left) + Math.abs(action.right)) / 2
  return config.idlePowerW + config.drivePowerW * effort * effort
}

/** Advances battery charge over dt; clamps at [0, capacity]. */
export function stepBatteryCharge(chargeJ: number, powerW: number, dt: number): number {
  return Math.max(0, chargeJ - powerW * dt)
}

export function batteryReading(chargeJ: number, capacityJ: number, powerW: number): BatteryReading {
  return {
    chargeJ,
    capacityJ,
    percent: capacityJ > 0 ? Math.max(0, Math.min(1, chargeJ / capacityJ)) : 0,
    powerW,
    depleted: chargeJ <= 0,
  }
}

/** Adds gaussian noise via Box-Muller using an injected uniform [0,1) stream. */
export function addGaussianNoise(value: number, sigma: number, random: () => number): number {
  if (sigma <= 0) return value
  const u1 = Math.max(random(), Number.MIN_VALUE)
  const u2 = random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return value + z * sigma
}

export interface ObservationContext {
  position: Vector3
  yawRad: number
  speed: number
  yawRate: number
  ranges: ReadonlyArray<RangeReading>
  batteryPercent: number
  traction: number
  target: Vector3 | null
}

/** Builds the fixed-size normalized observation vector (see OBSERVATION_SPEC). */
export function buildObservation(
  config: RoverConfig,
  ctx: ObservationContext,
): RoverObservation {
  const dx = ctx.target ? ctx.target.x - ctx.position.x : 0
  const dz = ctx.target ? ctx.target.z - ctx.position.z : 0
  const distance = Math.hypot(dx, dz)
  const bearing = ctx.target ? angleDifference(ctx.yawRad, Math.atan2(dx, dz)) : 0
  const clip = (value: number, bound: number): number => Math.max(-bound, Math.min(bound, value))
  const rays = ctx.ranges.map((reading) =>
    Math.max(0, Math.min(1, reading.distance / config.sensorRange)),
  )
  while (rays.length < 5) rays.push(1)
  return [
    Math.min(1, distance / 100),
    clip(bearing / Math.PI, 1),
    clip(ctx.yawRad / Math.PI, 1),
    Math.min(1, ctx.speed / 8),
    clip(ctx.yawRate / 3, 1),
    rays[0] ?? 1,
    rays[1] ?? 1,
    rays[2] ?? 1,
    rays[3] ?? 1,
    rays[4] ?? 1,
    Math.max(0, Math.min(1, ctx.batteryPercent)),
    Math.min(1, Math.max(0, ctx.traction / 1.5)),
  ]
}

/** Horizontal distance to a target (XZ plane). */
export function goalDistanceXZ(position: Vector3, target: Vector3): number {
  return Math.hypot(target.x - position.x, target.z - position.z)
}

export interface RewardTerms {
  progress: number
  successBonus: number
  collisionPenalty: number
  energyPenalty: number
  timePenalty: number
  total: number
}

/**
 * Deterministic navigation reward from consecutive states. Pure and
 * UI-independent; weights are explicit arguments, not hidden constants.
 */
export function navigationReward(
  previousDistance: number,
  currentDistance: number,
  minRange: number,
  energyJ: number,
  dt: number,
  success: boolean,
  weights: { progress: number; success: number; collision: number; energy: number; time: number },
): RewardTerms {
  const progress = weights.progress * (previousDistance - currentDistance)
  const successBonus = success ? weights.success : 0
  const collisionPenalty = minRange < 0.6 ? weights.collision : 0
  const energyPenalty = weights.energy * energyJ
  const timePenalty = weights.time * dt
  return {
    progress,
    successBonus,
    collisionPenalty,
    energyPenalty,
    timePenalty,
    total: progress + successBonus + collisionPenalty + energyPenalty + timePenalty,
  }
}

/** Proportional heading law with clearance-scaled throttle (baseline autonomy). */
export function headingControlAction(
  yawRad: number,
  targetBearingRad: number,
  minForwardRange: number,
  arrived: boolean,
  gains: { heading: number; maxTurn: number; cruise: number },
): DriveAction {
  if (arrived) {
    return { left: 0, right: 0, brake: true, eStop: false }
  }
  const error = angleDifference(yawRad, targetBearingRad)
  const turn = Math.max(-gains.maxTurn, Math.min(gains.maxTurn, error * gains.heading))
  const clearance = Math.max(0, Math.min(1, minForwardRange / 4))
  const throttle = gains.cruise * clearance * Math.max(0, Math.cos(error))
  return {
    left: Math.max(-1, Math.min(1, throttle - turn)),
    right: Math.max(-1, Math.min(1, throttle + turn)),
    brake: false,
    eStop: false,
  }
}

export function inertialFromBody(
  rotation: { x: number; y: number; z: number; w: number },
  linearVelocity: Vector3,
  angularVelocity: Vector3,
): InertialReading {
  const { yaw, pitch, roll } = eulerFromQuaternion(rotation)
  return {
    kind: 'ideal-ground-truth',
    yawRad: yaw,
    pitchRad: pitch,
    rollRad: roll,
    linearVelocity: { ...linearVelocity },
    angularVelocity: { ...angularVelocity },
    speed: Math.hypot(linearVelocity.x, linearVelocity.y, linearVelocity.z),
  }
}
