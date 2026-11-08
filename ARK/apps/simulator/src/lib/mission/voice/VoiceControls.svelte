<script lang="ts">
  import type { VoiceState } from './VoiceSession'
  import VoiceSetup from './VoiceSetup.svelte'

  export let state: VoiceState
  export let disabled = false
  export let canCancel = false
  export let onStart: () => void
  export let onStop: () => void
  export let onMicrophoneMute: () => void
  export let onSpeechMute: () => void
  export let onInterrupt: () => void
  export let onCancel: () => void
  export let baseUrl: string
  export let onConfigured: () => void
  export let onWakeChange: (required: boolean) => void
  export let llmReady = false
  export let llmLabel = 'LLM not linked'

  $: active = state.connection === 'connected'
  $: connecting = state.connection === 'connecting'
  $: status = state.connection === 'error' ? 'Error'
    : connecting ? 'Connecting'
    : !active ? 'Disconnected'
    : state.speaking ? 'Speaking'
    : state.phase === 'processing' ? 'Processing'
    : state.phase === 'executing' ? 'Executing'
    : state.phase === 'awaiting-approval' ? 'Awaiting approval'
    : state.microphoneMuted ? 'Microphone muted'
    : state.wakeRequired && !state.activated ? 'Waiting for Hi ARK' : 'Listening for command'
</script>

<section class="dock-section voice-controls" aria-label="Voice Mission Control">
  <div class="section-title-row">
    <h3 class="section-title">Voice Mission Control</h3>
    <span class="section-badge" role="status">{status}</span>
  </div>
  <VoiceSetup {baseUrl} active={active || connecting} {onConfigured} />
  <p class="mission-hint">Microphone → ElevenLabs transcription → <strong>{llmLabel}</strong> → ElevenLabs speech → speakers</p>
  {#if !llmReady}<p class="mission-error">Link your LLM in Agent Link first, then connect ElevenLabs and start talking.</p>{/if}
  <div class="voice-buttons">
    {#if active || connecting}
      <button type="button" class="event-trigger-btn" on:click={onStop}>Stop voice</button>
    {:else}
      <button type="button" class="event-trigger-btn" on:click={onStart} disabled={disabled || !llmReady}>
        <svg aria-hidden="true" width="14" height="16" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="5" y="1" width="6" height="11" rx="3"/><path d="M2 8v2a6 6 0 0 0 12 0V8M8 16v3M5 19h6"/>
        </svg>
        {state.connection === 'error' ? 'Reconnect voice' : state.wakeRequired ? 'Enable Hi ARK' : 'Start voice'}
      </button>
    {/if}
    <button type="button" class="preset-pill" disabled={!active} aria-pressed={state.microphoneMuted} on:click={onMicrophoneMute}>
      {state.microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}
    </button>
    <button type="button" class="preset-pill" aria-pressed={state.speechMuted} on:click={onSpeechMute}>
      {state.speechMuted ? 'Unmute ARK' : 'Mute ARK'}
    </button>
    <button type="button" class="preset-pill" disabled={!active} on:click={onInterrupt}>Interrupt speech</button>
    <button type="button" class="preset-pill" disabled={!canCancel} on:click={onCancel}>Cancel pending request</button>
  </div>
  <label class="voice-wake">
    <input type="checkbox" checked={state.wakeRequired} disabled={connecting}
      on:change={(event) => onWakeChange(event.currentTarget.checked)} />
    Start the conversation with “Hi ARK”
  </label>
  <p class="mission-hint">Enable the microphone once and say “Hi ARK.” Then ask questions naturally; each finalized transcript goes to your linked LLM and its reply is spoken automatically. Mute or Stop voice ends the active conversation.</p>
  <div class="voice-meter-row">
    <span>Microphone</span>
    <meter min="0" max="1" value={state.level} aria-label="Measured microphone audio level"></meter>
    <span class="voice-audio-state">{state.speaking ? 'ARK audio playing' : 'ARK audio idle'}</span>
  </div>
  <label class="voice-language" for="ark-voice-language">Speech language
    <select id="ark-voice-language" class="ark-select" disabled={active || connecting}>
      <option value="en">English</option>
    </select>
  </label>
  <div class="voice-transcripts" aria-live="polite">
    <p><strong>You</strong> {state.partial || state.committed || 'Your transcript will appear here.'}</p>
    {#if state.partial}<small>Recognizing… commands wait for a committed transcript.</small>{/if}
    <p><strong>ARK</strong> {state.response || 'Verified replies appear here and are spoken during a voice session.'}</p>
  </div>
  {#if state.error}<p class="mission-error" role="alert">{state.error}</p>{/if}
  <p class="mission-hint">Audio goes to ElevenLabs while connected. Approve changes using the specific proposal below. Interrupting audio leaves executed changes active. Headphones help prevent speaker echo.</p>
</section>

<style>
  .voice-controls { display: grid; gap: 10px; }
  .voice-wake { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .voice-buttons { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .voice-buttons .event-trigger-btn { display: flex; align-items: center; gap: 8px; width: auto; }
  .voice-meter-row { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-secondary, #a6b6c9); }
  meter { min-width: 50px; flex: 1; height: 8px; accent-color: #65dbb9; }
  .voice-audio-state { font-size: 9px; }
  .voice-language { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 10px; }
  .voice-language select { width: 110px; }
  .voice-transcripts { padding: 10px; border: 1px solid rgba(148, 180, 204, 0.16); border-radius: 6px; font-size: 11px; line-height: 1.5; }
  .voice-transcripts p { margin: 0 0 6px; overflow-wrap: anywhere; white-space: pre-wrap; }
  .voice-transcripts p:last-child { margin-bottom: 0; }
  .voice-transcripts strong { color: #65dbb9; margin-right: 6px; }
  .voice-transcripts small { color: #a6b6c9; }
</style>
