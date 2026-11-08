import {
  OBSERVATION_SIZE,
  OBSERVATION_SPEC,
  type RoverObservation,
} from '../../../physics/src/robotics/RoverConfig'

export { OBSERVATION_SIZE, OBSERVATION_SPEC }

/**
 * Observation bounds as typed arrays for the future Python bridge.
 * Order and ranges come from the canonical OBSERVATION_SPEC.
 */
export function observationBounds(): { low: Float32Array; high: Float32Array } {
  const low = new Float32Array(OBSERVATION_SIZE)
  const high = new Float32Array(OBSERVATION_SIZE)
  for (const entry of OBSERVATION_SPEC) {
    low[entry.index] = entry.range[0]
    high[entry.index] = entry.range[1]
  }
  return { low, high }
}

/** Copies an observation tuple into a fixed-size Float32Array. */
export function toFloat32Array(observation: RoverObservation): Float32Array {
  return new Float32Array(observation)
}
