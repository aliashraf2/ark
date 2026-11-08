import { definePlanet, type PlanetConfig } from './PlanetConfig'

/**
 * Earth environment: standard gravity, sea-level reference atmosphere, rolling
 * hills with grass/soil/sand/rock cover, blue daylight sky.
 */
export const EARTH_CONFIG: PlanetConfig = definePlanet({
  id: 'earth',
  displayName: 'Earth',
  gravity: 9.80665,
  atmosphere: {
    density: 1.225,
    pressure: 101325,
    reference: 'sea-level reference values',
  },
  terrain: {
    width: 200,
    depth: 200,
    subdivisions: 160,
    amplitude: 12,
    baseHeight: 0,
    noiseScale: 0.015,
    octaves: 5,
    roughness: 0.15,
    craterCount: 0,
    craterMinRadius: 5,
    craterMaxRadius: 15,
    craterDepthScale: 0.18,
  },
  surfaceRules: [
    { material: 'rock', minSlope: 0.55 },
    { material: 'sand', maxHeight: -3 },
    { material: 'soil', minSlope: 0.3 },
    { material: 'grass' },
  ],
  terrainFriction: 0.8,
  terrainRestitution: 0.35,
  lighting: {
    sunColor: 0xfff3e0,
    sunIntensity: 2.2,
    sunPosition: { x: 60, y: 90, z: 30 },
    hemiSky: 0xbfd9ff,
    hemiGround: 0x33402e,
    hemiIntensity: 0.9,
    background: 0x8fb8dd,
    fogColor: 0x9dc0dd,
    fogNear: 90,
    fogFar: 420,
    shadowExtent: 70,
  },
  camera: {
    offset: { x: 18, y: 14, z: 24 },
    targetHeight: 1,
    minDistance: 2,
    maxDistance: 150,
    maxPolarAngle: 1.53,
  },
  defaultSeed: 20260207,
  description: 'Blue-marble terrain patch: rolling hills, valleys, and rocky outcrops.',
})
