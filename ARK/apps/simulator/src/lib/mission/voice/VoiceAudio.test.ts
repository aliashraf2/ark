import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserVoiceAudio } from './VoiceAudio'

afterEach(() => vi.unstubAllGlobals())

function audioHost() {
  const stop = vi.fn()
  const track = { enabled: true, onended: null, stop }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const processor = { connect: vi.fn(), disconnect: vi.fn(), port: { onmessage: null } }
  const nodes: Array<{ onended: null | (() => void); stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; buffer?: unknown }> = []
  const context = {
    currentTime: 0, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    destination: {}, audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => source),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({ duration: length / sampleRate, copyToChannel: vi.fn() })),
    createBufferSource: vi.fn(() => {
      const node = { onended: null as null | (() => void), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn() }
      node.start.mockImplementation(() => queueMicrotask(() => node.onended?.()))
      nodes.push(node)
      return node
    }),
  }
  vi.stubGlobal('AudioContext', class { constructor() { return context } })
  vi.stubGlobal('AudioWorkletNode', class { constructor() { return processor } })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
  return { track, stream, context, source, processor, nodes }
}

describe('real PCM and browser audio resource ownership', () => {
  it('runs capture conversion in a worklet and measures the actual input', () => {
    const messages: Array<{ pcm: ArrayBuffer; level: number }> = []
    let Processor!: new () => { process(inputs: Float32Array[][]): boolean }
    runInNewContext(readFileSync(new URL('../../../../public/ark-pcm-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { postMessage: (data: { pcm: ArrayBuffer; level: number }) => messages.push(data) } },
      registerProcessor: (_name: string, constructor: typeof Processor) => { Processor = constructor },
    })
    const processor = new Processor()
    for (let index = 0; index < 16; index++) processor.process([[new Float32Array(128).fill(0.5)]])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.level).toBeCloseTo(0.5)
    expect(new Int16Array(messages[0]!.pcm)[0]).toBe(16384)
  })

  it('releases tracks, nodes and context; mute really disables the microphone track', async () => {
    const host = audioHost()
    const audio = new BrowserVoiceAudio()
    await audio.open(vi.fn(), vi.fn())
    audio.mute(true)
    expect(host.track.enabled).toBe(false)
    audio.close()
    expect(host.track.stop).toHaveBeenCalledTimes(1)
    expect(host.context.close).toHaveBeenCalledTimes(1)
    expect(host.processor.disconnect).toHaveBeenCalled()
    expect(host.source.disconnect).toHaveBeenCalled()
    expect(host.processor.port.onmessage).toBeNull()
  })

  it('stops a microphone that arrives after the user ended the session', async () => {
    const host = audioHost()
    let grant!: (stream: unknown) => void
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve }) } })
    const audio = new BrowserVoiceAudio()
    const open = audio.open(vi.fn(), vi.fn())
    audio.close()
    grant(host.stream)
    await open
    expect(host.track.stop).toHaveBeenCalledTimes(1)
    expect(host.context.createMediaStreamSource).not.toHaveBeenCalled()
  })

  it('handles PCM split on odd byte boundaries and plays it at the actual output sample rate', async () => {
    const host = audioHost()
    const audio = new BrowserVoiceAudio()
    await audio.open(vi.fn(), vi.fn())
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([0]))
      controller.enqueue(new Uint8Array([128, 255, 127]))
      controller.close()
    } })
    const speaking = vi.fn()
    await audio.play(body, new AbortController().signal, speaking)
    expect(host.context.createBuffer).toHaveBeenCalledWith(1, 2, 24000)
    expect(host.nodes[0]!.start).toHaveBeenCalled()
    expect(speaking).toHaveBeenLastCalledWith(false)
    audio.close()
  })
})
