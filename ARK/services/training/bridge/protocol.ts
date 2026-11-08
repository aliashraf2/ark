/**
 * Bridge wire protocol (v1): newline-delimited JSON over the child process's
 * stdin/stdout. Pure encode/decode/validation helpers — no simulation imports,
 * so they are unit-testable in isolation.
 *
 * Request:  { protocolVersion, requestId, command, envId?, payload? }\n
 * Response: { protocolVersion, requestId, ok: true, result } or
 *           { protocolVersion, requestId, ok: false, error: { code, message } }
 */

export const PROTOCOL_VERSION = '1.0' as const

export const COMMANDS = [
  'hello',
  'create',
  'reset',
  'step',
  'get_spaces',
  'get_metrics',
  'close',
  'shutdown',
] as const

export type BridgeCommand = (typeof COMMANDS)[number]

export type BridgeErrorCode =
  | 'bad_request'
  | 'unknown_command'
  | 'version_mismatch'
  | 'unknown_env'
  | 'env_limit'
  | 'validation_error'
  | 'step_before_reset'
  | 'step_after_done'
  | 'env_error'
  | 'internal'

export interface BridgeRequest {
  protocolVersion: string
  requestId: string
  command: string
  envId?: string
  payload?: unknown
}

export interface BridgeErrorBody {
  code: BridgeErrorCode
  message: string
}

export type BridgeResponse =
  | { protocolVersion: string; requestId: string | null; ok: true; result: unknown }
  | { protocolVersion: string; requestId: string | null; ok: false; error: BridgeErrorBody }

/**
 * Commands that require an existing envId. get_spaces is global: spaces are
 * static per protocol version, identical for every environment.
 */
const ENV_SCOPED: ReadonlySet<string> = new Set(['reset', 'step', 'get_metrics', 'close'])

export function successResponse(requestId: string | null, result: unknown): BridgeResponse {
  return { protocolVersion: PROTOCOL_VERSION, requestId, ok: true, result }
}

export function errorResponse(
  requestId: string | null,
  code: BridgeErrorCode,
  message: string,
): BridgeResponse {
  return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } }
}

export interface ParsedRequest {
  request: BridgeRequest
  error: BridgeErrorBody | null
}

/**
 * Parses + validates one raw line. Never throws: malformed input yields an
 * error body (with requestId null when the id itself is unreadable).
 */
export function parseRequest(line: string): { requestId: string | null; request: BridgeRequest | null; error: BridgeErrorBody | null } {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { requestId: null, request: null, error: { code: 'bad_request', message: 'Line is not valid JSON.' } }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { requestId: null, request: null, error: { code: 'bad_request', message: 'Request must be a JSON object.' } }
  }
  const record = raw as Record<string, unknown>
  const requestId = typeof record.requestId === 'string' && record.requestId.length > 0 ? record.requestId : null
  if (requestId === null) {
    return { requestId: null, request: null, error: { code: 'bad_request', message: 'requestId must be a non-empty string.' } }
  }
  if (record.protocolVersion !== PROTOCOL_VERSION) {
    return {
      requestId,
      request: null,
      error: {
        code: 'version_mismatch',
        message: `protocolVersion must be ${JSON.stringify(PROTOCOL_VERSION)}.`,
      },
    }
  }
  if (typeof record.command !== 'string' || !(COMMANDS as readonly string[]).includes(record.command)) {
    return {
      requestId,
      request: null,
      error: { code: 'unknown_command', message: `Unknown command ${JSON.stringify(record.command)}.` },
    }
  }
  const request: BridgeRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    command: record.command,
  }
  if (record.envId !== undefined) {
    if (typeof record.envId !== 'string' || record.envId.length === 0) {
      return { requestId, request: null, error: { code: 'bad_request', message: 'envId must be a non-empty string.' } }
    }
    request.envId = record.envId
  }
  if (record.payload !== undefined) request.payload = record.payload
  if (ENV_SCOPED.has(request.command) && request.envId === undefined) {
    return {
      requestId,
      request: null,
      error: { code: 'bad_request', message: `Command ${JSON.stringify(request.command)} requires envId.` },
    }
  }
  return { requestId, request, error: null }
}
