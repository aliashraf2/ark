import { createNoise2D } from 'simplex-noise'

/** 2D noise sampler returning values in [-1, 1]. */
export type Noise2D = (x: number, y: number) => number

export type RandomFn = () => number

/**
 * Small seeded PRNG (mulberry32, public-domain algorithm). Used only to seed
 * noise permutation tables and deterministic placement — not a noise algorithm.
 */
export function mulberry32(seed: number): RandomFn {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic 2D simplex noise bound to a seed. Same seed => same field. */
export function createSeededNoise2D(seed: number): Noise2D {
  return createNoise2D(mulberry32(seed))
}

/**
 * Fractal Brownian motion. Pure: normalized to roughly [-1, 1] by the summed
 * octave amplitudes so `amplitude` keeps a stable physical meaning.
 */
export function fractalNoise2D(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amplitude = 1
  let frequency = 1
  let sum = 0
  let normalization = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * noise(x * frequency, y * frequency)
    normalization += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }
  return normalization === 0 ? 0 : sum / normalization
}

/**
 * Ridged fractal: sharp crests and valleys for rugged terrain. Normalized to
 * roughly [0, 1]; callers remap to a signed range when blending with fBm.
 */
export function ridgedNoise2D(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2.1,
  gain = 0.5,
): number {
  let amplitude = 1
  let frequency = 1
  let sum = 0
  let normalization = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    const sample = noise(x * frequency, y * frequency)
    const ridge = 1 - Math.abs(sample)
    sum += amplitude * ridge * ridge
    normalization += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }
  return normalization === 0 ? 0 : sum / normalization
}
