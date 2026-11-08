import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import type { EnvironmentState } from '../types/EnvironmentTypes'
import { WeatherRenderer } from './WeatherRenderer'

function makeState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return {
    planet: 'earth',
    simTime: 0,
    airDensity: 1.225,
    pressure: 101325,
    wind: { x: 0, y: 0, z: 0 },
    temperature: 288.15,
    precipitation: 0,
    cloudOpacity: 0,
    dustTau: 0,
    wetness: 0,
    tractionMultiplier: 1,
    solarMultiplier: 1,
    solarIrradiance: 1361,
    visibility: 15000,
    aeroEnabled: true,
    activeEventIds: [],
    ...overrides,
  }
}

describe('Test I (weather): particle lifecycle stays bounded', () => {
  it('adds exactly two point clouds and removes them on dispose', () => {
    const scene = new THREE.Scene()
    const weather = new WeatherRenderer(scene, 'low')
    expect(scene.children.length).toBe(2)
    expect(weather.particleCounts).toEqual({ rain: 600, dust: 800 })
    weather.dispose()
    expect(scene.children.length).toBe(0)
  })

  it('shows rain only with precipitation and keeps positions finite', () => {
    const scene = new THREE.Scene()
    const weather = new WeatherRenderer(scene, 'low')
    try {
      const center = { x: 10, y: 5, z: -7 }
      weather.update(0.016, makeState({ precipitation: 12, wind: { x: 5, y: 0, z: 0 } }), center)
      const rain = scene.children[0] as THREE.Points
      expect(rain.visible).toBe(true)
      const positions = rain.geometry.getAttribute('position')
      for (let i = 0; i < positions.count; i += 1) {
        expect(Number.isFinite(positions.getX(i))).toBe(true)
        expect(Number.isFinite(positions.getY(i))).toBe(true)
        expect(Number.isFinite(positions.getZ(i))).toBe(true)
      }
      weather.update(0.016, makeState(), center)
      expect(rain.visible).toBe(false)
    } finally {
      weather.dispose()
    }
  })

  it('shows dust only with dust opacity and rebuilds quality without growth', () => {
    const scene = new THREE.Scene()
    const weather = new WeatherRenderer(scene, 'low')
    try {
      const center = { x: 0, y: 0, z: 0 }
      weather.update(0.016, makeState({ dustTau: 2, wind: { x: 8, y: 0, z: 0 } }), center)
      expect((scene.children[1] as THREE.Points).visible).toBe(true)
      weather.setQuality('high')
      expect(scene.children.length).toBe(2)
      expect(weather.particleCounts).toEqual({ rain: 2200, dust: 2600 })
      weather.setQuality('high')
      expect(scene.children.length).toBe(2)
    } finally {
      weather.dispose()
    }
  })
})
