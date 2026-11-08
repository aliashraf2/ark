/**
 * Shared solar illumination model. Simplified Beer–Lambert attenuation,
 * I = I0 * exp(-tau): this is a physically motivated approximation, NOT a
 * detailed radiative-transfer simulation. All functions are pure.
 */

/** Relative illumination 0..1 for an effective optical depth tau >= 0. */
export function solarMultiplierForTau(opticalDepth: number): number {
  const tau = Number.isFinite(opticalDepth) && opticalDepth > 0 ? opticalDepth : 0
  return Math.exp(-tau)
}

/** Estimated surface irradiance in W/m^2 from a top-of-atmosphere constant. */
export function solarIrradianceForTau(solarConstantWm2: number, opticalDepth: number): number {
  const constant = Number.isFinite(solarConstantWm2) && solarConstantWm2 > 0 ? solarConstantWm2 : 0
  return constant * solarMultiplierForTau(opticalDepth)
}
