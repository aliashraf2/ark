import { describe, expect, it } from 'vitest'

import { solarIrradianceForTau, solarMultiplierForTau } from './SolarSystem'

describe('Test C: solar attenuation', () => {
  it('returns full illumination at zero optical depth', () => {
    expect(solarMultiplierForTau(0)).toBe(1)
    expect(solarIrradianceForTau(1361, 0)).toBe(1361)
  })

  it('follows I = I0 * exp(-tau)', () => {
    expect(solarMultiplierForTau(1)).toBeCloseTo(Math.exp(-1), 12)
    expect(solarMultiplierForTau(2.5)).toBeCloseTo(Math.exp(-2.5), 12)
    expect(solarIrradianceForTau(586, 2)).toBeCloseTo(586 * Math.exp(-2), 9)
  })

  it('decreases monotonically with optical depth', () => {
    const samples = [0, 0.5, 1, 2, 3, 5].map(solarMultiplierForTau)
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThan(samples[i - 1] ?? 0)
    }
  })

  it('sanitizes invalid inputs instead of producing NaN', () => {
    expect(solarMultiplierForTau(Number.NaN)).toBe(1)
    expect(solarMultiplierForTau(-3)).toBe(1)
    expect(solarIrradianceForTau(Number.NaN, 1)).toBe(0)
  })
})
