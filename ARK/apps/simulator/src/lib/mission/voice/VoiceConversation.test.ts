// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SimulationEngine } from '../../core/SimulationEngine'
import type { WorldStateSnapshot } from '../MissionTypes'
import { EnvironmentController } from '../../../../../../packages/physics/src/environment/EnvironmentController'
import { getPlanet } from '../../../../../../packages/physics/src/worlds/planetPresets'
import type { PlanetId } from '../../../../../../packages/physics/src/worlds/PlanetConfig'

const hardware = vi.hoisted(() => ({
  handlers: new Map<string, (event: { text: string }) => void>(),
  playback: vi.fn(), closed: vi.fn(),
}))
vi.mock('@elevenlabs/client', () => ({
  AudioFormat: { PCM_16000: 'pcm_16000' }, CommitStrategy: { VAD: 'vad' },
  RealtimeEvents: { SESSION_STARTED: 'ready', PARTIAL_TRANSCRIPT: 'partial', COMMITTED_TRANSCRIPT: 'committed', ERROR: 'error', CLOSE: 'close' },
  Scribe: { connect: () => {
    queueMicrotask(() => hardware.handlers.get('ready')?.({ text: '' }))
    return { on: (event: string, fn: (data: { text: string }) => void) => hardware.handlers.set(event, fn), send: vi.fn(), close: vi.fn() }
  } },
}))
vi.mock('./VoiceAudio', () => ({ BrowserVoiceAudio: class {
  async open() {}
  mute() {}
  stopSpeech() {}
  close = hardware.closed
  async play(body: ReadableStream<Uint8Array>, _signal: AbortSignal, speaking: (active: boolean) => void) {
    speaking(true)
    const reader = body.getReader()
    const audio = await reader.read()
    hardware.playback(audio.value)
    await reader.cancel()
    reader.releaseLock()
    speaking(false)
  }
} }))

import MissionPanel from '../MissionPanel.svelte'

const emit = (kind: 'partial' | 'committed', text: string) => hardware.handlers.get(kind)?.({ text })
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

function setup() {
  let planet: PlanetId = 'earth'
  const environment = new EnvironmentController(getPlanet(planet))
  const engine = {
    switchPlanet: vi.fn((target: PlanetId) => { planet = target; environment.resetForPlanet(getPlanet(target)) }),
    getWorldState: (): WorldStateSnapshot => ({ planet, planetDisplayName: planet, simTime: 0,
      status: 'running', gravity: { x: 0, y: -getPlanet(planet).gravity, z: 0 },
      sphere: { position: { x: 0, y: 1, z: 0 }, velocityY: 0 }, box: null,
      environment: environment.getState(), seed: 42, profileId: 'rolling-hills' }),
  }
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const responses: Record<string, string> = {
    'Hi ARK': 'Hello. What would you like to ask?',
    'Why is the sky blue?': 'Air molecules scatter short blue wavelengths more strongly.',
    'What about on Mars?': 'The simulated sky and the real Martian sky are different topics. Which do you mean?',
  }
  vi.stubGlobal('fetch', vi.fn(async (url, init?: RequestInit) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ path, body })
    if (path.endsWith('/health')) return json({ status: 'ok', llm_configured: true, provider: 'muse', model: 'muse-spark-1.3' })
    if (path.endsWith('/capabilities')) return json({ capabilities: [] })
    if (path.endsWith('/voice/config')) return json({ configured: true, llm_ready: true, voice_id: 'account-voice' })
    if (path.endsWith('/voice/token')) return json({ token: 'single-use-test-token' })
    if (path.endsWith('/voice/speech')) return new Response(new Uint8Array([0, 0, 64, 0]))
    if (path.endsWith('/interpret')) {
      if (body.message === 'Switch to Mars') return json({ request_id: body.request_id, status: 'proposed', actions: [{
        command_id: 'verified-mars-switch', command: 'switch_planet', params: { planet: 'mars' }, requires_confirmation: true, warnings: [],
      }], capability_ids: ['switch_planet'] })
      return json({ request_id: body.request_id, status: 'proposed', actions: [], message: responses[String(body.message)], capability_ids: ['answer_question'] })
    }
    if (path.endsWith('/respond')) {
      expect(engine.getWorldState().planet).toBe('mars')
      return json({ request_id: body.request_id, reply: 'The simulation has switched to Mars.' })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
  render(MissionPanel, { engine: engine as unknown as SimulationEngine })
  return { requests, engine, fetcher: vi.mocked(fetch) }
}

beforeEach(() => {
  hardware.handlers.clear()
  hardware.playback.mockClear()
  hardware.closed.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('routes actual Scribe events through MissionClient and sends each LLM answer to ElevenLabs playback', async () => {
  const { requests } = setup()
  await screen.findByText('LINKED · LLM READY')
  await fireEvent.click(screen.getByRole('button', { name: 'Enable Hi ARK' }))
  await screen.findByText('Waiting for Hi ARK')
  emit('partial', 'Hi ARK')
  expect(requests.some((request) => request.path.endsWith('/interpret'))).toBe(false)
  emit('committed', 'Hi ARK')
  await waitFor(() => expect(requests.some((request) => request.path.endsWith('/voice/speech') && request.body.text === 'Hello. What would you like to ask?')).toBe(true))
  await waitFor(() => expect(hardware.playback).toHaveBeenCalledTimes(1))
  emit('committed', 'Why is the sky blue?')
  await waitFor(() => expect(requests.some((request) => request.path.endsWith('/voice/speech') && request.body.text === 'Air molecules scatter short blue wavelengths more strongly.')).toBe(true))
  await waitFor(() => expect(hardware.playback).toHaveBeenCalledTimes(2))
  emit('committed', 'What about on Mars?')
  await waitFor(() => expect(hardware.playback).toHaveBeenCalledTimes(3))
  const followup = requests.find((request) => request.path.endsWith('/interpret') && request.body.message === 'What about on Mars?')!
  expect(followup.body.conversation_history).toEqual(expect.arrayContaining([
    { role: 'user', content: 'Why is the sky blue?' },
    { role: 'assistant', content: 'Air molecules scatter short blue wavelengths more strongly.' },
  ]))
  await fireEvent.click(screen.getByRole('button', { name: 'Stop voice' }))
  expect(hardware.closed).toHaveBeenCalled()
})

it('speaks an action completion only after the normal proposal approval and simulator acknowledgement', async () => {
  const { requests, engine } = setup()
  await screen.findByText('LINKED · LLM READY')
  await fireEvent.click(screen.getByRole('button', { name: 'Enable Hi ARK' }))
  await screen.findByText('Waiting for Hi ARK')
  emit('committed', 'Hi ARK, Switch to Mars')
  await screen.findByText('Proposed Intervention')
  expect(engine.switchPlanet).not.toHaveBeenCalled()
  expect(requests.some((request) => request.body.text === 'The simulation has switched to Mars.')).toBe(false)
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm & Execute' }))
  await waitFor(() => expect(requests.some((request) => request.body.text === 'The simulation has switched to Mars.')).toBe(true))
  expect(engine.switchPlanet).toHaveBeenCalledExactlyOnceWith('mars')
  const summary = requests.find((request) => request.path.endsWith('/respond'))!
  expect(summary.body.results).toMatchObject([{ command: 'switch_planet', outcome: 'executed' }])
  expect(summary.body.world_state).toMatchObject({ planet: 'mars' })
})

it('automatically submits speech heard while the first LLM answer is pending', async () => {
  const { requests, fetcher } = setup()
  const original = fetcher.getMockImplementation()!
  let releaseGreeting!: (response: Response) => void
  let greetingId = ''
  fetcher.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/interpret') && JSON.parse(String(args[1]?.body)).message === 'Hi ARK') {
      greetingId = JSON.parse(String(args[1]?.body)).request_id
      return new Promise<Response>((resolve) => { releaseGreeting = resolve })
    }
    return original(...args)
  })
  await screen.findByText('LINKED · LLM READY')
  await fireEvent.click(screen.getByRole('button', { name: 'Enable Hi ARK' }))
  await screen.findByText('Waiting for Hi ARK')
  emit('committed', 'Hi ARK')
  await waitFor(() => expect(releaseGreeting).toBeTypeOf('function'))
  emit('committed', 'Why is the sky blue?')
  await screen.findByText(/latest spoken question will follow/)
  releaseGreeting(json({ request_id: greetingId,
    status: 'proposed', message: 'Hello.', actions: [], capability_ids: ['answer_question'] }))
  await waitFor(() => expect(requests.some((request) => request.path.endsWith('/interpret') && request.body.message === 'Why is the sky blue?')).toBe(true))
  await waitFor(() => expect(requests.some((request) => request.body.text === 'Air molecules scatter short blue wavelengths more strongly.')).toBe(true))
})
