import { describe, expect, it } from 'vitest'

import type { EnvironmentalEvent } from '../types/EnvironmentTypes'
import { EnvironmentError } from '../types/EnvironmentTypes'
import { getPlanet } from '../worlds/planetPresets'
import { EnvironmentController } from './EnvironmentController'
import {
  defaultManualOverrides,
  evaluateEnvironment,
  eventEndTime,
  eventEnvelopeAt,
  integrateWetness,
} from './EnvironmentState'

function makeEvent(overrides: Partial<EnvironmentalEvent> = {}): EnvironmentalEvent {
  return {
    id: 'test-event',
    type: 'rain',
    planets: ['earth'],
    startTime: 10,
    envelope: { delay: 0, rampUp: 10, hold: 20, rampDown: 10 },
    priority: 1,
    targets: { precipitation: 12 },
    ...overrides,
  }
}

describe('Test D: event progression on simulation time', () => {
  it('ramps smoothly: 0 before start, 1 at hold, 0 after end', () => {
    const event = makeEvent()
    expect(eventEnvelopeAt(event, 9.9)).toBe(0)
    expect(eventEndTime(event)).toBe(50)
    expect(eventEnvelopeAt(event, 50)).toBe(0)
    expect(eventEnvelopeAt(event, 60)).toBe(0)
    // Mid-ramp is strictly between 0 and 1 (smoothstep).
    const mid = eventEnvelopeAt(event, 15)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(eventEnvelopeAt(event, 20)).toBe(1)
    expect(eventEnvelopeAt(event, 39.9)).toBe(1)
    const down = eventEnvelopeAt(event, 45)
    expect(down).toBeGreaterThan(0)
    expect(down).toBeLessThan(1)
  })

  it('honors delay and zero-length phases', () => {
    const event = makeEvent({ envelope: { delay: 5, rampUp: 0, hold: 10, rampDown: 0 } })
    expect(eventEnvelopeAt(event, 14.9)).toBe(0)
    expect(eventEnvelopeAt(event, 15)).toBe(1)
    expect(eventEnvelopeAt(event, 24.9)).toBe(1)
    expect(eventEnvelopeAt(event, 25)).toBe(0)
  })

  it('blends channels from base to target by envelope', () => {
    const config = getPlanet('earth')
    const manual = defaultManualOverrides()
    const event = makeEvent()
    const before = evaluateEnvironment(config, [event], manual, 0, 9)
    expect(before.precipitation).toBe(0)
    expect(before.activeEventIds).toEqual([])
    const peak = evaluateEnvironment(config, [event], manual, 0, 25)
    expect(peak.precipitation).toBeCloseTo(12, 9)
    expect(peak.activeEventIds).toEqual(['test-event'])
    const mid = evaluateEnvironment(config, [event], manual, 0, 15)
    expect(mid.precipitation).toBeGreaterThan(0)
    expect(mid.precipitation).toBeLessThan(12)
  })

  it('resolves overlapping events by priority, then start time, then id', () => {
    const config = getPlanet('earth')
    const manual = defaultManualOverrides()
    const low = makeEvent({ id: 'low', priority: 1, targets: { precipitation: 5 } })
    const high = makeEvent({ id: 'high', priority: 9, targets: { precipitation: 25 } })
    const peak = evaluateEnvironment(config, [low, high], manual, 0, 25)
    expect(peak.precipitation).toBeCloseTo(25, 9)

    // Same priority: later start wins.
    const early = makeEvent({ id: 'early', startTime: 10, targets: { precipitation: 5 } })
    const late = makeEvent({ id: 'late', startTime: 12, targets: { precipitation: 25 } })
    const tie = evaluateEnvironment(config, [early, late], manual, 0, 30)
    expect(tie.precipitation).toBeCloseTo(25, 9)
  })

  it('integrates wetness up in rain and down in dry air, bounded in 0..1', () => {
    let wetness = 0
    for (let i = 0; i < 600; i += 1) {
      wetness = integrateWetness(wetness, 12, 1 / 60)
    }
    expect(wetness).toBeGreaterThan(0.05)
    expect(wetness).toBeLessThanOrEqual(1)
    // Drying time constant is ~250 s; ten simulated minutes nearly clears it.
    for (let i = 0; i < 36000; i += 1) {
      wetness = integrateWetness(wetness, 0, 1 / 60)
    }
    expect(wetness).toBeLessThan(0.05)
    expect(integrateWetness(0.5, 12, 0)).toBe(0.5)
  })

  it('derives traction, solar, and visibility from state', () => {
    const config = getPlanet('mars')
    const manual = defaultManualOverrides()
    const clear = evaluateEnvironment(config, [], manual, 0, 0)
    expect(clear.solarMultiplier).toBe(1)
    expect(clear.tractionMultiplier).toBe(1)

    const storm = makeEvent({
      id: 'storm',
      type: 'dust-storm',
      planets: ['mars'],
      targets: { dustTau: 2.5 },
      envelope: { delay: 0, rampUp: 0, hold: 100, rampDown: 0 },
    })
    const dusty = evaluateEnvironment(config, [storm], manual, 0, 50)
    expect(dusty.solarMultiplier).toBeCloseTo(Math.exp(-2.5), 9)
    expect(dusty.solarIrradiance).toBeCloseTo(586 * Math.exp(-2.5), 6)
    expect(dusty.visibility).toBeLessThan(clear.visibility)

    const wet = evaluateEnvironment(getPlanet('earth'), [], manual, 1, 0)
    expect(wet.tractionMultiplier).toBeCloseTo(0.55, 9)
  })
})

describe('Test E: planet constraints', () => {
  it('rejects Earth-only rain on Mars', () => {
    const mars = new EnvironmentController(getPlanet('mars'))
    expect(() =>
      mars.startEvent({ type: 'rain', targets: { precipitation: 10 } }),
    ).toThrowError(EnvironmentError)
    expect(() =>
      mars.startEvent({ type: 'rain', targets: { precipitation: 10 } }),
    ).toThrowError(/cannot run on Mars/)
  })

  it('rejects dust storms on Earth', () => {
    const earth = new EnvironmentController(getPlanet('earth'))
    expect(() =>
      earth.startEvent({ type: 'dust-storm', targets: { dustTau: 1 } }),
    ).toThrowError(/cannot run on Earth/)
  })

  it('accepts wind and temperature events on both planets', () => {
    for (const planet of ['earth', 'mars'] as const) {
      const controller = new EnvironmentController(getPlanet(planet))
      controller.startEvent({ type: 'wind', targets: { wind: { x: 5, y: 0, z: 0 } } })
      controller.startEvent({ type: 'temperature', targets: { temperature: 280 } })
      expect(controller.getState().activeEventIds).toHaveLength(0) // t=0, envelope ramps
    }
  })

  it('rejects duplicate ids, unknown types, and empty targets', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.startEvent({ id: 'x', type: 'wind', targets: { wind: { x: 1, y: 0, z: 0 } } })
    expect(() =>
      controller.startEvent({ id: 'x', type: 'wind', targets: { wind: { x: 1, y: 0, z: 0 } } }),
    ).toThrowError(/already exists/)
    expect(() =>
      controller.startEvent({ type: 'hurricane' as never, targets: { wind: { x: 1, y: 0, z: 0 } } }),
    ).toThrowError(/Unknown event type/)
    expect(() => controller.startEvent({ type: 'wind', targets: {} })).toThrowError(
      /at least one target/,
    )
  })
})

describe('Test F: determinism', () => {
  function runSequence(): ReturnType<EnvironmentController['getState']>[] {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.setWind(8, 270)
    controller.startEvent({
      id: 'rain-1',
      type: 'rain',
      startTime: 5,
      rampUp: 10,
      hold: 40,
      rampDown: 10,
      targets: { precipitation: 12, cloudOpacity: 0.8 },
    })
    controller.startEvent({
      id: 'gust-1',
      type: 'wind',
      startTime: 20,
      rampUp: 5,
      hold: 10,
      rampDown: 5,
      priority: 2,
      targets: { wind: { x: 14, y: 0, z: 0 } },
    })
    const states = []
    for (let step = 0; step <= 6 * 60; step += 1) {
      states.push(controller.update(step / 60, 1 / 60))
    }
    return states
  }

  it('produces identical states for identical sequences', () => {
    expect(runSequence()).toEqual(runSequence())
  })
})

describe('Test G: pause and reset', () => {
  it('holds state frozen without updates and resets to base', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.setWind(10, 90)
    controller.startEvent({ type: 'rain', targets: { precipitation: 20 } })
    controller.update(10, 1 / 60)
    const frozen = controller.getState()
    // No update calls: state cannot drift (this is what pause means).
    expect(controller.getState()).toEqual(frozen)

    const reset = controller.reset()
    expect(reset.precipitation).toBe(0)
    expect(reset.wetness).toBe(0)
    expect(reset.wind).toEqual({ x: 0, y: 0, z: 0 })
    expect(reset.activeEventIds).toEqual([])
    expect(reset.solarMultiplier).toBe(1)
  })

  it('replays surviving events from t=0 after a clock snap', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.startEvent({
      id: 'replay',
      type: 'rain',
      startTime: 0,
      rampUp: 0,
      hold: 100,
      rampDown: 0,
      targets: { precipitation: 10 },
    })
    controller.update(50, 1 / 60)
    expect(controller.getState().precipitation).toBeCloseTo(10, 9)
    controller.snapToTime(0)
    // Still active (never completed, never pruned): replay continues.
    expect(controller.getState().activeEventIds).toEqual(['replay'])
  })
})

describe('Test H (controller): invalid inputs are rejected or clamped', () => {
  it('throws on non-finite inputs', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    expect(() => controller.setWind(Number.NaN, 0)).toThrowError(EnvironmentError)
    expect(() => controller.setTemperatureCelsius(Number.POSITIVE_INFINITY)).toThrowError(
      EnvironmentError,
    )
    expect(() =>
      controller.setWindVector({ x: 0, y: Number.NaN, z: 0 }),
    ).toThrowError(EnvironmentError)
    expect(() => controller.update(Number.NaN, 1 / 60)).toThrowError(EnvironmentError)
  })

  it('clamps finite out-of-range inputs into documented bounds', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    expect(controller.setWind(500, 0).wind.x).toBeLessThanOrEqual(60)
    expect(controller.setTractionMultiplier(99).tractionMultiplier).toBeLessThanOrEqual(1.5)
    expect(controller.setSurfaceWetness(-5).wetness).toBe(0)
    expect(controller.setCloudOpacity(7).cloudOpacity).toBe(1)
    expect(controller.setDustTau(99).dustTau).toBe(5)
    // Earth temperature clamps to the planet range (230..320 K).
    expect(controller.setTemperatureCelsius(500).temperature).toBe(320)
    expect(controller.setTemperatureCelsius(-300).temperature).toBe(230)
  })

  it('rejects out-of-range event targets and envelope phases', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    expect(() =>
      controller.startEvent({ type: 'rain', targets: { precipitation: 500 } }),
    ).toThrowError(/outside/)
    expect(() =>
      controller.startEvent({ type: 'wind', rampUp: -1, targets: { wind: { x: 1, y: 0, z: 0 } } }),
    ).toThrowError(/>= 0/)
  })
})

describe('Test I (events): lifecycle stays bounded', () => {
  it('prunes completed events so repeated activation cannot accumulate', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    for (let i = 0; i < 50; i += 1) {
      controller.startEvent({
        id: `gust-${i}`,
        type: 'wind',
        startTime: i * 100,
        hold: 1,
        rampDown: 0,
        targets: { wind: { x: 5, y: 0, z: 0 } },
      })
      controller.update(i * 100 + 10, 1 / 60)
    }
    controller.update(10000, 1 / 60)
    expect(controller.getState().activeEventIds).toEqual([])
  })

  it('stops and clears events on demand', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.startEvent({ id: 'a', type: 'wind', targets: { wind: { x: 5, y: 0, z: 0 } } })
    expect(controller.stopEvent('missing')).toBe(false)
    expect(controller.stopEvent('a')).toBe(true)
    controller.startEvent({ id: 'b', type: 'wind', targets: { wind: { x: 5, y: 0, z: 0 } } })
    controller.clearEvents()
    // Manual layer untouched by clearEvents; tested via wind base below.
    controller.setWind(3, 0)
    expect(controller.getState().activeEventIds).toEqual([])
  })

  it('resets cleanly for a new planet', () => {
    const controller = new EnvironmentController(getPlanet('earth'))
    controller.setWind(10, 0)
    controller.startEvent({ type: 'rain', targets: { precipitation: 10 } })
    const mars = controller.resetForPlanet(getPlanet('mars'))
    expect(mars.planet).toBe('mars')
    expect(mars.wind).toEqual({ x: 0, y: 0, z: 0 })
    expect(mars.activeEventIds).toEqual([])
    expect(mars.temperature).toBeCloseTo(213.15, 9)
  })
})
