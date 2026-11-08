import type { AudioOptions, RealtimeConnection } from '@elevenlabs/client'
import { BrowserVoiceAudio, type VoiceAudio } from './VoiceAudio'
import { isSpeechEcho, speechText, TranscriptGate, VOICE_LANGUAGE, wakeCommand } from './VoiceProtocol'

export type VoicePhase = 'listening' | 'processing' | 'awaiting-approval' | 'executing'
export interface VoiceState {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  phase: VoicePhase
  speaking: boolean
  microphoneMuted: boolean
  speechMuted: boolean
  level: number
  partial: string
  committed: string
  response: string
  error: string | null
  wakeRequired: boolean
  activated: boolean
}

export const initialVoiceState = (): VoiceState => ({
  connection: 'disconnected', phase: 'listening', speaking: false,
  microphoneMuted: false, speechMuted: false, level: 0,
  partial: '', committed: '', response: '', error: null,
  wakeRequired: true, activated: false,
})

export interface VoiceDependencies {
  fetch: typeof fetch
  connect?: (options: AudioOptions) => RealtimeConnection
  audio: () => VoiceAudio
  id: () => string
}

const defaults: VoiceDependencies = {
  fetch: (...args) => fetch(...args),
  audio: () => new BrowserVoiceAudio(),
  id: () => crypto.randomUUID(),
}

/** A speech adapter; committed text goes to the SAME caller as typed messages. */
export class VoiceSession {
  private state = initialVoiceState()
  private epoch = 0
  private connection: RealtimeConnection | null = null
  private audio: VoiceAudio | null = null
  private sessionAbort: AbortController | null = null
  private speechAbort: AbortController | null = null
  private readonly gate = new TranscriptGate()
  private recentSpeech = { text: '', until: 0 }

  private echo(text: string): boolean {
    return Date.now() <= this.recentSpeech.until && isSpeechEcho(text, this.recentSpeech.text)
  }

  constructor(
    private readonly baseUrl: string,
    private readonly onState: (state: VoiceState) => void,
    private readonly onCommitted: (text: string, requestId: string) => void,
    private readonly onStop: () => void,
    private readonly deps: VoiceDependencies = defaults,
  ) {}

  private update(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch }
    this.onState({ ...this.state })
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 30000)
    const clearTimer = () => clearTimeout(timer)
    signal.addEventListener('abort', clearTimer, { once: true })
    let response: Response
    try {
      response = await this.deps.fetch(`${this.baseUrl.replace(/\/$/, '')}/api/voice/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ARK-Voice': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout.signal]),
      cache: 'no-store',
      })
    } finally {
      // Only time out obtaining headers; a spoken reply may last >30 seconds.
      clearTimeout(timer)
      signal.removeEventListener('abort', clearTimer)
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { detail?: unknown }
      throw new Error(typeof data.detail === 'string' ? data.detail : `Voice service failed (${response.status}).`)
    }
    return response
  }

  async start(language = VOICE_LANGUAGE): Promise<void> {
    if (this.state.connection === 'connecting' || this.state.connection === 'connected') return
    if (language !== VOICE_LANGUAGE) {
      this.update({ connection: 'error', error: 'Only English (en) is enabled for ARK voice.' })
      return
    }
    const epoch = ++this.epoch
    const active = () => epoch === this.epoch
    const controller = new AbortController()
    this.sessionAbort = controller
    this.update({ connection: 'connecting', error: null, partial: '', level: 0, microphoneMuted: false, activated: !this.state.wakeRequired })
    try {
      const audio = this.deps.audio()
      this.audio = audio
      const settings = await (await this.request('config', controller.signal)).json() as { configured: boolean; error?: string; llm_ready?: boolean }
      if (!active()) return
      if (!settings.configured) throw new Error(settings.error || 'Voice is not configured on the backend.')
      if (settings.llm_ready === false) throw new Error('Link your LLM in Agent Link before starting voice. ElevenLabs transcribes your speech and speaks that LLM’s answer.')
      const token = await (await this.request('token', controller.signal, {})).json() as { token: string }
      if (!active()) return
      if (!token.token) throw new Error('Voice service returned no transcription token.')
      // Keep the voice SDK out of the simulator's initial render/physics bundle.
      const { AudioFormat, CommitStrategy, RealtimeEvents, Scribe } = await import('@elevenlabs/client')
      if (!active()) return
      let socketReady = false
      const connection = (this.deps.connect ?? ((options) => Scribe.connect(options)))({
        token: token.token, modelId: 'scribe_v2_realtime', languageCode: language,
        audioFormat: AudioFormat.PCM_16000, sampleRate: 16000,
        commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 1.2,
        keyterms: ['ARK', 'Hi ARK'],
      })
      this.connection = connection
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Transcription connection timed out.')), 20000)
        const abort = () => { clearTimeout(timeout); reject(new DOMException('Stopped', 'AbortError')) }
        controller.signal.addEventListener('abort', abort, { once: true })
        connection.on(RealtimeEvents.SESSION_STARTED, () => {
          clearTimeout(timeout)
          controller.signal.removeEventListener('abort', abort)
          socketReady = true
          resolve()
        })
        connection.on(RealtimeEvents.ERROR, () => {
          clearTimeout(timeout)
          reject(new Error('ElevenLabs transcription failed. Check microphone, key permissions, quota and network.'))
          if (active()) this.fail('ElevenLabs transcription failed. Reconnect to try again.')
        })
        connection.on(RealtimeEvents.CLOSE, () => {
          clearTimeout(timeout)
          reject(new Error('Transcription connection closed.'))
          if (active()) this.fail('Voice connection lost. Reconnect to start a fresh session; no commands are replayed.')
        })
      })
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        if (!active() || this.state.microphoneMuted) return
        if (this.echo(text)) return
        // Barge-in stops audio only; it never confirms, cancels, or undoes a command.
        if (text.trim() && (this.state.activated || wakeCommand(text) !== null)) this.interruptSpeech()
        this.update({ partial: text })
      })
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        if (!active() || this.state.microphoneMuted) return
        if (this.echo(text)) { this.update({ partial: '' }); return }
        this.update({ partial: '', committed: text })
        const woken = wakeCommand(text)
        if (this.state.wakeRequired && woken === null && !this.state.activated) return
        if (woken === '') {
          if (this.state.activated) return
          this.update({ activated: true })
          const greeting = this.gate.accept(text)
          if (greeting) this.onCommitted(greeting, this.deps.id())
          return
        }
        // Wake once, then keep the conversation open until mute/stop. The same
        // transcript gate still prevents command replay across reconnects.
        const command = this.gate.accept(woken ?? text)
        if (command) {
          if (woken !== null) this.update({ activated: true })
          this.interruptSpeech()
          this.onCommitted(command, this.deps.id())
        }
      })
      await Promise.all([
        ready,
        audio.open((pcm, level) => {
          if (!active()) return
          this.update({ level: this.state.microphoneMuted ? 0 : Math.min(1, level * 5) })
          if (!socketReady) return
          // 128 ms PCM blocks; no rendering/physics work is coupled to this path.
          const bytes = new Uint8Array(pcm)
          const encoded = btoa(String.fromCharCode(...bytes))
          try { connection.send({ audioBase64: encoded }) }
          catch { this.fail('Microphone stream could not be sent. Reconnect to try again.') }
        }, () => { if (active()) this.fail('Microphone disconnected. Reconnect after selecting a working microphone.') }),
      ])
      if (active()) this.update({ connection: 'connected' })
    } catch (error) {
      if (!active()) return
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission denied. Allow microphone access in your browser, then reconnect.'
        : error instanceof Error ? error.message : 'Voice session failed.'
      this.fail(message)
    }
  }

  setPhase(phase: VoicePhase): void { this.update({ phase }) }

  setWakeRequired(required: boolean): void {
    this.update({ wakeRequired: required, activated: !required, partial: '' })
  }

  muteMicrophone(muted: boolean): void {
    this.audio?.mute(muted)
    this.update({ microphoneMuted: muted, partial: '', level: 0, activated: !this.state.wakeRequired })
  }

  muteSpeech(muted: boolean): void {
    if (muted) this.interruptSpeech()
    this.update({ speechMuted: muted })
  }

  async speak(text: string): Promise<void> {
    this.update({ response: text })
    this.interruptSpeech()
    if (this.state.connection !== 'connected' || this.state.speechMuted || !speechText(text)) return
    const epoch = this.epoch
    const controller = new AbortController()
    this.speechAbort = controller
    try {
      const response = await this.request('speech', controller.signal, { text: speechText(text), language: VOICE_LANGUAGE })
      if (controller.signal.aborted || epoch !== this.epoch) return
      if (!response.body) throw new Error('Speech service returned no audio.')
      await this.audio?.play(response.body, controller.signal, (speaking) => {
        if (epoch === this.epoch && this.speechAbort === controller) {
          if (speaking) this.recentSpeech = { text: speechText(text), until: Infinity }
          else if (this.recentSpeech.text === speechText(text)) this.recentSpeech.until = Date.now() + 2000
          this.update({ speaking })
        }
      })
    } catch (error) {
      if (!controller.signal.aborted && epoch === this.epoch) {
        this.update({ error: error instanceof Error ? error.message : 'Speech playback failed.' })
      }
    } finally {
      if (this.speechAbort === controller) {
        this.speechAbort = null
        this.update({ speaking: false })
      }
      if (this.recentSpeech.text === speechText(text)) this.recentSpeech.until = Date.now() + 2000
    }
  }

  interruptSpeech(): void {
    this.speechAbort?.abort()
    this.speechAbort = null
    this.audio?.stopSpeech()
    if (this.state.speaking) this.update({ speaking: false })
  }

  stop(): void {
    this.release()
    this.update({ connection: 'disconnected', partial: '', level: 0, activated: false, error: null })
    this.onStop()
  }

  private fail(message: string): void {
    this.release()
    this.update({ connection: 'error', error: message, partial: '', level: 0, activated: false })
    this.onStop()
  }

  private release(): void {
    ++this.epoch // Ignore delayed transcripts, token responses, or socket callbacks.
    this.sessionAbort?.abort()
    this.sessionAbort = null
    this.interruptSpeech()
    this.connection?.close()
    this.connection = null
    this.audio?.close()
    this.audio = null
    this.recentSpeech = { text: '', until: 0 }
  }

}
