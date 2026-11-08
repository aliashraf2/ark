import { afterEach, describe, expect, it, vi } from 'vitest'

import { MissionClient, MissionClientError } from './MissionClient'

// MissionClient is browser code (window timers + fetch); stub the host surface.
vi.stubGlobal('window', { setTimeout, clearTimeout })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Test J — MissionClient failure handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
  })

  it('maps connection failures to NETWORK errors, never silent stalls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const client = new MissionClient('http://localhost:8000')
    const error = await client.checkHealth().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissionClientError)
    expect((error as MissionClientError).code).toBe('NETWORK')
  })

  it('maps HTTP 503 (no LLM key) to SERVER errors with status text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"detail":"no key"}', { status: 503 })),
    )
    const client = new MissionClient('http://localhost:8000')
    const error = await client
      .interpret('Set wind.', { planet: 'earth' } as never, 'r1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissionClientError)
    expect((error as MissionClientError).code).toBe('SERVER')
    expect((error as MissionClientError).message).toContain('503')
  })

  it('maps malformed payloads to INVALID_RESPONSE errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nonsense: true })))
    const client = new MissionClient('http://localhost:8000')
    const error = await client
      .interpret('Set wind.', { planet: 'earth' } as never, 'r1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissionClientError)
    expect((error as MissionClientError).code).toBe('INVALID_RESPONSE')
  })

  it('maps aborts to TIMEOUT errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }),
    )
    const client = new MissionClient('http://localhost:8000', 20)
    const error = await client
      .interpret('Set wind.', { planet: 'earth' } as never, 'r1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissionClientError)
    expect((error as MissionClientError).code).toBe('TIMEOUT')
  })

  it('parses provider/model health fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', llm_configured: true, provider: 'gemini', model: 'gemini-2.5-flash' })),
    )
    const client = new MissionClient('http://localhost:8000')
    const health = await client.checkHealth()
    expect(health.llm_configured).toBe(true)
    expect(health.provider).toBe('gemini')
    expect(health.model).toBe('gemini-2.5-flash')
  })

  it('parses setup (configure) results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ configured: true, provider: 'gemini', model: 'gemini-2.5-flash' })),
    )
    const client = new MissionClient('http://localhost:8000')
    const result = await client.configureBackend('gemini', 'test-key-12345678')
    expect(result.configured).toBe(true)
    expect(result.provider).toBe('gemini')
  })

  it('parses a well-formed interpret response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          request_id: 'r1',
          status: 'proposed',
          message: '',
          actions: [
            {
              command_id: 'a1',
              command: 'set_wind',
              params: { speed_mps: 5, direction_from_deg: 0 },
              requires_confirmation: false,
              reversible: true,
              warnings: [],
              rationale: 'test',
            },
          ],
          capability_ids: ['set_wind'],
        }),
      ),
    )
    const client = new MissionClient('http://localhost:8000')
    const response = await client.interpret('Set wind.', { planet: 'earth' } as never, 'r1')
    expect(response.status).toBe('proposed')
    expect(response.actions).toHaveLength(1)
    expect(response.actions[0]?.command).toBe('set_wind')
  })
})
