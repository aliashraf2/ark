import { pcmToFloat } from './VoiceProtocol'

export interface VoiceAudio {
  open(onChunk: (pcm: ArrayBuffer, level: number) => void, onLost: () => void): Promise<void>
  mute(muted: boolean): void
  play(body: ReadableStream<Uint8Array>, signal: AbortSignal, onSpeaking: (value: boolean) => void): Promise<void>
  stopSpeech(): void
  close(): void
}

/** Owns the actual microphone/worklet and streaming PCM playback resources. */
export class BrowserVoiceAudio implements VoiceAudio {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: AudioWorkletNode | null = null
  private playing = new Set<AudioBufferSourceNode>()
  private closed = false
  private playbackGeneration = 0

  constructor() {
    // Construct/resume in the Start button gesture, before network awaits.
    if (typeof AudioContext !== 'undefined') {
      this.context = new AudioContext({ sampleRate: 16000 })
      void this.context.resume().catch(() => {})
    }
  }

  async open(onChunk: (pcm: ArrayBuffer, level: number) => void, onLost: () => void): Promise<void> {
    if (!this.context || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone audio requires a supported browser on localhost or HTTPS.')
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    } })
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.stream = stream
    stream.getAudioTracks().forEach((track) => { track.onended = onLost })
    const context = this.context
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}ark-pcm-worklet.js`)
    if (this.closed) return
    await context.resume()
    if (this.closed) return
    this.source = context.createMediaStreamSource(stream)
    this.processor = new AudioWorkletNode(context, 'ark-pcm')
    this.processor.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (!this.closed) onChunk(event.data.pcm, event.data.level)
    }
    this.source.connect(this.processor)
    this.processor.connect(context.destination)
  }

  mute(muted: boolean): void {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted })
  }

  async play(body: ReadableStream<Uint8Array>, signal: AbortSignal, onSpeaking: (value: boolean) => void): Promise<void> {
    const context = this.context
    if (!context || this.closed) throw new Error('Audio session is closed.')
    this.stopSpeech()
    const generation = this.playbackGeneration
    await context.resume()
    const reader = body.getReader()
    const cancel = () => { this.stopSpeech(); void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let tail = new Uint8Array(0)
    let cursor = context.currentTime + 0.02
    let received = false
    try {
      while (!signal.aborted && generation === this.playbackGeneration && !this.closed) {
        const { value, done } = await reader.read()
        if (signal.aborted || generation !== this.playbackGeneration || this.closed) break
        if (done) break
        const bytes = new Uint8Array(tail.length + value.length)
        bytes.set(tail)
        bytes.set(value, tail.length)
        const length = bytes.length - bytes.length % 2
        tail = bytes.slice(length)
        if (!length) continue
        const samples = pcmToFloat(bytes.subarray(0, length))
        const buffer = context.createBuffer(1, samples.length, 24000)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => { this.playing.delete(source); source.disconnect() }
        this.playing.add(source)
        cursor = Math.max(cursor, context.currentTime + 0.01)
        source.start(cursor)
        cursor += buffer.duration
        received = true
        onSpeaking(true)
        // Bound queued audio: don't buffer a long reply far ahead of the listener.
        while (cursor - context.currentTime > 1 && !signal.aborted && generation === this.playbackGeneration) {
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
      }
      while (this.playing.size && !signal.aborted && generation === this.playbackGeneration) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      if (!signal.aborted && generation === this.playbackGeneration && (!received || tail.length)) {
        throw new Error('Speech stream was empty or incomplete.')
      }
    } catch (error) {
      if (generation === this.playbackGeneration) this.stopSpeech()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      onSpeaking(false)
    }
  }

  stopSpeech(): void {
    this.playbackGeneration++
    for (const node of this.playing) {
      node.onended = null
      try { node.stop() } catch { /* already ended */ }
      node.disconnect()
    }
    this.playing.clear()
  }

  close(): void {
    this.closed = true
    this.stopSpeech()
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop() })
    if (this.processor) this.processor.port.onmessage = null
    this.processor?.disconnect()
    this.source?.disconnect()
    void this.context?.close().catch(() => {})
    this.stream = null
    this.context = null
  }
}
