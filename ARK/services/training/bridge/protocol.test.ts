import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION, errorResponse, parseRequest, successResponse } from './protocol'

const base = { protocolVersion: '1.0', requestId: 'r1' }

describe('parseRequest', () => {
  it('accepts a valid env-scoped request', () => {
    const parsed = parseRequest(JSON.stringify({ ...base, command: 'step', envId: 'env-1', payload: { action: [0, 0] } }))
    expect(parsed.error).toBeNull()
    expect(parsed.request).toMatchObject({ requestId: 'r1', command: 'step', envId: 'env-1' })
  })

  it('accepts global commands without envId', () => {
    for (const command of ['hello', 'create', 'get_spaces', 'shutdown']) {
      const parsed = parseRequest(JSON.stringify({ ...base, command }))
      expect(parsed.error).toBeNull()
    }
  })

  it('rejects non-JSON with null requestId', () => {
    const parsed = parseRequest('nope{')
    expect(parsed.requestId).toBeNull()
    expect(parsed.error?.code).toBe('bad_request')
  })

  it('rejects missing requestId', () => {
    const parsed = parseRequest(JSON.stringify({ protocolVersion: '1.0', command: 'hello' }))
    expect(parsed.error?.code).toBe('bad_request')
  })

  it('rejects version mismatch but keeps the requestId', () => {
    const parsed = parseRequest(JSON.stringify({ ...base, protocolVersion: '9.9', command: 'hello' }))
    expect(parsed.requestId).toBe('r1')
    expect(parsed.error?.code).toBe('version_mismatch')
  })

  it('rejects unknown commands', () => {
    const parsed = parseRequest(JSON.stringify({ ...base, command: 'teleport' }))
    expect(parsed.error?.code).toBe('unknown_command')
  })

  it('requires envId for env-scoped commands', () => {
    for (const command of ['reset', 'step', 'get_metrics', 'close']) {
      const parsed = parseRequest(JSON.stringify({ ...base, command }))
      expect(parsed.error?.code).toBe('bad_request')
    }
  })

  it('never throws on hostile input', () => {
    for (const line of ['', 'null', '[]', '42', '{"requestId":42}', '{"requestId":"x","command":null}']) {
      expect(() => parseRequest(line)).not.toThrow()
      expect(parseRequest(line).error).not.toBeNull()
    }
  })
})

describe('responses', () => {
  it('stamps the protocol version and request id', () => {
    expect(successResponse('a', { x: 1 })).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'a',
      ok: true,
      result: { x: 1 },
    })
    expect(errorResponse('b', 'unknown_env', 'gone')).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'b',
      ok: false,
      error: { code: 'unknown_env', message: 'gone' },
    })
  })
})
