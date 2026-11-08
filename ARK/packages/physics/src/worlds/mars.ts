import { definePlanet, type PlanetConfig } from './PlanetConfig'

/**
 * Mars environment: reduced gravity, thin-atmosphere reference values, rugged
 * cratered regolith terrain, dust-tinted sky.
 */
export const MARS_CONFIG: PlanetConfig = definePlanet({
  id: 'mars',
  displayName: 'Mars',
  gravity: 3.71,
  solarConstantWm2: 586,
  temperature: { baseline: 213.15, min: 150, max: 300 },
  atmosphere: {
    density: 0.02,
    pressure: 600,
    reference: 'surface reference values',
  },
  terrain: {
    width: 200,
    depth: 200,
    subdivisions: 160,
    amplitude: 9,
    baseHeight: 0,
    noiseScale: 0.02,
    octaves: 5,
    roughness: 0.65,
    craterCount: 9,
    craterMinRadius: 5,
    craterMaxRadius: 18,
    craterDepthScale: 0.25,
  },
  surfaceRules: [
    { material: 'rock', minSlope: 0.7 },
    { material: 'sand', maxHeight: -2.5 },
    { material: 'regolith' },
  ],
  terrainFriction: 0.7,
  terrainRestitution: 0.25,
  lighting: {
    sunColor: 0xffd9b3,
    sunIntensity: 2.0,
    sunPosition: { x: -55, y: 70, z: 40 },
    hemiSky: 0xd8a075,
    hemiGround: 0x4a2418,
    hemiIntensity: 0.85,
    background: 0xc98a5e,
    fogColor: 0xcf9266,
    fogNear: 70,
    fogFar: 380,
    shadowExtent: 70,
  },
  camera: {
    offset: { x: 18, y: 14, z: 24 },
    targetHeight: 1,
    minDistance: 2,
    maxDistance: 150,
    maxPolarAngle: 1.53,
  },
  defaultSeed: 7111973,
  description: 'Red-planet terrain patch: rugged ridges and impact craters in regolith.',
})
