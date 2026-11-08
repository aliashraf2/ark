<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  export let baseUrl: string
  export let active = false
  export let onConfigured: () => void = () => {}

  let apiKey = ''
  let voiceId = ''
  let modelId = 'eleven_flash_v2_5'
  let configured = false
  let showSetup = true
  let busy = false
  let error: string | null = null
  let summary = ''
  let revision = 0
  const controller = new AbortController()

  async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/voice/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ARK-Voice': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
      cache: 'no-store',
    })
    const result = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'ElevenLabs setup failed.')
    return result
  }

  onMount(() => {
    const initialRevision = revision
    void request('config').then((result) => {
      if (controller.signal.aborted || revision !== initialRevision) return
      configured = result.configured === true
      showSetup = !configured
      voiceId = typeof result.voice_id === 'string' ? result.voice_id : ''
      modelId = typeof result.tts_model === 'string' ? result.tts_model : modelId
      if (configured) summary = `Voice ${voiceId} · ${modelId}`
    }).catch(() => { if (!controller.signal.aborted && revision === initialRevision) error = 'Voice setup could not reach the backend. Reconnect after starting the agent service.' })
  })
  onDestroy(() => { apiKey = ''; controller.abort() })

  async function connect(): Promise<void> {
    if (busy || active || apiKey.trim().length < 8) return
    busy = true
    revision++
    error = null
    const body = { api_key: apiKey.trim(), voice_id: voiceId.trim(), model_id: modelId.trim() }
    apiKey = ''
    try {
      const result = await request('configure', body)
      if (controller.signal.aborted) return
      configured = result.configured === true
      if (!configured) throw new Error('ElevenLabs did not confirm this connection.')
      voiceId = String(result.voice_id)
      summary = `${String(result.voice_name)} · ${String(result.tts_model)}`
      showSetup = false
      onConfigured()
    } catch (reason) {
      if (!controller.signal.aborted) error = reason instanceof Error ? reason.message : 'ElevenLabs setup failed.'
    } finally {
      busy = false
    }
  }
</script>

<div class="voice-setup">
  <div class="section-title-row">
    <span class="switch-title">ElevenLabs connection</span>
    <span class="section-badge">{busy ? 'CHECKING…' : configured ? 'LINKED' : 'SETUP NEEDED'}</span>
  </div>
  {#if configured}
    <p class="mission-hint">{summary}</p>
    <button type="button" class="preset-pill" disabled={busy || active} on:click={() => { showSetup = !showSetup }}>
      {showSetup ? 'Hide ElevenLabs setup' : 'Replace ElevenLabs key'}
    </button>
  {/if}
  {#if showSetup}
    <form on:submit|preventDefault={() => void connect()}>
      <label class="control-label" for="elevenlabs-key">ElevenLabs API key</label>
      <input id="elevenlabs-key" class="ark-input" type="password" bind:value={apiKey}
        placeholder="Paste your ElevenLabs API key" autocomplete="off" spellcheck={false} disabled={busy || active} />
      <label class="control-label" for="elevenlabs-voice">Voice ID (optional)</label>
      <input id="elevenlabs-voice" class="ark-input" bind:value={voiceId}
        placeholder="Auto-select an available account voice" autocomplete="off" disabled={busy || active} />
      <label class="control-label" for="elevenlabs-model">Speech model</label>
      <input id="elevenlabs-model" class="ark-input" bind:value={modelId} disabled={busy || active} />
      <button type="submit" class="event-trigger-btn" disabled={busy || active || apiKey.trim().length < 8 || !modelId.trim()}>
        {busy ? 'Checking ElevenLabs…' : 'Connect ElevenLabs'}
      </button>
    </form>
    <p class="mission-hint">The key is sent to your local backend and kept in memory until it restarts. It is never saved in browser storage or written to .env. Connection checks use a short speech sample. Auto-selecting a voice requires Voices read permission.</p>
  {/if}
  {#if error}<p class="mission-error" role="alert">{error}</p>{/if}
</div>

<style>
  .voice-setup { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid rgba(148, 180, 204, 0.16); }
  form { display: grid; gap: 8px; }
</style>
