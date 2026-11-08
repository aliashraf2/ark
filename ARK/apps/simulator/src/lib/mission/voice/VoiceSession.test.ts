import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealtimeEvents, type AudioOptions, type RealtimeConnection } from '@elevenlabs/client'
import { VoiceSession, type VoiceState } from './VoiceSession'
import { isUnscopedConfirmation, normalizeTranscript, pcmToFloat, speechText, TranscriptGate, wakeCommand } from './VoiceProtocol'
import type { VoiceAudio } from './VoiceAudio'

class Socket {
  handlers = new Map<string, Array<(value: never) => void>>()
  send = vi.fn()
  close = vi.fn()
  on(event: string, fn: (value: never) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
  }
  emit(event: string, value: unknown = {}) { this.handlers.get(event)?.forEach((fn) => fn(value as never)) }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function harness() {
  const sockets: Socket[] = []
  let state: VoiceState
  let chunk: ((pcm: ArrayBuffer, level: number) => void) | undefined
  let lost: (() => void) | undefined
  const audio: VoiceAudio = {
    open: vi.fn(async (onChunk, onLost) => { chunk = onChunk; lost = onLost }),
    mute: vi.fn(), close: vi.fn(), stopSpeech: vi.fn(),
    play: vi.fn(async (_body, _signal, onSpeaking) => { onSpeaking(true); onSpeaking(false) }),
  }
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/config')) return json({ configured: true })
    if (String(url).endsWith('/token')) return json({ token: 'single-use-token' })
    return new Response(new Uint8Array([0, 0, 255, 127]))
  })
  const committed = vi.fn()
  const stopped = vi.fn()
  const options: AudioOptions[] = []
  const session = new VoiceSession('http://localhost:8000', (value) => { state = value }, committed, stopped, {
    fetch: fetcher as typeof fetch,
    connect: (value) => {
      options.push(value)
      const socket = new Socket()
      sockets.push(socket)
      queueMicrotask(() => socket.emit(RealtimeEvents.SESSION_STARTED))
      return socket as unknown as RealtimeConnection
    },
    audio: () => audio,
    id: (() => { let sequence = 0; return () => `voice-${++sequence}` })(),
  })
  session.setWakeRequired(false) // Existing continuous-mode regression scenarios.
  return { session, sockets, audio, fetcher, committed, stopped, options,
    state: () => state!, chunk: () => chunk!, lost: () => lost! }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('voice protocol', () => {
  it('recognizes a leading Hi ARK without matching mentions in other speech', () => {
    expect(wakeCommand('Hi, ARK!')).toBe('')
    expect(wakeCommand('HI ARK, set_wind to 15 m/s.')).toBe('set_wind to 15 m/s.')
    expect(wakeCommand('They said hi ark yesterday.')).toBeNull()
    expect(wakeCommand('hi Arkansas')).toBeNull()
  })
  it('normalizes only spacing and wake word, preserving units and identifiers', () => {
    expect(normalizeTranscript(' ARK,  set_wind to 15 m/s. ')).toBe('set_wind to 15 m/s.')
    expect(speechText('✓ **Wind**: `15 m/s`')).toBe('Wind: 15 m/s')
  })
  it('suppresses committed resends across reconnects without prohibiting later intentional repetition', () => {
    const gate = new TranscriptGate()
    expect(gate.accept('ARK, Pause.', 0)).toBe('Pause.')
    expect(gate.accept('pause', 100)).toBeNull()
    expect(gate.accept('pause', 8001)).toBe('pause')
    expect(gate.accept('ARK, ', 9000)).toBeNull()
  })
  it('recognizes unscoped approval without modifying internal commands', () => {
    for (const text of ['yes', 'okay.', 'approve', 'no', 'go ahead']) expect(isUnscopedConfirmation(text)).toBe(true)
    expect(isUnscopedConfirmation('set_wind')).toBe(false)
  })
  it('decodes signed little endian PCM correctly', () => {
    expect([...pcmToFloat(new Uint8Array([0, 128, 0, 0, 255, 127]))]).toEqual([-1, 0, 32767 / 32768])
  })
})

describe('ElevenLabs voice session lifecycle', () => {
  it('does not send recognized speaker playback back to the LLM as another user turn', async () => {
    const h = harness()
    await h.session.start()
    await h.session.speak('Air molecules scatter blue wavelengths more strongly.')
    h.sockets[0]!.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Air molecules scatter blue wavelengths more strongly.' })
    expect(h.committed).not.toHaveBeenCalled()
    h.sockets[0]!.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'How is Mars different?' })
    expect(h.committed).toHaveBeenCalledExactlyOnceWith('How is Mars different?', 'voice-1')
    h.session.stop()
  })
  it('waits for committed Hi ARK, routes its greeting to the LLM and accepts ongoing follow-ups', async () => {
    const h = harness()
    h.session.setWakeRequired(true)
    await h.session.start()
    const socket = h.sockets[0]!
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Reset the world' })
    socket.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: 'Hi ARK' })
    expect(h.state().activated).toBe(false)
    expect(h.committed).not.toHaveBeenCalled()
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Hi ARK' })
    expect(h.state().activated).toBe(true)
    expect(h.committed).toHaveBeenCalledExactlyOnceWith('Hi ARK', 'voice-1')
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Switch to Mars' })
    expect(h.committed).toHaveBeenLastCalledWith('Switch to Mars', 'voice-2')
    expect(h.state().activated).toBe(true)
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Pause the simulation' })
    expect(h.committed).toHaveBeenLastCalledWith('Pause the simulation', 'voice-3')
    h.session.stop()
  })

  it('accepts Hi ARK and a command together without resubmitting repeated transcripts', async () => {
    const h = harness()
    h.session.setWakeRequired(true)
    await h.session.start()
    const socket = h.sockets[0]!
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Hi ARK, set wind to 15 m/s.' })
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Hi ARK, set wind to 15 m/s.' })
    expect(h.committed).toHaveBeenCalledExactlyOnceWith('set wind to 15 m/s.', 'voice-1')
    expect(h.state().activated).toBe(true)
    h.session.stop()
  })

  it('keeps an activated conversation open and clears it on mute or stop', async () => {
    const h = harness()
    h.session.setWakeRequired(true)
    await h.session.start()
    vi.useFakeTimers()
    const socket = h.sockets[0]!
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Hi ARK' })
    expect(h.state().activated).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(h.state().activated).toBe(true)
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Hi ARK' })
    h.session.muteMicrophone(true)
    expect(h.state().activated).toBe(false)
    h.session.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start capture when the selected Mission Control LLM is not linked', async () => {
    const h = harness()
    h.fetcher.mockImplementation(async () => json({ configured: true, llm_ready: false }))
    await h.session.start()
    expect(h.state().error).toContain('Link your LLM in Agent Link')
    expect(h.audio.open).not.toHaveBeenCalled()
    expect(h.sockets).toHaveLength(0)
  })

  it('obtains a fresh token, waits for actual audio/socket readiness and transmits real PCM', async () => {
    const h = harness()
    await h.session.start()
    expect(h.state().connection).toBe('connected')
    expect(h.options[0]).toMatchObject({ token: 'single-use-token', languageCode: 'en', modelId: 'scribe_v2_realtime', commitStrategy: 'vad' })
    h.chunk()(new Uint8Array([0, 1]).buffer, 0.1)
    expect(h.sockets[0]?.send).toHaveBeenCalledWith({ audioBase64: 'AAE=' })
    expect(h.state().level).toBe(0.5)
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual(['http://localhost:8000/api/voice/config', 'http://localhost:8000/api/voice/token'])
    h.session.stop()
  })
  it('shows partials but routes only committed transcripts once with unique request IDs', async () => {
    const h = harness()
    await h.session.start()
    const socket = h.sockets[0]!
    socket.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: 'ARK, switch' })
    expect(h.state().partial).toBe('ARK, switch')
    expect(h.committed).not.toHaveBeenCalled()
    socket.emit(RealtimeEvents.FINAL_TRANSCRIPT, { text: 'ARK, switch to Mars' })
    expect(h.committed).not.toHaveBeenCalled()
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'ARK, switch to Mars.' })
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'switch to mars' })
    expect(h.committed).toHaveBeenCalledExactlyOnceWith('switch to Mars.', 'voice-1')
    h.session.stop()
    socket.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Reset everything' })
    expect(h.committed).toHaveBeenCalledTimes(1)
  })
  it('fails gracefully on microphone permissions and releases its socket/context', async () => {
    const h = harness()
    vi.mocked(h.audio.open).mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await h.session.start()
    expect(h.state().connection).toBe('error')
    expect(h.state().error).toContain('permission denied')
    expect(h.audio.close).toHaveBeenCalled()
    expect(h.sockets[0]?.close).toHaveBeenCalled()
  })
  it('does not open a microphone or token for missing config or an unsupported language', async () => {
    const h = harness()
    await h.session.start('fr')
    expect(h.fetcher).not.toHaveBeenCalled()
    h.fetcher.mockImplementation(async () => json({ configured: false, error: 'Configure the key.' }))
    await h.session.start()
    expect(h.state().error).toBe('Configure the key.')
    expect(h.audio.open).not.toHaveBeenCalled()
    expect(h.audio.close).toHaveBeenCalled()
  })
  it('treats token/auth failures honestly without starting transcription', async () => {
    const h = harness()
    h.fetcher.mockImplementation(async (url) => String(url).endsWith('/config') ? json({ configured: true }) : json({ detail: 'Token authorization unavailable.' }, 502))
    await h.session.start()
    expect(h.state().connection).toBe('error')
    expect(h.state().error).toContain('Token authorization')
    expect(h.sockets).toHaveLength(0)
  })
  it('mutes capture, suppresses late committed text, and independently mutes speech', async () => {
    const h = harness()
    await h.session.start()
    h.session.muteMicrophone(true)
    expect(h.audio.mute).toHaveBeenCalledWith(true)
    h.sockets[0]!.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Reset' })
    expect(h.committed).not.toHaveBeenCalled()
    h.session.muteSpeech(true)
    await h.session.speak('Reply remains visible.')
    expect(h.state().response).toBe('Reply remains visible.')
    expect(h.audio.play).not.toHaveBeenCalled()
    h.session.stop()
  })
  it('streams response text, barge-in aborts playback only, and stops cleanly', async () => {
    const h = harness()
    await h.session.start()
    let aborted = false
    vi.mocked(h.audio.play).mockImplementation(async (_body, signal, speaking) => {
      speaking(true)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      speaking(false)
    })
    const speech = h.session.speak('Wind change verified.')
    await flush()
    expect(h.state().speaking).toBe(true)
    h.sockets[0]!.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: 'Hi ARK' })
    await speech
    expect(aborted).toBe(true)
    expect(h.stopped).not.toHaveBeenCalled()
    expect(h.state().connection).toBe('connected')
    expect(h.committed).not.toHaveBeenCalled()
    h.session.stop()
    expect(h.audio.close).toHaveBeenCalled()
    expect(h.stopped).toHaveBeenCalledTimes(1)
  })
  it('closes on connection loss and obtains a new token on explicit recovery without replay', async () => {
    const h = harness()
    await h.session.start()
    h.sockets[0]!.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Pause' })
    h.sockets[0]!.emit(RealtimeEvents.CLOSE)
    expect(h.state().connection).toBe('error')
    await h.session.start()
    h.sockets[1]!.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'Pause' })
    expect(h.options).toHaveLength(2)
    expect(h.committed).toHaveBeenCalledTimes(1)
    h.lost()()
    expect(h.state().error).toContain('Microphone disconnected')
    h.session.stop()
  })
  it('discards delayed token completion after Stop and never creates a stale socket', async () => {
    const h = harness()
    let resolveToken!: (response: Response) => void
    h.fetcher.mockImplementation(async (url) => String(url).endsWith('/config')
      ? json({ configured: true }) : new Promise<Response>((resolve) => { resolveToken = resolve }))
    const start = h.session.start()
    await flush()
    h.session.stop()
    resolveToken(json({ token: 'late' }))
    await start
    expect(h.state().connection).toBe('disconnected')
    expect(h.sockets).toHaveLength(0)
  })
  it('keeps a speech failure isolated from the microphone/session', async () => {
    const h = harness()
    await h.session.start()
    h.fetcher.mockImplementation(async () => json({ detail: 'Speech quota exceeded.' }, 502))
    await h.session.speak('A verified reply')
    expect(h.state().error).toBe('Speech quota exceeded.')
    expect(h.state().connection).toBe('connected')
    h.session.stop()
  })
})
