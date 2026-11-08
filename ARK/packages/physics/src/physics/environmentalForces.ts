import type { Vector3 } from '../types/SimulationTypes'

/** Upper bound for sane wind speeds in m/s; inputs above are clamped. */
export const MAX_WIND_SPEED = 60

/** Upper bound for drag force magnitude in N; keeps integration stable. */
export const MAX_DRAG_FORCE = 1e6

export interface AerodynamicBody {
  /** Drag coefficient (dimensionless). Sphere ~0.47, cube ~1.05. */
  dragCoefficient: number
  /** Effective cross-sectional area in m^2. */
  area: number
}

/**
 * Quadratic aerodynamic drag: F = -0.5 * rho * Cd * A * |v_rel| * v_rel,
 * where v_rel = bodyVelocity - windVelocity. Pure; all inputs sanitized so the
 * result is always finite. Scales linearly with atmospheric density: the same
 * wind on Mars (~0.02 kg/m^3) yields ~1/60 the force it does on Earth.
 */
export function computeDragForce(
  airDensity: number,
  body: AerodynamicBody,
  bodyVelocity: Vector3,
  windVelocity: Vector3,
): Vector3 {
  const rho = sanitizeNonNegative(airDensity)
  const cd = sanitizeNonNegative(body.dragCoefficient)
  const area = sanitizeNonNegative(body.area)
  const rel = {
    x: sanitizeFinite(bodyVelocity.x) - sanitizeFinite(windVelocity.x),
    y: sanitizeFinite(bodyVelocity.y) - sanitizeFinite(windVelocity.y),
    z: sanitizeFinite(bodyVelocity.z) - sanitizeFinite(windVelocity.z),
  }
  const speed = Math.hypot(rel.x, rel.y, rel.z)
  if (speed === 0 || rho === 0 || cd === 0 || area === 0) {
    return { x: 0, y: 0, z: 0 }
  }
  const magnitude = Math.min(0.5 * rho * cd * area * speed * speed, MAX_DRAG_FORCE)
  const scale = -magnitude / speed
  // Normalize -0 to +0 for clean downstream telemetry and comparisons.
  const clean = (value: number): number => (value === 0 ? 0 : value)
  return { x: clean(rel.x * scale), y: clean(rel.y * scale), z: clean(rel.z * scale) }
}

/**
 * Compass wind setting to world-frame air-velocity vector. Direction follows
 * the meteorological convention "direction FROM which the wind blows", in
 * degrees clockwise from north (-Z): 0 = from north (blowing toward +Z),
 * 90 = from east (+X), 180 = from south, 270 = from west. Pure.
 */
export function compassToWindVector(speedMps: number, directionFromDeg: number): Vector3 {
  const speed = Math.min(Math.max(sanitizeFinite(speedMps), 0), MAX_WIND_SPEED)
  const radians = (sanitizeFinite(directionFromDeg) * Math.PI) / 180
  // "From" direction unit vector; air flows toward its negation.
  const fromX = Math.sin(radians)
  const fromZ = -Math.cos(radians)
  const x = -fromX * speed
  const z = -fromZ * speed
  return { x: Math.abs(x) < 1e-12 ? 0 : x, y: 0, z: Math.abs(z) < 1e-12 ? 0 : z }
}

/** Non-finite values become 0; used where a bad input must not poison physics. */
export function sanitizeFinite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** Non-finite or negative values become 0 (for densities, areas, coefficients). */
export function sanitizeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}
