// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentController } from '../../../../../packages/physics/src/environment/EnvironmentController'
import { getPlanet } from '../../../../../packages/physics/src/worlds/planetPresets'
import type { PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
import type { SimulationEngine } from '../core/SimulationEngine'
import type { WorldStateSnapshot } from './MissionTypes'

const voice = vi.hoisted(() => ({
  committed: null as null | ((text: string, requestId: string) => void),
  stop: null as null | (() => void),
  speak: vi.fn(async (_text: string) => {}),
}))

vi.mock('./voice/VoiceSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice/VoiceSession')>()
  return { ...actual, VoiceSession: class {
    constructor(_url: string, _state: unknown, onCommitted: typeof voice.committed, onStop: typeof voice.stop) {
      voice.committed = onCommitted
      voice.stop = onStop
    }
    speak = voice.speak
    setPhase() {}
    stop() { voice.stop?.() }
  } }
})

import MissionPanel from './MissionPanel.svelte'

function engineFixture() {
  let planet: PlanetId = 'earth'
  const environment = new EnvironmentController(getPlanet(planet))
  const engine = {
    switchPlanet: vi.fn((target: PlanetId) => { planet = target; environment.resetForPlanet(getPlanet(target)) }),
    setWind: vi.fn((speed: number, direction: number) => environment.setWind(speed, direction)),
    startEvent: vi.fn((spec: Parameters<EnvironmentController['startEvent']>[0]) => environment.startEvent(spec)),
    setSolarMultiplier: vi.fn((value: number) => environment.setSolarMultiplier(value)),
    stopEvent: vi.fn((id: string) => environment.stopEvent(id)),
    pause: vi.fn(),
    getWorldState: (): WorldStateSnapshot => ({
      planet, planetDisplayName: planet, simTime: 0, status: 'running',
      gravity: { x: 0, y: -getPlanet(planet).gravity, z: 0 },
      sphere: { position: { x: 0, y: 1, z: 0 }, velocityY: 0 }, box: null,
      environment: environment.getState(), seed: 42, profileId: 'rolling-hills',
    }),
  }
  return { engine, environment }
}

function backend(command = 'set_wind', params: Record<string, unknown> = { speed_mps: 15, direction_from_deg: 270 }) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ path, body })
    let value: unknown
    if (path.endsWith('/health')) value = { status: 'ok', llm_configured: true }
    else if (path.endsWith('/capabilities')) value = { capabilities: [{ name: command, kind: 'registered' }] }
    else if (path.endsWith('/interpret')) value = {
      request_id: body.request_id, status: 'proposed', message: '', capability_ids: [command],
      actions: [{ command_id: `${String(body.request_id)}-command`, command, params,
        requires_confirmation: false, reversible: true, warnings: [], rationale: 'Test' }],
    }
    else value = { request_id: body.request_id, reply: 'Verified reply from simulator acknowledgement.' }
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  return { requests, fetcher }
}

async function mountPanel() {
  const fixture = engineFixture()
  render(MissionPanel, { engine: fixture.engine as unknown as SimulationEngine })
  await screen.findByText('LINKED · LLM READY')
  return fixture
}

beforeEach(() => {
  voice.speak.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('typed and spoken Mission Control converge on the same pipeline', () => {
  it('offers Muse in Agent Link and sends the selected provider and key to the backend', async () => {
    const api = backend()
    const original = api.fetcher.getMockImplementation()!
    let submitted: Record<string, unknown> | null = null
    api.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/configure')) {
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ configured: true, provider: 'muse', model: 'muse-spark-1.3' }))
      }
      return original(url, init)
    })
    await mountPanel()
    await fireEvent.click(screen.getByRole('button', { name: /^Replace key$/ }))
    await fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'muse' } })
    expect(screen.getByRole('option', { name: 'Muse (Meta)' })).toBeTruthy()
    expect((screen.getByLabelText('Model (optional)') as HTMLInputElement).placeholder).toBe('muse-spark-1.3')
    const key = screen.getByLabelText('API key') as HTMLInputElement
    await fireEvent.input(key, { target: { value: 'muse-test-key' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Link Agent Brain' }))
    await waitFor(() => expect(submitted).toMatchObject({ provider: 'muse', api_key: 'muse-test-key', model: null }))
    await screen.findByText(/Agent brain linked: muse/)
    await fireEvent.click(screen.getByRole('button', { name: /^Replace key$/ }))
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })
  it('preserves typed chat, validation, manual approval and verified response routing', async () => {
    const api = backend()
    const { engine, environment } = await mountPanel()
    await fireEvent.input(screen.getByLabelText('Mission Control instruction'), { target: { value: 'Set wind to 15 m/s from the west.' } })
    await fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await screen.findByText('Proposed Intervention')
    expect(engine.setWind).not.toHaveBeenCalled()
    expect(voice.speak).not.toHaveBeenCalledWith('Verified reply from simulator acknowledgement.')
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await waitFor(() => expect(engine.setWind).toHaveBeenCalledExactlyOnceWith(15, 270))
    await screen.findByText('Verified reply from simulator acknowledgement.')
    expect(Math.hypot(environment.getState().wind.x, environment.getState().wind.z)).toBeCloseTo(15)
    const ack = api.requests.find((request) => request.path.endsWith('/respond'))!.body
    expect(ack.results).toMatchObject([{ command: 'set_wind', outcome: 'executed' }])
    expect(ack.world_state).toMatchObject({ environment: { wind: environment.getState().wind } })
    expect(voice.speak).toHaveBeenCalledWith('Verified reply from simulator acknowledgement.')
  })

  it('routes committed voice through the same HTTP client and does not let yes approve a planet switch', async () => {
    const api = backend('switch_planet', { planet: 'mars' })
    const { engine } = await mountPanel()
    voice.committed?.('take me to Mars', 'spoken-mars')
    await screen.findByText('Proposed Intervention')
    expect(api.requests.find((item) => item.path.endsWith('/interpret'))?.body).toMatchObject({ message: 'take me to Mars', request_id: 'spoken-mars', world_state: { planet: 'earth' } })
    voice.committed?.('yes', 'unrelated-yes')
    expect(engine.switchPlanet).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await screen.findByText('Verified reply from simulator acknowledgement.')
    expect(engine.getWorldState().planet).toBe('mars')
    expect(engine.switchPlanet).toHaveBeenCalledTimes(1)
  })

  it('local confirmation rules override a backend that forgets to flag a disruptive action', async () => {
    backend('switch_planet', { planet: 'mars' })
    const { engine } = await mountPanel()
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-execute safe actions' }))
    voice.committed?.('take me to Mars', 'local-check')
    await screen.findByText('Proposed Intervention')
    expect(engine.switchPlanet).not.toHaveBeenCalled()
  })

  it('cannot apply a cancelled late interpretation', async () => {
    const api = backend()
    const original = api.fetcher.getMockImplementation()!
    let resolvePlan!: (response: Response) => void
    api.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/interpret')
      ? new Promise<Response>((resolve) => { resolvePlan = resolve }) : original(url, init))
    const { engine } = await mountPanel()
    voice.committed?.('Set wind', 'cancel-me')
    await waitFor(() => expect(resolvePlan).toBeTypeOf('function'))
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel pending request' }))
    resolvePlan(new Response(JSON.stringify({ request_id: 'cancel-me', status: 'proposed', actions: [{ command_id: 'stale', command: 'set_wind', params: { speed_mps: 15, direction_from_deg: 0 }, warnings: [] }] })))
    await waitFor(() => expect(screen.queryByText('Understanding request')).toBeNull())
    expect(screen.queryByText('Proposed Intervention')).toBeNull()
    expect(engine.setWind).not.toHaveBeenCalled()
  })

  it('voice Stop invalidates its pending proposal without undoing executed changes', async () => {
    backend()
    const { engine } = await mountPanel()
    voice.committed?.('Set wind', 'pending-voice')
    await screen.findByText('Proposed Intervention')
    voice.stop?.()
    await waitFor(() => expect(screen.queryByText('Proposed Intervention')).toBeNull())
    expect(engine.setWind).not.toHaveBeenCalled()
  })

  it('leaves typed proposals available when a voice session stops', async () => {
    backend()
    const { engine } = await mountPanel()
    await fireEvent.input(screen.getByLabelText('Mission Control instruction'), { target: { value: 'Set wind' } })
    await fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await screen.findByText('Proposed Intervention')
    voice.stop?.()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await screen.findByText('Verified reply from simulator acknowledgement.')
    expect(engine.setWind).toHaveBeenCalledTimes(1)
  })

  it('refuses a proposal if the operator changed planet while it was pending', async () => {
    backend()
    const { engine } = await mountPanel()
    voice.committed?.('Set wind', 'stale-world')
    await screen.findByText('Proposed Intervention')
    engine.switchPlanet('mars')
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await screen.findByText(/active planet changed while this request was pending/)
    expect(engine.setWind).not.toHaveBeenCalled()
  })

  it('retains actual engine failure details in the spoken response even if a summary omits them', async () => {
    backend()
    const { engine } = await mountPanel()
    engine.setWind.mockImplementation(() => { throw new Error('Wind controller offline') })
    voice.committed?.('Set wind', 'failed-wind')
    await screen.findByText('Proposed Intervention')
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await waitFor(() => expect(voice.speak.mock.calls.some(([text]) => text.includes('Wind controller offline'))).toBe(true))
  })

  it('does not speak completion until execution acknowledgement and summary are returned', async () => {
    const api = backend()
    const original = api.fetcher.getMockImplementation()!
    let resolveReply!: (response: Response) => void
    api.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/respond')
      ? new Promise<Response>((resolve) => { resolveReply = resolve }) : original(url, init))
    const { engine } = await mountPanel()
    voice.committed?.('Set wind', 'after-ack')
    await screen.findByText('Proposed Intervention')
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
    await waitFor(() => expect(resolveReply).toBeTypeOf('function'))
    expect(engine.setWind).toHaveBeenCalledTimes(1)
    expect(voice.speak).not.toHaveBeenCalledWith('Verified after acknowledgement.')
    resolveReply(new Response(JSON.stringify({ request_id: 'after-ack', reply: 'Verified after acknowledgement.' })))
    await screen.findByText('Verified after acknowledgement.')
    expect(voice.speak).toHaveBeenCalledWith('Verified after acknowledgement.')
  })

  it('reports unsupported rover functionality without dispatching any action', async () => {
    const api = backend()
    const original = api.fetcher.getMockImplementation()!
    api.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/interpret')
      ? new Response(JSON.stringify({ request_id: 'rover', status: 'unsupported', message: 'Rover deployment is not exposed by Mission Control.', actions: [] })) : original(url, init))
    const { engine } = await mountPanel()
    voice.committed?.('Deploy a rover', 'rover')
    await screen.findByText('Unsupported: Rover deployment is not exposed by Mission Control.')
    expect(engine.switchPlanet).not.toHaveBeenCalled()
    expect(engine.setWind).not.toHaveBeenCalled()
    expect(api.requests.some((item) => item.path.endsWith('/respond'))).toBe(false)
  })
})
