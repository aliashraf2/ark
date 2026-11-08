import { describe, expect, it } from 'vitest'

import {
  compassToWindVector,
  computeDragForce,
  MAX_DRAG_FORCE,
} from './environmentalForces'

const SPHERE = { dragCoefficient: 0.47, area: Math.PI * 0.25 }

describe('Test A: drag scales linearly with atmospheric density', () => {
  it('produces ~1/60 the force on Mars vs Earth for identical conditions', () => {
    const bodyVelocity = { x: 0, y: -5, z: 0 }
    const wind = { x: 0, y: 0, z: 0 }
    const earth = computeDragForce(1.225, SPHERE, bodyVelocity, wind)
    const mars = computeDragForce(0.02, SPHERE, bodyVelocity, wind)
    const earthMag = Math.hypot(earth.x, earth.y, earth.z)
    const marsMag = Math.hypot(mars.x, mars.y, mars.z)
    expect(earthMag).toBeGreaterThan(0)
    // Linearity in rho: ratio equals the density ratio.
    expect(marsMag / earthMag).toBeCloseTo(0.02 / 1.225, 6)
  })

  it('matches the quadratic drag formula magnitude', () => {
    const force = computeDragForce(1.225, SPHERE, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    const expected = 0.5 * 1.225 * 0.47 * (Math.PI * 0.25) * 100
    expect(Math.hypot(force.x, force.y, force.z)).toBeCloseTo(expected, 6)
  })

  it('yields zero force when body and air move together', () => {
    const wind = { x: 12, y: 0, z: -3 }
    expect(computeDragForce(1.225, SPHERE, { ...wind }, wind)).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('Test B: drag opposes velocity relative to the air', () => {
  it('pushes a still body downwind', () => {
    const force = computeDragForce(1.225, SPHERE, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
    expect(force.x).toBeGreaterThan(0)
    expect(force.y).toBe(0)
    expect(force.z).toBe(0)
  })

  it('opposes supersonic-relative motion along an arbitrary axis', () => {
    const force = computeDragForce(
      1.225,
      SPHERE,
      { x: 3, y: -20, z: 1 },
      { x: 3, y: 5, z: 1 },
    )
    // v_rel = (0, -25, 0): drag must point +Y.
    expect(force.x).toBe(0)
    expect(force.y).toBeGreaterThan(0)
    expect(force.z).toBe(0)
  })

  it('maps compass settings to the documented world-frame convention', () => {
    // North is -Z: wind FROM the west (270 deg) moves air toward +X, etc.
    expect(compassToWindVector(10, 270)).toEqual({ x: 10, y: 0, z: 0 })
    expect(compassToWindVector(10, 90)).toEqual({ x: -10, y: 0, z: 0 })
    expect(compassToWindVector(10, 0)).toEqual({ x: 0, y: 0, z: 10 })
    expect(compassToWindVector(10, 180)).toEqual({ x: 0, y: 0, z: -10 })
  })
})

describe('Test H (forces): invalid inputs stay finite and bounded', () => {
  it('sanitizes NaN, Infinity, and negative physical parameters to zero force', () => {
    const bad = { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 0 }
    expect(computeDragForce(1.225, SPHERE, bad, { x: 0, y: 0, z: 0 })).toEqual({
      x: 0,
      y: 0,
      z: 0,
    })
    expect(
      computeDragForce(Number.NaN, SPHERE, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    ).toEqual({ x: 0, y: 0, z: 0 })
    expect(
      computeDragForce(1.225, { dragCoefficient: -2, area: 1 }, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    ).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('clamps extreme forces to a finite ceiling', () => {
    const force = computeDragForce(
      1000,
      { dragCoefficient: 10, area: 100 },
      { x: 1000, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    )
    expect(Math.hypot(force.x, force.y, force.z)).toBeLessThanOrEqual(MAX_DRAG_FORCE)
    expect(Number.isFinite(force.x)).toBe(true)
  })

  it('clamps compass wind speed into range', () => {
    expect(compassToWindVector(500, 270).x).toBeLessThanOrEqual(60)
    expect(compassToWindVector(-5, 270)).toEqual({ x: 0, y: 0, z: 0 })
  })
})
