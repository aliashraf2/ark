import { describe, expect, it, vi } from 'vitest'

import type { StartEventSpec } from '../../../../../packages/physics/src/environment/EnvironmentController'
import type { PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import { CommandDispatcher, type CommandExecutor } from './CommandDispatcher'
import type { WorldStateSnapshot } from './MissionTypes'
import { normalizeCommand, type NormalizedCommand } from './WorldCommands'

function makeWorldState(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    planet: 'earth',
    planetDisplayName: 'Earth',
    simTime: 10,
    status: 'running',
    gravity: { x: 0, y: -9.81, z: 0 },
    sphere: { position: { x: 0, y: 1, z: 0 }, velocityY: 0 },
    box: null,
    environment: {
      planet: 'earth',
      simTime: 10,
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
    },
    seed: 1,
    profileId: 'rolling-hills',
    ...overrides,
  }
}

function makeExecutor(overrides: Partial<CommandExecutor> = {}): CommandExecutor & { calls: string[] } {
  const calls: string[] = []
  const record = (name: string) => calls.push(name)
  return {
    calls,
    switchPlanet: (_planet: PlanetId) => record(`switch:${_planet}`),
    regenerateTerrain: (_seed?: number) => record(`regen:${_seed}`),
    setGravity: (_magnitude: number) => record(`gravity:${_magnitude}`),
    setWind: (speed: number, dir: number) => record(`wind:${speed},${dir}`),
    setTemperatureCelsius: (celsius: number) => record(`temp:${celsius}`),
    setTractionMultiplier: (multiplier: number) => record(`traction:${multiplier}`),
    startEvent: (_spec: StartEventSpec) => record(`event:${_spec.type}`),
    stopEvent: (id: string) => {
      record(`stop:${id}`)
      return true
    },
    setSolarMultiplier: (multiplier: number) => record(`solar:${multiplier}`),
    pause: () => record('pause'),
    resume: () => record('resume'),
    resetEnvironment: () => record('reset-env'),
    applyScenario: (id: string) => record(`scenario:${id}`),
    getWorldState: () => makeWorldState(),
    ...overrides,
  }
}

function mustNormalize(command: string, params: unknown, planet: PlanetId = 'earth'): NormalizedCommand {
  const proposal = normalizeCommand(command, params, planet, `test-${command}`)
  if (!proposal.normalized) throw new Error(`Test setup failed: ${proposal.validation.errors.join('; ')}`)
  return proposal.normalized
}

describe('CommandDispatcher', () => {
  it('reports an unavailable telemetry snapshot as a failed read', () => {
    const dispatcher = new CommandDispatcher(makeExecutor({ getWorldState: () => { throw new Error('offline') } }))
    expect(dispatcher.dispatch(mustNormalize('get_world_state', {})).outcome).toBe('failed')
  })
  it('reports missing weather events as failures rather than successful cancellation', () => {
    const dispatcher = new CommandDispatcher(makeExecutor({ stopEvent: () => false }))
    const result = dispatcher.dispatch(mustNormalize('stop_weather_event', { id: 'missing' }))
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('not active')
  })

  it('does not replay an operation that partially changed state and then threw', () => {
    const apply = vi.fn(() => { throw new Error('partial engine failure') })
    const dispatcher = new CommandDispatcher(makeExecutor({ pause: apply }))
    const command = mustNormalize('pause_simulation', {})
    expect(dispatcher.dispatch(command).outcome).toBe('failed')
    expect(dispatcher.dispatch(command).outcome).toBe('duplicate')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not touch physics if the before snapshot is unavailable', () => {
    const apply = vi.fn()
    const dispatcher = new CommandDispatcher(makeExecutor({ pause: apply, getWorldState: () => { throw new Error('offline') } }))
    expect(dispatcher.dispatch(mustNormalize('pause_simulation', {})).outcome).toBe('failed')
    expect(apply).not.toHaveBeenCalled()
  })

  it('does not report success when the post-execution snapshot is unavailable', () => {
    const snapshot = vi.fn().mockReturnValueOnce(makeWorldState()).mockImplementation(() => { throw new Error('offline') })
    const dispatcher = new CommandDispatcher(makeExecutor({ getWorldState: snapshot }))
    const result = dispatcher.dispatch(mustNormalize('pause_simulation', {}))
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('could not be verified')
  })
  it('executes validated commands through the executor', () => {
    const executor = makeExecutor()
    const dispatcher = new CommandDispatcher(executor)
    const result = dispatcher.dispatch(
      mustNormalize('set_wind', { speed_mps: 20, direction_from_deg: 270 }),
      { requestText: 'wind please' },
    )
    expect(result.outcome).toBe('executed')
    expect(executor.calls).toContain('wind:20,270')
    expect(dispatcher.history).toHaveLength(1)
    expect(dispatcher.history[0]?.requestText).toBe('wind please')
    expect(dispatcher.history[0]?.capability).toBe('set_wind')
  })

  it('is idempotent by command id', () => {
    const executor = makeExecutor()
    const dispatcher = new CommandDispatcher(executor)
    const normalized = mustNormalize('pause_simulation', {})
    expect(dispatcher.dispatch(normalized).outcome).toBe('executed')
    const replay = dispatcher.dispatch(normalized)
    expect(replay.outcome).toBe('duplicate')
    expect(executor.calls.filter((call) => call === 'pause')).toHaveLength(1)
    expect(dispatcher.history).toHaveLength(1)
  })

  it('converts executor failures into failed results with audit', () => {
    const executor = makeExecutor({
      setGravity: () => {
        throw new Error('gravity drive offline')
      },
    })
    const dispatcher = new CommandDispatcher(executor)
    const result = dispatcher.dispatch(mustNormalize('set_gravity', { magnitude_mps2: 5 }))
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/gravity drive offline/)
    expect(dispatcher.history).toHaveLength(1)
    expect(dispatcher.history[0]?.outcome).toBe('failed')
  })

  it('answers reads without mutating or auditing', () => {
    const executor = makeExecutor()
    const dispatcher = new CommandDispatcher(executor)
    const state = dispatcher.dispatch(mustNormalize('get_world_state', {}))
    expect(state.outcome).toBe('read')
    expect((state.data as WorldStateSnapshot).planet).toBe('earth')
    const caps = dispatcher.dispatch(mustNormalize('list_capabilities', {}))
    expect(caps.outcome).toBe('read')
    expect(Array.isArray(caps.data)).toBe(true)
    expect((caps.data as unknown[]).length).toBeGreaterThan(10)
    expect(executor.calls).toHaveLength(0)
    expect(dispatcher.history).toHaveLength(0)
  })

  it('replays a record from the recorded seed', () => {
    const executor = makeExecutor()
    const dispatcher = new CommandDispatcher(executor)
    const original = dispatcher.dispatch(
      mustNormalize('set_wind', { speed_mps: 12, direction_from_deg: 90 }),
      { requestText: 'original' },
    )
    expect(original.outcome).toBe('executed')
    const record = dispatcher.history[0]
    if (!record) throw new Error('missing audit record')
    const results = dispatcher.replay(record)
    expect(results.map((result) => result.command)).toEqual([
      'regenerate_terrain',
      'reset_environment',
      'set_wind',
    ])
    expect(executor.calls).toContain('regen:1')
    expect(results.every((result) => result.outcome === 'executed')).toBe(true)
  })
})
