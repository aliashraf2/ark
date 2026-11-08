import type { WorldStateSnapshot } from './MissionTypes'
import type { CommandResult } from './MissionTypes'

export type MissionClientErrorCode = 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'SERVER' | 'CANCELLED'

export class MissionClientError extends Error {
  public readonly code: MissionClientErrorCode

  constructor(code: MissionClientErrorCode, message: string) {
    super(message)
    this.name = 'MissionClientError'
    this.code = code
  }
}

export interface ProposedAction {
  command_id: string
  command: string
  params: Record<string, unknown>
  requires_confirmation: boolean
  reversible: boolean
  warnings: string[]
  rationale: string
}

export type InterpretStatus =
  | 'proposed'
  | 'clarification'
  | 'unsupported'
  | 'missing_capability'
  | 'synthesis_proposed'
  | 'error'

export interface InterpretResponse {
  request_id: string
  status: InterpretStatus
  message: string
  actions: ProposedAction[]
  capability_ids: string[]
  missing_capability?: { name: string; description: string }
  synthesis_spec?: SynthesizedSpec
  error?: string
}

export interface SynthesizedSpec {
  name: string
  version: string
  description: string
  steps: Array<{ command: string; params: Record<string, unknown> }>
  validation: { ok: boolean; errors: string[] }
}

export interface RespondResponse {
  request_id: string
  reply: string
}

export interface CapabilityInfo {
  name: string
  kind: 'registered' | 'synthesized'
  version: string
  description: string
}

export interface BackendHealth {
  status: string
  llm_configured: boolean
  provider: string | null
  model: string | null
}

export interface ConfigureResult {
  configured: boolean
  provider: string | null
  model: string | null
  error?: string
}

export interface ConversationEntry { role: 'user' | 'assistant'; content: string }

export function conversationHistory(messages: ReadonlyArray<{ kind: string; text: string }>): ConversationEntry[] {
  return messages.filter((message) => message.kind === 'operator' || message.kind === 'agent')
    .slice(-12).map((message) => ({ role: message.kind === 'operator' ? 'user' : 'assistant', content: message.text.slice(0, 2000) }))
}

const DEFAULT_TIMEOUT_MS = 90000

/**
 * HTTP client for the ARK mission-control backend. Timeouts, network failures,
 * and malformed payloads become typed MissionClientErrors — the UI renders
 * them as honest agent failures, never silent stalls.
 */
export class MissionClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.timeoutMs = timeoutMs
  }

  public async checkHealth(): Promise<BackendHealth> {
    const response = await this.request('GET', '/api/health', undefined, 8000)
    if (!isRecord(response) || typeof response['status'] !== 'string') {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed health report.')
    }
    return {
      status: response['status'],
      llm_configured: response['llm_configured'] === true,
      provider: typeof response['provider'] === 'string' ? response['provider'] : null,
      model: typeof response['model'] === 'string' ? response['model'] : null,
    }
  }

  public async configureBackend(
    provider: 'gemini' | 'anthropic' | 'muse',
    apiKey: string,
    model?: string,
  ): Promise<ConfigureResult> {
    const response = await this.request(
      'POST',
      '/api/mission/configure',
      { provider, api_key: apiKey, model: model?.trim() ? model.trim() : null },
      60000,
    )
    if (!isRecord(response)) {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed setup result.')
    }
    return {
      configured: response['configured'] === true,
      provider: typeof response['provider'] === 'string' ? response['provider'] : null,
      model: typeof response['model'] === 'string' ? response['model'] : null,
      error: typeof response['error'] === 'string' ? response['error'] : undefined,
    }
  }

  public async interpret(
    message: string,
    worldState: WorldStateSnapshot,
    requestId: string,
    signal?: AbortSignal,
    history: ConversationEntry[] = [],
  ): Promise<InterpretResponse> {
    const response = await this.request('POST', '/api/mission/interpret', {
      request_id: requestId,
      message,
      world_state: worldState,
      conversation_history: history,
    }, this.timeoutMs, signal)
    if (!isRecord(response) || typeof response['status'] !== 'string') {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed interpretation.')
    }
    return {
      request_id: typeof response['request_id'] === 'string' ? response['request_id'] : requestId,
      status: response['status'] as InterpretStatus,
      message: typeof response['message'] === 'string' ? response['message'] : '',
      actions: Array.isArray(response['actions']) ? (response['actions'] as ProposedAction[]) : [],
      capability_ids: Array.isArray(response['capability_ids'])
        ? (response['capability_ids'] as string[])
        : [],
      missing_capability: response['missing_capability'] as InterpretResponse['missing_capability'],
      synthesis_spec: response['synthesis_spec'] as SynthesizedSpec | undefined,
      error: response['error'] as string | undefined,
    }
  }

  public async respond(
    requestId: string,
    message: string,
    results: CommandResult[],
    worldState: WorldStateSnapshot,
    signal?: AbortSignal,
  ): Promise<RespondResponse> {
    const response = await this.request('POST', '/api/mission/respond', {
      request_id: requestId,
      message,
      results: results.map((result) => ({
        command_id: result.commandId,
        command: result.command,
        outcome: result.outcome,
        message: result.message,
        error: result.error ?? null,
      })),
      world_state: worldState,
    }, this.timeoutMs, signal)
    if (!isRecord(response) || typeof response['reply'] !== 'string') {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed reply.')
    }
    return { request_id: requestId, reply: response['reply'] }
  }

  public async listCapabilities(): Promise<CapabilityInfo[]> {
    const response = await this.request('GET', '/api/mission/capabilities', undefined, 15000)
    if (!isRecord(response) || !Array.isArray(response['capabilities'])) {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed capability list.')
    }
    return response['capabilities'] as CapabilityInfo[]
  }

  public async approveCapability(name: string, expectedSteps?: SynthesizedSpec['steps'], signal?: AbortSignal): Promise<{
    approved: boolean
    actions: ProposedAction[]
    error?: string
  }> {
    const response = await this.request('POST', '/api/mission/approve_capability', { name, expected_steps: expectedSteps }, 15000, signal)
    if (!isRecord(response)) {
      throw new MissionClientError('INVALID_RESPONSE', 'Backend returned a malformed approval.')
    }
    return {
      approved: response['approved'] === true,
      actions: Array.isArray(response['actions']) ? (response['actions'] as ProposedAction[]) : [],
      error: typeof response['error'] === 'string' ? response['error'] : undefined,
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      })
      if (!response.ok) {
        const detail = await safeErrorDetail(response)
        throw new MissionClientError(
          'SERVER',
          `Backend error ${response.status}${detail ? `: ${detail}` : ''}.`,
        )
      }
      try {
        return (await response.json()) as unknown
      } catch {
        throw new MissionClientError('INVALID_RESPONSE', 'Backend returned invalid JSON.')
      }
    } catch (error) {
      if (signal?.aborted) throw new MissionClientError('CANCELLED', 'Pending Mission Control request cancelled.')
      if (error instanceof MissionClientError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new MissionClientError(
          'TIMEOUT',
          `Backend did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        )
      }
      throw new MissionClientError(
        'NETWORK',
        'Cannot reach the mission-control backend. Is the agent service running?',
      )
    } finally {
      window.clearTimeout(timer)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 200)
  } catch {
    return ''
  }
}
