import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ROVER_CONFIG,
  type DriveAction,
} from './RoverConfig'
import {
  addGaussianNoise,
  angleDifference,
  batteryReading,
  buildObservation,
  computeDrive,
  downhillYaw,
  eulerFromQuaternion,
  findSpawnSite,
  footprintSpawnHeight,
  forwardFromYaw,
  slopeMagnitude,
  goalDistanceXZ,
  headingControlAction,
  navigationReward,
  powerDrawW,
  rayDirectionFromBody,
  stepBatteryCharge,
  validateAction,
  type DriveContext,
} from './RoverDynamics'

const CONFIG = DEFAULT_ROVER_CONFIG

function driveContext(overrides: Partial<DriveContext> = {}): DriveContext {
  return {
    massKg: 25,
    gravityMps2: 9.80665,
    traction: 0.8,
    yawRad: 0,
    velocity: { x: 0, y: 0, z: 0 },
    dt: 1 / 60,
    chargeJ: 1000,
    ...overrides,
  }
}

describe('validateAction', () => {
  it('passes through valid actions', () => {
    expect(validateAction({ left: 0.5, right: -0.5, brake: false, eStop: false })).toEqual({
      left: 0.5,
      right: -0.5,
      brake: false,
      eStop: false,
      saturated: false,
    })
  })

  it('saturates out-of-range efforts and reports it', () => {
    const validated = validateAction({ left: 2, right: -3, brake: false, eStop: false })
    expect(validated.left).toBe(1)
    expect(validated.right).toBe(-1)
    expect(validated.saturated).toBe(true)
  })

  it.each([{ left: NaN }, { right: Infinity }, { left: '1' as unknown as number }])(
    'rejects invalid efforts %j',
    (bad) => {
      expect(() =>
        validateAction({ left: 0, right: 0, brake: false, eStop: false, ...bad }),
      ).toThrow()
    },
  )

  it('rejects non-boolean flags', () => {
    expect(() =>
      validateAction({ left: 0, right: 0, brake: 1 as unknown as boolean, eStop: false }),
    ).toThrow()
  })
})

describe('computeDrive', () => {
  it('drives forward along +Z at yaw 0 (Test C model)', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      driveContext(),
    )
    expect(output.force.z).toBeGreaterThan(0)
    expect(output.force.x).toBeCloseTo(0, 9)
    expect(output.torque.y).toBeCloseTo(0, 9)
    expect(output.snapStop).toBe(false)
  })

  it('limits force by traction: mu * m * g', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      // Low-traction regolith so the 80 N motor exceeds the traction budget.
      driveContext({ traction: 0.2 }),
    )
    expect(output.force.z).toBeCloseTo(0.2 * 25 * 9.80665, 6)
  })

  it('caps force at the motor limit on grippy ground', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      driveContext(),
    )
    // 2 * 40 N motor effort is below the 0.8 * 25 * 9.81 = 196 N budget.
    expect(output.force.z).toBeCloseTo(80, 6)
  })

  it('reduces traction on Mars gravity with no planet-specific code', () => {
    // Low traction so both planets bind on traction, not the motor cap.
    const earth = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      driveContext({ gravityMps2: 9.80665, traction: 0.3 }),
    )
    const mars = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      driveContext({ gravityMps2: 3.71, traction: 0.3 }),
    )
    expect(mars.force.z / earth.force.z).toBeCloseTo(3.71 / 9.80665, 6)
  })

  it('fades drive force toward top speed (motor curve)', () => {
    const action = validateAction({ left: 1, right: 1, brake: false, eStop: false })
    const stopped = computeDrive(CONFIG, action, driveContext())
    // v=4.5: curve 0.25 → 20 N drive minus 4.5 × 8.75 rolling resistance.
    const cruising = computeDrive(
      CONFIG,
      action,
      driveContext({ velocity: { x: 0, y: 0, z: 4.5 } }),
    )
    const topped = computeDrive(
      CONFIG,
      action,
      driveContext({ velocity: { x: 0, y: 0, z: 6 } }),
    )
    expect(cruising.force.z).toBeCloseTo(20 - 4.5 * 0.35 * 25, 6)
    expect(cruising.force.z).toBeLessThan(stopped.force.z)
    // At the cap the motor contributes nothing; resistance dominates.
    expect(topped.force.z).toBeCloseTo(-6 * 0.35 * 25, 6)
  })

  it('produces yaw torque from differential effort', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: -1, right: 1, brake: false, eStop: false }),
      driveContext(),
    )
    expect(output.force.z).toBeCloseTo(0, 9)
    expect(output.torque.y).toBeCloseTo(CONFIG.maxYawTorque, 9)
  })

  it('cuts drive when depleted but brakes still work', () => {
    const dead = driveContext({ chargeJ: 0, velocity: { x: 0, y: 0, z: 3 } })
    const drive = computeDrive(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
      dead,
    )
    // Rolling resistance only (negative z), no forward drive.
    expect(drive.force.z).toBeLessThan(0)
    const brake = computeDrive(
      CONFIG,
      validateAction({ left: 0, right: 0, brake: true, eStop: false }),
      dead,
    )
    expect(brake.force.z).toBeLessThan(drive.force.z)
  })

  it('snaps stopped wheels under brake', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: 0, right: 0, brake: true, eStop: false }),
      driveContext({ velocity: { x: 0.01, y: 0, z: 0.01 } }),
    )
    expect(output.snapStop).toBe(true)
  })

  it('opposes lateral slip (tire grip approximation)', () => {
    const output = computeDrive(
      CONFIG,
      validateAction({ left: 0, right: 0, brake: false, eStop: false }),
      driveContext({ velocity: { x: 2, y: 0, z: 0 } }),
    )
    expect(output.force.x).toBeLessThan(0)
  })
})

describe('orientation helpers', () => {
  it('extracts yaw from a yaw-only quaternion', () => {
    const yaw = 0.7
    const { yaw: recovered } = eulerFromQuaternion({
      x: 0,
      y: Math.sin(yaw / 2),
      z: 0,
      w: Math.cos(yaw / 2),
    })
    expect(recovered).toBeCloseTo(yaw, 9)
  })

  it('maps yaw 0 to +Z forward', () => {
    expect(forwardFromYaw(0)).toEqual({ x: 0, y: 0, z: 1 })
    const east = forwardFromYaw(Math.PI / 2)
    expect(east.x).toBeCloseTo(1, 9)
    expect(east.z).toBeCloseTo(0, 9)
  })

  it('wraps angle differences to [-PI, PI]', () => {
    expect(angleDifference(0, Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(angleDifference(Math.PI, 0)).toBeCloseTo(-Math.PI, 9)
    expect(angleDifference(3, -3)).toBeCloseTo(0.2832, 4)
  })

  it('measures slope and footprint height on a synthetic plane', () => {
    // Plane rising 0.5 m per meter toward +Z.
    const sample = (x: number, z: number) => 0.5 * z + 0.1 * x
    expect(slopeMagnitude(sample, 3, -7)).toBeCloseTo(Math.hypot(0.1, 0.5), 9)
    // Footprint on a slope: the drop height must clear the uphill wheels,
    // not just the center.
    const wheels = [
      { x: -0.34, z: 0.34 },
      { x: 0.34, z: 0.34 },
      { x: -0.34, z: -0.34 },
      { x: 0.34, z: -0.34 },
    ]
    const center = sample(0, 0)
    const drop = footprintSpawnHeight(sample, 0, 0, 0, wheels, 0.3)
    expect(drop).toBeCloseTo(center + 0.5 * 0.34 + 0.1 * 0.34 + 0.3, 9)
    expect(drop).toBeGreaterThan(center + 0.3)
  })

  it('finds a gentle site near a steep start', () => {
    // Flat disc of radius 5 around (10, 0), steep cone elsewhere.
    const sample = (x: number, z: number) => {
      const d = Math.hypot(x - 10, z)
      return d < 5 ? 0 : (d - 5) * 2
    }
    const steep = findSpawnSite(sample, 0, 0, 0.27, 30)
    expect(steep.slope).toBeLessThanOrEqual(0.27)
    expect(Math.hypot(steep.x - 10, steep.z)).toBeLessThan(5)
    // An already-gentle start stays put.
    const flat = findSpawnSite(sample, 10, 0, 0.27, 30)
    expect(flat.x).toBe(10)
    expect(flat.z).toBe(0)
  })

  it('faces downhill along the descent gradient', () => {
    // Ground rising toward +Z: downhill is -Z, i.e. yaw ±PI (atan2 gives -PI).
    expect(Math.abs(downhillYaw(0, 1))).toBeCloseTo(Math.PI, 9)
    // Ground rising toward +X: downhill is -X, i.e. yaw -PI/2.
    expect(downhillYaw(1, 0)).toBeCloseTo(-Math.PI / 2, 9)
    // Level ground keeps the fallback heading.
    expect(downhillYaw(0.001, 0.001, 0.5)).toBe(0.5)
  })
})

describe('energy model (Test G model)', () => {
  it('draws idle power at rest and peak power at full effort', () => {
    const idle = powerDrawW(
      CONFIG,
      validateAction({ left: 0, right: 0, brake: false, eStop: false }),
    )
    const full = powerDrawW(
      CONFIG,
      validateAction({ left: 1, right: 1, brake: false, eStop: false }),
    )
    expect(idle).toBe(CONFIG.idlePowerW)
    expect(full).toBe(CONFIG.idlePowerW + CONFIG.drivePowerW)
  })

  it('clamps charge at zero and reports depletion', () => {
    expect(stepBatteryCharge(1, 100, 1)).toBe(0)
    const reading = batteryReading(0, 100, 5)
    expect(reading.depleted).toBe(true)
    expect(reading.percent).toBe(0)
  })

  it('adds zero-mean gaussian noise deterministically with a seeded stream', () => {
    let seed = 42
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const samples = Array.from({ length: 2000 }, () => addGaussianNoise(5, 0.5, random))
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(mean).toBeCloseTo(5, 1)
    expect(addGaussianNoise(5, 0, random)).toBe(5)
  })
})

describe('observation + reward (Test L model)', () => {
  it('builds a 12-wide normalized observation', () => {
    const obs = buildObservation(CONFIG, {
      position: { x: 0, y: 0, z: 0 },
      yawRad: 0,
      speed: 4,
      yawRate: 0.5,
      ranges: CONFIG.sensorAngles.map((angleRad) => ({
        angleRad,
        distance: CONFIG.sensorRange,
        hit: false,
        validity: 'ok' as const,
      })),
      batteryPercent: 0.75,
      traction: 0.8,
      target: { x: 0, y: 0, z: 50 },
    })
    expect(obs).toHaveLength(12)
    expect(obs[0]).toBeCloseTo(0.5, 9)
    expect(obs[1]).toBeCloseTo(0, 9)
    expect(obs[3]).toBeCloseTo(0.5, 9)
    for (const value of obs) {
      expect(Number.isFinite(value)).toBe(true)
      expect(Math.abs(value)).toBeLessThanOrEqual(1)
    }
  })

  it('computes deterministic navigation rewards', () => {
    const weights = { progress: 2, success: 100, collision: -5, energy: -0.01, time: -0.2 }
    const first = navigationReward(10, 9, 5, 2, 0.05, false, weights)
    const second = navigationReward(10, 9, 5, 2, 0.05, false, weights)
    expect(first).toEqual(second)
    expect(first.progress).toBeCloseTo(2, 9)
    expect(first.successBonus).toBe(0)
    const won = navigationReward(1, 0.5, 5, 2, 0.05, true, weights)
    expect(won.successBonus).toBe(100)
    const crash = navigationReward(10, 9.9, 0.2, 2, 0.05, false, weights)
    expect(crash.collisionPenalty).toBe(-5)
  })

  it('measures goal distance on the XZ plane', () => {
    expect(goalDistanceXZ({ x: 0, y: 99, z: 0 }, { x: 3, y: -5, z: 4 })).toBe(5)
  })
})

describe('headingControlAction', () => {
  const gains = { heading: 1.6, yawDamping: 0.4, maxTurn: 0.85, cruise: 0.55 }

  it('brakes when arrived', () => {
    const action: DriveAction = headingControlAction(0, 0, 0, 10, true, gains)
    expect(action.brake).toBe(true)
    expect(action.left).toBe(0)
  })

  it('drives forward when aligned, turns when offset', () => {
    const aligned = headingControlAction(0, 0, 0, 10, false, gains)
    expect(aligned.left).toBeCloseTo(0.55, 9)
    expect(aligned.right).toBeCloseTo(0.55, 9)
    const left = headingControlAction(0, 0, Math.PI / 2, 10, false, gains)
    expect(left.right).toBeGreaterThan(left.left)
  })

  it('slows near obstacles', () => {
    const clear = headingControlAction(0, 0, 0, 10, false, gains)
    const blocked = headingControlAction(0, 0, 0, 0.5, false, gains)
    expect(blocked.left).toBeLessThan(clear.left)
  })

  it('brake-turns on large heading errors so slopes cannot drag it', () => {
    const spin = headingControlAction(0, 0, Math.PI, 10, false, gains)
    expect(spin.brake).toBe(true)
    expect(spin.right).toBeGreaterThan(spin.left)
    const cruise = headingControlAction(0, 0, 0.3, 10, false, gains)
    expect(cruise.brake).toBe(false)
    expect(cruise.left).toBeGreaterThan(0)
  })

  it('damps yaw rate and gates throttle while spinning', () => {
    // Same heading error, but spinning fast toward the target: the D term
    // must reduce the turn effort versus the static case.
    const still = headingControlAction(0, 0, 1, 10, false, gains)
    const spinning = headingControlAction(0, 3, 1, 10, false, gains)
    expect(spinning.right - spinning.left).toBeLessThan(still.right - still.left)
    // Full spin: no forward drive even when momentarily aligned, and the
    // D term counter-steers against the spin.
    const dizzy = headingControlAction(0, 2.5, 0, 10, false, gains)
    expect((dizzy.left + dizzy.right) / 2).toBeCloseTo(0, 9)
    expect(dizzy.left).toBeGreaterThan(dizzy.right)
  })
})

describe('rayDirectionFromBody', () => {
  it('matches yaw-only rays when the body is level', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 }
    for (const angle of [-0.7, 0, 0.35]) {
      const dir = rayDirectionFromBody(identity, angle)
      const flat = forwardFromYaw(angle)
      expect(dir.x).toBeCloseTo(flat.x, 9)
      expect(dir.y).toBeCloseTo(0, 9)
      expect(dir.z).toBeCloseTo(flat.z, 9)
    }
  })

  it('pitches rays with a nose-up body', () => {
    const theta = 0.3
    const noseUp = { x: -Math.sin(theta / 2), y: 0, z: 0, w: Math.cos(theta / 2) }
    const dir = rayDirectionFromBody(noseUp, 0)
    expect(dir.x).toBeCloseTo(0, 9)
    expect(dir.y).toBeCloseTo(Math.sin(theta), 9)
    expect(dir.z).toBeCloseTo(Math.cos(theta), 9)
  })

  it('yaws rays with the body and preserves unit length', () => {
    const yaw = Math.PI / 2
    const turned = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    const dir = rayDirectionFromBody(turned, 0)
    expect(dir.x).toBeCloseTo(1, 9)
    expect(dir.y).toBeCloseTo(0, 9)
    expect(dir.z).toBeCloseTo(0, 9)
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 9)
  })
})
