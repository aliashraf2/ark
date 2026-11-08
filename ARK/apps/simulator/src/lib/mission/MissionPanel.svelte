<script lang="ts">
  import { onMount, tick } from 'svelte'

  import type { SimulationEngine } from '../core/SimulationEngine'
  import type { PlanetId } from '../../../../../packages/physics/src/worlds/PlanetConfig'
  import { CommandDispatcher } from './CommandDispatcher'
  import {
    MissionClient,
    MissionClientError,
    type CapabilityInfo,
    type InterpretResponse,
    type SynthesizedSpec,
  } from './MissionClient'
  import type { AuditRecord, CommandResult, WorldStateSnapshot } from './MissionTypes'
  import { normalizeCommand, type NormalizedCommand } from './WorldCommands'

  export let engine: SimulationEngine | null = null
  export let disabled: boolean = false
  /** Called after agent-driven changes so host sliders re-sync from state. */
  export let onEnvironmentChanged: () => void = () => {}
  export let notify: (message: string) => void = () => {}
  export let onRobotMission: (command: NormalizedCommand) => string = () => {
    throw new Error('Robot mission execution is unavailable.')
  }

  type AgentStatus =
    | 'idle'
    | 'understanding'
    | 'preparing'
    | 'awaiting-approval'
    | 'applying'
    | 'verifying'
    | 'completed'
    | 'failed'
  type BackendStatus = 'unknown' | 'online' | 'offline' | 'no-llm'
  type MessageKind = 'operator' | 'agent' | 'system' | 'error'

  interface ChatMessage {
    id: number
    kind: MessageKind
    text: string
  }

  interface PendingProposal {
    requestId: string
    requestText: string
    commands: NormalizedCommand[]
    warnings: string[]
    capabilityIds: string[]
  }

  const AGENT_URL =
    (import.meta.env?.['VITE_AGENT_URL'] as string | undefined) ?? 'http://localhost:8000'

  let client = new MissionClient(AGENT_URL)
  let dispatcher: CommandDispatcher | null = null
  let messages: ChatMessage[] = []
  let messageSeq = 0
  let inputText = ''
  let busy = false
  let agentStatus: AgentStatus = 'idle'
  let backendStatus: BackendStatus = 'unknown'
  let backendProvider: string | null = null
  let backendModel: string | null = null
  let capabilities: CapabilityInfo[] = []
  let setupProvider: 'gemini' | 'anthropic' = 'gemini'
  let setupKey = ''
  let setupModel = ''
  let setupBusy = false
  let setupError: string | null = null
  let showSetup = false
  let autoExecute = false
  let pending: PendingProposal | null = null
  let pendingSynthesis: { requestId: string; requestText: string; spec: SynthesizedSpec } | null = null
  let history: AuditRecord[] = []
  let scrollBox: HTMLDivElement | null = null

  $: if (engine && !dispatcher) {
    dispatcher = new CommandDispatcher(engine)
  }
  $: statusLabel = STATUS_LABELS[agentStatus]
  $: controlsOff = disabled || busy || !engine

  const STATUS_LABELS: Record<AgentStatus, string> = {
    idle: 'Standby',
    understanding: 'Understanding request',
    preparing: 'Preparing intervention',
    'awaiting-approval': 'Awaiting approval',
    applying: 'Applying change',
    verifying: 'Verifying outcome',
    completed: 'Completed',
    failed: 'Failed',
  }

  onMount(() => {
    void refreshBackendStatus()
    pushMessage(
      'system',
      'Mission Control link ready. Describe an environmental change — every proposal is validated locally before anything executes.',
    )
  })

  function pushMessage(kind: MessageKind, text: string): void {
    messages = [...messages.slice(-99), { id: messageSeq++, kind, text }]
    void tick().then(() => {
      scrollBox?.scrollTo({ top: scrollBox.scrollHeight })
    })
  }

  async function refreshBackendStatus(): Promise<void> {
    try {
      const health = await client.checkHealth()
      backendStatus = health.llm_configured ? 'online' : 'no-llm'
      backendProvider = health.provider
      backendModel = health.model
      if (backendStatus === 'online') {
        capabilities = await client.listCapabilities().catch(() => [])
      }
    } catch {
      backendStatus = 'offline'
      backendProvider = null
      backendModel = null
      capabilities = []
    }
  }

  async function saveSetup(): Promise<void> {
    if (setupBusy || setupKey.trim().length < 8) return
    setupBusy = true
    setupError = null
    try {
      const result = await client.configureBackend(
        setupProvider,
        setupKey.trim(),
        setupModel.trim() || undefined,
      )
      if (!result.configured) {
        setupError = result.error ?? 'Backend refused the key.'
        return
      }
      setupKey = ''
      setupModel = ''
      showSetup = false
      await refreshBackendStatus()
      pushMessage(
        'system',
        `Agent brain linked: ${result.provider} (${result.model ?? 'default model'}). Key validated and stored server-side — describe a change to begin.`,
      )
      notify('Mission Control: agent brain linked')
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'Setup failed.'
    } finally {
      setupBusy = false
    }
  }

  function snapshot(): WorldStateSnapshot | null {
    try {
      return engine?.getWorldState() ?? null
    } catch {
      return null
    }
  }

  function newRequestId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }

  async function sendMessage(): Promise<void> {
    const text = inputText.trim()
    if (!text || busy || !engine || disabled) return
    const world = snapshot()
    if (!world) {
      pushMessage('error', 'World snapshot unavailable — engine not ready.')
      return
    }
    busy = true
    agentStatus = 'understanding'
    pending = null
    pendingSynthesis = null
    inputText = ''
    pushMessage('operator', text)
    const requestId = newRequestId()
    try {
      await refreshBackendStatus()
      if (backendStatus === 'offline') {
        throw new MissionClientError(
          'NETWORK',
          'Cannot reach the mission-control backend. Start it with: cd services/agent && uv run uvicorn app:app --port 8000',
        )
      }
      const response = await client.interpret(text, world, requestId)
      handleInterpretation(response, text, world.planet)
    } catch (error) {
      agentStatus = 'failed'
      pushMessage('error', error instanceof Error ? error.message : 'Interpretation failed.')
    } finally {
      busy = false
    }
  }

  function handleInterpretation(
    response: InterpretResponse,
    requestText: string,
    planet: PlanetId,
  ): void {
    switch (response.status) {
      case 'clarification':
        agentStatus = 'completed'
        pushMessage('agent', response.message || 'Could you clarify that request?')
        return
      case 'unsupported':
        agentStatus = 'completed'
        pushMessage('agent', `Unsupported: ${response.message || 'no capability covers this.'}`)
        return
      case 'missing_capability': {
        agentStatus = 'failed'
        const detail = response.missing_capability?.description || response.message
        pushMessage('error', `Missing capability — nothing was executed. ${detail}`)
        return
      }
      case 'error':
        agentStatus = 'failed'
        pushMessage('error', response.error || response.message || 'Backend planning failed.')
        return
      case 'synthesis_proposed': {
        if (!response.synthesis_spec) {
          agentStatus = 'failed'
          pushMessage('error', 'Backend proposed a synthesis but omitted the spec.')
          return
        }
        pendingSynthesis = {
          requestId: response.request_id,
          requestText,
          spec: response.synthesis_spec,
        }
        agentStatus = 'awaiting-approval'
        pushMessage(
          'agent',
          `New capability “${response.synthesis_spec.name}” synthesized and validated. Review the steps below — approval registers it.`,
        )
        return
      }
      case 'proposed': {
        if (response.message && response.actions.length === 0) {
          agentStatus = 'completed'
          pushMessage('agent', response.message)
          return
        }
        if (response.actions.length === 0) {
          agentStatus = 'failed'
          pushMessage('error', 'Backend returned an empty proposal — nothing to execute.')
          return
        }
        stageProposal(response, requestText, planet)
        return
      }
      default:
        agentStatus = 'failed'
        pushMessage('error', `Unknown backend status “${response.status}”.`)
    }
  }

  function stageProposal(response: InterpretResponse, requestText: string, planet: PlanetId): void {
    // Local re-validation: the backend never gets the final word on physics safety.
    const commands: NormalizedCommand[] = []
    const warnings: string[] = []
    for (const action of response.actions) {
      const proposal = normalizeCommand(action.command, action.params, planet, action.command_id)
      if (!proposal.normalized) {
        agentStatus = 'failed'
        pushMessage(
          'error',
          `Local validation rejected “${action.command}”: ${proposal.validation.errors.join('; ')}`,
        )
        return
      }
      commands.push(proposal.normalized)
      warnings.push(...proposal.validation.warnings, ...action.warnings)
      if (proposal.validation.requiresConfirmation || action.requires_confirmation) {
        warnings.push(`“${action.command}” requires confirmation.`)
      }
    }
    const needsApproval =
      !autoExecute || response.actions.some((action) => action.requires_confirmation)
    if (!needsApproval) {
      agentStatus = 'preparing'
      void executeCommands(response.request_id, requestText, commands, warnings, response.capability_ids)
      return
    }
    pending = {
      requestId: response.request_id,
      requestText,
      commands,
      warnings: [...new Set(warnings)],
      capabilityIds: response.capability_ids,
    }
    agentStatus = 'awaiting-approval'
    pushMessage(
      'agent',
      `Proposed ${commands.length} change${commands.length === 1 ? '' : 's'} via ${response.capability_ids.join(', ') || 'world commands'}. Review and confirm below.`,
    )
  }

  async function executeCommands(
    requestId: string,
    requestText: string,
    commands: NormalizedCommand[],
    warnings: string[],
    capabilityIds: string[],
  ): Promise<void> {
    if (!dispatcher || !engine) return
    agentStatus = 'applying'
    const results: CommandResult[] = []
    for (const command of commands) {
      if (command.command === 'assign_rover_mission' || command.command === 'assign_drone_mission') {
        const before = snapshot()
        try {
          const message = onRobotMission(command)
          results.push({ commandId: command.commandId, command: command.command, outcome: 'executed', message, stateBefore: before, stateAfter: snapshot() })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Robot mission failed.'
          results.push({ commandId: command.commandId, command: command.command, outcome: 'failed', message, error: message, stateBefore: before, stateAfter: snapshot() })
        }
      } else {
        results.push(dispatcher.dispatch(command, { requestText, warnings }))
      }
    }
    history = dispatcher.history
    onEnvironmentChanged()
    const failed = results.filter((result) => result.outcome === 'failed')
    agentStatus = 'verifying'
    const world = snapshot()
    try {
      if (!world) throw new Error('World snapshot unavailable after execution.')
      const reply = await client.respond(requestId, requestText, results, world)
      agentStatus = failed.length > 0 ? 'failed' : 'completed'
      const prefix =
        failed.length > 0
          ? `Completed with ${failed.length} failure${failed.length === 1 ? '' : 's'} (via ${capabilityIds.join(', ') || 'world commands'}): `
          : ''
      pushMessage(failed.length > 0 ? 'error' : 'agent', `${prefix}${reply.reply}`)
    } catch (error) {
      // Verified results exist locally — report them even if the summary call fails.
      agentStatus = failed.length > 0 ? 'failed' : 'completed'
      pushMessage(
        failed.length > 0 ? 'error' : 'agent',
        `${localSummary(results)} (Summary service unreachable: ${error instanceof Error ? error.message : 'unknown'}.)`,
      )
    }
    notify(
      failed.length > 0
        ? `Mission Control: ${failed.length} command${failed.length === 1 ? '' : 's'} failed`
        : 'Mission Control: change verified',
    )
  }

  function localSummary(results: CommandResult[]): string {
    return results
      .map((result) =>
        result.outcome === 'executed' || result.outcome === 'read'
          ? `✓ ${result.command}: ${result.message}`
          : `✗ ${result.command}: ${result.error ?? result.message}`,
      )
      .join('\n')
  }

  function confirmPending(): void {
    if (!pending || busy) return
    const proposal = pending
    pending = null
    busy = true
    agentStatus = 'preparing'
    void executeCommands(
      proposal.requestId,
      proposal.requestText,
      proposal.commands,
      proposal.warnings,
      proposal.capabilityIds,
    ).finally(() => {
      busy = false
    })
  }

  function dismissPending(): void {
    pending = null
    pendingSynthesis = null
    agentStatus = 'idle'
    pushMessage('system', 'Proposal dismissed — no changes were made.')
  }

  async function approveSynthesis(): Promise<void> {
    if (!pendingSynthesis || busy || !engine) return
    busy = true
    agentStatus = 'applying'
    const { requestId, requestText, spec } = pendingSynthesis
    try {
      const approval = await client.approveCapability(spec.name)
      if (!approval.approved) {
        throw new Error(approval.error ?? 'Backend refused approval.')
      }
      pendingSynthesis = null
      capabilities = await client.listCapabilities().catch(() => capabilities)
      // Approved steps execute as an ordinary validated proposal.
      const world = snapshot()
      if (!world) throw new Error('World snapshot unavailable.')
      const staged: InterpretResponse = {
        request_id: requestId,
        status: 'proposed',
        message: '',
        actions: approval.actions,
        capability_ids: [spec.name],
      }
      stageProposalAsApproved(staged, requestText, world.planet)
    } catch (error) {
      agentStatus = 'failed'
      pushMessage('error', error instanceof Error ? error.message : 'Approval failed.')
      busy = false
    }
  }

  function stageProposalAsApproved(
    response: InterpretResponse,
    requestText: string,
    planet: PlanetId,
  ): void {
    const commands: NormalizedCommand[] = []
    for (const action of response.actions) {
      const proposal = normalizeCommand(action.command, action.params, planet, action.command_id)
      if (!proposal.normalized) {
        agentStatus = 'failed'
        pushMessage(
          'error',
          `Approved synthesis failed local validation: ${proposal.validation.errors.join('; ')}`,
        )
        busy = false
        return
      }
      commands.push(proposal.normalized)
    }
    agentStatus = 'preparing'
    pushMessage('agent', `Capability “${response.capability_ids[0] ?? 'synthesis'}” approved and registered. Executing ${commands.length} validated steps.`)
    void executeCommands(response.request_id, requestText, commands, [], response.capability_ids).finally(
      () => {
        busy = false
      },
    )
  }

  function replayRecord(record: AuditRecord): void {
    if (!dispatcher || busy || disabled) return
    busy = true
    try {
      const results = dispatcher.replay(record)
      history = dispatcher.history
      onEnvironmentChanged()
      const failed = results.filter((result) => result.outcome === 'failed')
      pushMessage(
        failed.length > 0 ? 'error' : 'agent',
        failed.length > 0
          ? `Replay of “${record.requestText || record.capability}” completed with failures:\n${localSummary(results)}`
          : `Replayed “${record.requestText || record.capability}” from seed ${record.stateBefore.seed}:\n${localSummary(results)}`,
      )
      agentStatus = failed.length > 0 ? 'failed' : 'completed'
    } finally {
      busy = false
    }
  }

  function describeCommand(command: NormalizedCommand): string {
    const params = Object.entries(command.params)
      .map(([key, value]) => `${key}=${formatParam(value)}`)
      .join(', ')
    return `${command.command}${params ? ` (${params})` : ''}`
  }

  function formatParam(value: unknown): string {
    if (typeof value === 'object' && value !== null) return JSON.stringify(value)
    return String(value)
  }

  function historyLabel(record: AuditRecord): string {
    return record.requestText || record.capability
  }
</script>

<div class="mission-panel">
  <!-- Agent Link status -->
  <div class="dock-section">
    <div class="section-title-row">
      <h3 class="section-title">Agent Link</h3>
      <span
        class="section-badge"
        class:badge-ok={backendStatus === 'online'}
        class:badge-warn={backendStatus === 'no-llm'}
        class:badge-bad={backendStatus === 'offline'}
      >
        {#if backendStatus === 'online'}LINKED · LLM READY
        {:else if backendStatus === 'no-llm'}LINKED · NO LLM KEY
        {:else if backendStatus === 'offline'}BACKEND OFFLINE
        {:else}PROBING…
        {/if}
      </span>
    </div>
    <div class="mission-status-row">
      <span class="status-beacon" class:busy class:failed={agentStatus === 'failed'}></span>
      <span class="mission-status-label">{statusLabel}</span>
      <button type="button" class="preset-pill" on:click={() => void refreshBackendStatus()}>
        Reconnect
      </button>
      {#if backendStatus === 'online'}
        <button type="button" class="preset-pill" on:click={() => (showSetup = !showSetup)}>
          {showSetup ? 'Hide setup' : 'Replace key'}
        </button>
      {/if}
    </div>
    <div class="switch-row">
      <div class="switch-label-wrap">
        <span class="switch-title">Auto-execute safe actions</span>
        <span class="switch-subtext">Off by default. Confirmations still required for risky ops.</span>
      </div>
      <label class="apple-switch">
        <input type="checkbox" bind:checked={autoExecute} disabled={controlsOff && !engine} />
        <span class="switch-slider"></span>
      </label>
    </div>
    {#if backendStatus === 'online' && backendProvider}
      <p class="mission-hint mono">brain: {backendProvider} · {backendModel ?? 'default'}</p>
    {/if}
    {#if backendStatus === 'no-llm' || showSetup}
      <div class="mission-setup">
        {#if backendStatus === 'online'}
          <p class="mission-hint">Paste a replacement key — it is validated live, then overwrites the backend's local <span class="mono">.env</span> (never stored in the browser).</p>
        {:else}
          <p class="mission-hint">No agent brain linked. Paste an API key — it is validated, then stored in the backend's local <span class="mono">.env</span> (never in the browser).</p>
        {/if}
        <div class="control-group">
          <label class="control-label" for="mission-setup-provider">Provider</label>
          <select
            id="mission-setup-provider"
            class="ark-select"
            bind:value={setupProvider}
            disabled={setupBusy}
          >
            <option value="gemini">Gemini (Google AI Studio)</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </select>
        </div>
        <div class="control-group">
          <label class="control-label" for="mission-setup-key">API key</label>
          <input
            id="mission-setup-key"
            class="ark-input mono"
            type="password"
            placeholder={setupProvider === 'gemini' ? 'AIza… (aistudio.google.com/apikey)' : 'sk-ant-…'}
            bind:value={setupKey}
            disabled={setupBusy}
            autocomplete="off"
          />
        </div>
        <div class="control-group">
          <label class="control-label" for="mission-setup-model">Model (optional)</label>
          <input
            id="mission-setup-model"
            class="ark-input mono"
            type="text"
            placeholder={setupProvider === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5'}
            bind:value={setupModel}
            disabled={setupBusy}
            autocomplete="off"
          />
        </div>
        {#if setupError}
          <p class="mission-error">{setupError}</p>
        {/if}
        <button
          type="button"
          class="event-trigger-btn"
          on:click={() => void saveSetup()}
          disabled={setupBusy || setupKey.trim().length < 8}
        >
          <span>{setupBusy ? 'Validating…' : 'Link Agent Brain'}</span>
        </button>
      </div>
    {/if}
    {#if backendStatus === 'offline'}
      <p class="mission-hint">
        Backend unreachable. Start it once with:
        <span class="mono">cd services/agent && uv run uvicorn app:app --port 8000</span>
      </p>
    {/if}
    {#if capabilities.length > 0}
      <p class="mission-hint">{capabilities.length} capabilities registered (incl. synthesized).</p>
    {/if}
  </div>

  <!-- Conversation -->
  <div class="dock-section mission-chat-section">
    <div class="section-title-row">
      <h3 class="section-title">Conversation</h3>
      <span class="section-badge">NL → PHYSICS</span>
    </div>
    <div class="mission-chat-log" bind:this={scrollBox} role="log" aria-live="polite">
      {#each messages as message (message.id)}
        <div class="mission-msg mission-msg-{message.kind}">
          <span class="mission-msg-tag">
            {#if message.kind === 'operator'}OP
            {:else if message.kind === 'agent'}AI
            {:else if message.kind === 'error'}ERR
            {:else}SYS
            {/if}
          </span>
          <span class="mission-msg-text">{message.text}</span>
        </div>
      {/each}
    </div>
    <div class="mission-input-row">
      <input
        class="ark-input mission-input"
        type="text"
        placeholder="e.g. Set wind to 12 m/s from the west"
        bind:value={inputText}
        on:keydown={(event) => event.key === 'Enter' && void sendMessage()}
        disabled={controlsOff}
        aria-label="Mission Control instruction"
      />
      <button
        type="button"
        class="event-trigger-btn mission-send"
        on:click={() => void sendMessage()}
        disabled={controlsOff || inputText.trim().length === 0}
      >
        Send
      </button>
    </div>
  </div>

  <!-- Pending proposal -->
  {#if pending}
    <div class="dock-section mission-proposal">
      <div class="section-title-row">
        <h3 class="section-title">Proposed Intervention</h3>
        <span class="section-badge badge-warn">AWAITING APPROVAL</span>
      </div>
      <ul class="mission-step-list">
        {#each pending.commands as command (command.commandId)}
          <li class="mono">{describeCommand(command)}</li>
        {/each}
      </ul>
      {#if pending.warnings.length > 0}
        <ul class="mission-warn-list">
          {#each pending.warnings as warning (warning)}
            <li>⚠ {warning}</li>
          {/each}
        </ul>
      {/if}
      <div class="event-triggers-grid">
        <button type="button" class="event-trigger-btn" on:click={confirmPending} disabled={busy}>
          Confirm & Execute
        </button>
        <button type="button" class="event-trigger-btn" on:click={dismissPending} disabled={busy}>
          Dismiss
        </button>
      </div>
    </div>
  {/if}

  <!-- Pending synthesis -->
  {#if pendingSynthesis}
    <div class="dock-section mission-proposal">
      <div class="section-title-row">
        <h3 class="section-title">Synthesized Capability</h3>
        <span class="section-badge badge-warn">FIRST ACTIVATION</span>
      </div>
      <p class="mission-hint">
        <strong>{pendingSynthesis.spec.name}</strong> — {pendingSynthesis.spec.description ||
          'No description.'}
      </p>
      <ul class="mission-step-list">
        {#each pendingSynthesis.spec.steps as step, index (`${step.command}-${index}`)}
          <li class="mono">
            {index + 1}. {step.command} ({Object.entries(step.params)
              .map(([key, value]) => `${key}=${formatParam(value)}`)
              .join(', ')})
          </li>
        {/each}
      </ul>
      <div class="event-triggers-grid">
        <button
          type="button"
          class="event-trigger-btn"
          on:click={() => void approveSynthesis()}
          disabled={busy}
        >
          Approve & Register
        </button>
        <button type="button" class="event-trigger-btn" on:click={dismissPending} disabled={busy}>
          Reject
        </button>
      </div>
    </div>
  {/if}

  <!-- Audit history -->
  {#if history.length > 0}
    <div class="dock-section">
      <div class="section-title-row">
        <h3 class="section-title">Intervention History</h3>
        <span class="section-badge">{history.length} RECORDS</span>
      </div>
      <ul class="mission-history-list">
        {#each history.slice(-8).reverse() as record (record.commandId)}
          <li class="mission-history-item">
            <div class="mission-history-main">
              <span class="mission-history-outcome" class:failed={record.outcome === 'failed'}>
                {record.outcome.toUpperCase()}
              </span>
              <span class="mission-history-text">{historyLabel(record)}</span>
            </div>
            <div class="mission-history-meta mono">
              {record.capability} · {record.planet} · t={record.simTime.toFixed(1)}s
            </div>
            <button
              type="button"
              class="preset-pill"
              on:click={() => replayRecord(record)}
              disabled={busy || disabled}
              title="Replay from seed {record.stateBefore.seed}"
            >
              Replay
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
