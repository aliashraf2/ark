import { describe, expect, it } from 'vitest'

import { validatePlanetConfig } from './PlanetConfig'
import { EARTH_CONFIG } from './earth'
import { MARS_CONFIG } from './mars'
import {
  defaultProfileForPlanet,
  getPlanet,
  profilesForPlanet,
  resolveTerrainParams,
} from './planetPresets'

describe('Test A: planet configurations', () => {
  it('uses Earth gravity 9.80665 m/s^2', () => {
    expect(EARTH_CONFIG.gravity).toBe(9.80665)
  })

  it('uses Mars gravity ~3.71 m/s^2', () => {
    expect(MARS_CONFIG.gravity).toBeCloseTo(3.71, 2)
  })

  it('carries representative atmospheres in SI units', () => {
    expect(EARTH_CONFIG.atmosphere.pressure).toBe(101325)
    expect(EARTH_CONFIG.atmosphere.density).toBe(1.225)
    expect(MARS_CONFIG.atmosphere.pressure).toBe(600)
    expect(MARS_CONFIG.atmosphere.density).toBeCloseTo(0.02, 3)
  })

  it('passes validation with legal dimensions and parameters', () => {
    expect(validatePlanetConfig(EARTH_CONFIG)).toEqual([])
    expect(validatePlanetConfig(MARS_CONFIG)).toEqual([])
  })

  it('rejects invalid configurations', () => {
    expect(validatePlanetConfig({ ...EARTH_CONFIG, gravity: -1 }).length).toBeGreaterThan(0)
    expect(
      validatePlanetConfig({
        ...MARS_CONFIG,
        terrain: { ...MARS_CONFIG.terrain, subdivisions: 4 },
      }).length,
    ).toBeGreaterThan(0)
  })

  it('is immutable after creation', () => {
    expect(Object.isFrozen(EARTH_CONFIG)).toBe(true)
    expect(Object.isFrozen(EARTH_CONFIG.terrain)).toBe(true)
    expect(Object.isFrozen(MARS_CONFIG)).toBe(true)
    expect(Object.isFrozen(MARS_CONFIG.lighting)).toBe(true)
  })

  it('resolves the planet registry and terrain profiles', () => {
    expect(getPlanet('earth')).toBe(EARTH_CONFIG)
    expect(getPlanet('mars')).toBe(MARS_CONFIG)
    expect(profilesForPlanet('earth').length).toBeGreaterThanOrEqual(2)
    expect(profilesForPlanet('mars').length).toBeGreaterThanOrEqual(2)

    const plains = resolveTerrainParams(EARTH_CONFIG, 'plains')
    expect(plains.amplitude).toBeLessThan(EARTH_CONFIG.terrain.amplitude)
    // Base config is untouched by profile resolution.
    expect(EARTH_CONFIG.terrain.amplitude).toBe(12)

    const fallback = resolveTerrainParams(MARS_CONFIG)
    expect(fallback.craterCount).toBe(MARS_CONFIG.terrain.craterCount)
    expect(defaultProfileForPlanet('mars').id).toBe('cratered-plains')
    expect(() => resolveTerrainParams(EARTH_CONFIG, 'nope')).toThrow()
  })
})
