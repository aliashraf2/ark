#!/usr/bin/env tsx
/**
 * ARK RL bridge server: persistent JSONL-over-stdio adapter exposing Phase 6.2
 * ArkEnvironment instances to Python. One process hosts many independent envs;
 * requests are processed strictly sequentially.
 *
 * CRITICAL: stdout carries ONLY protocol responses (one JSON object per line).
 * All diagnostics go to stderr. Never console.log here.
 *
 *   tsx services/training/bridge/server.ts
 */
import * as readline from 'node:readline'

import { PhysicsWorld } from '../../../packages/physics/src/physics/PhysicsWorld'
import type { ArkEnvironmentConfig, ResetOptions } from '../../../packages/rl/src/index'
import { EnvironmentRegistry, RegistryError, StepOrderError } from './environmentRegistry'
import {
  PROTOCOL_VERSION,
  errorResponse,
  parseRequest,
  successResponse,
  type BridgeErrorCode,
  type BridgeRequest,
} from './protocol'
import { NonFiniteValueError, serializeResult } from './serialization'

function log(message: string): void {
  console.error(`[bridge] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkSeed(seed: unknown): number | undefined {
  if (seed === undefined || seed === null) return undefined
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw new ValidationError('Reset seed must be an integer.')
  }
  return seed
}

function checkResetOptions(options: unknown): ResetOptions {
  if (options === undefined || options === null) return {}
  if (!isRecord(options)) throw new ValidationError('Reset options must be an object.')
  const out: ResetOptions = {}
  for (const key of ['start', 'target'] as const) {
    const point = options[key]
    if (point === undefined) continue
    if (!isRecord(point) || typeof point.x !== 'number' || typeof point.z !== 'number') {
      throw new ValidationError(`Reset option ${key} must be { x, z } with numbers.`)
    }
    out[key] = { x: point.x, z: point.z }
  }
  if (options.split !== undefined) {
    if (options.split !== 'train' && options.split !== 'eval') {
      throw new ValidationError('Reset option split must be "train" or "eval".')
    }
    out.split = options.split
  }
  return out
}

function checkAction(action: unknown, expectedSize: number): number[] {
  if (!Array.isArray(action) || action.length !== expectedSize) {
    throw new ValidationError(`Action must be an array of ${expectedSize} numbers.`)
  }
  if (action.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ValidationError('Every action value must be a finite number.')
  }
  return action as number[]
}

class ValidationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

class BridgeServer {
  private readonly registry = new EnvironmentRegistry()
  private shuttingDown = false

  public async dispatch(request: BridgeRequest): Promise<{ result: unknown } | { code: BridgeErrorCode; message: string }> {
    try {
      switch (request.command) {
        case 'hello':
          return { result: { protocolVersion: PROTOCOL_VERSION, maxEnvs: 8 } }
        case 'create': {
          if (!isRecord(request.payload)) {
            return { code: 'validation_error', message: 'create payload must be an environment config object.' }
          }
          try {
            const envId = await this.registry.create(request.payload as unknown as ArkEnvironmentConfig & { agentType?: 'rover' | 'drone' })
            return { result: { envId } }
          } catch (error) {
            return this.asError(error)
          }
        }
        case 'reset': {
          const payload = isRecord(request.payload) ? request.payload : {}
          try {
            const result = this.registry.reset(
              request.envId as string,
              checkSeed(payload.seed),
              checkResetOptions(payload.options),
            )
            return { result: serializeResult(result) }
          } catch (error) {
            return this.asError(error)
          }
        }
        case 'step': {
          if (!isRecord(request.payload)) {
            return { code: 'validation_error', message: 'step payload must be { action: [left, right] }.' }
          }
          try {
            const envId = request.envId as string
            const result = this.registry.step(envId, checkAction(request.payload.action, this.registry.actionSize(envId)))
            return { result: serializeResult(result) }
          } catch (error) {
            return this.asError(error)
          }
        }
        case 'get_spaces': {
          const payload = isRecord(request.payload) ? request.payload : {}
          const agentType = payload.agentType === 'drone' ? 'drone' : 'rover'
          return { result: this.registry.getSpaces(agentType) }
        }
        case 'get_metrics': {
          try {
            return { result: this.registry.getMetrics(request.envId as string) }
          } catch (error) {
            return this.asError(error)
          }
        }
        case 'close': {
          try {
            this.registry.close(request.envId as string)
            return { result: { closed: true } }
          } catch (error) {
            return this.asError(error)
          }
        }
        case 'shutdown':
          this.shuttingDown = true
          return { result: { shutdown: true } }
        default:
          return { code: 'unknown_command', message: `Unknown command ${JSON.stringify(request.command)}.` }
      }
    } catch (error) {
      return this.asError(error)
    }
  }

  private asError(error: unknown): { code: BridgeErrorCode; message: string } {
    if (error instanceof RegistryError) return { code: error.code, message: error.message }
    if (error instanceof StepOrderError) return { code: error.code, message: error.message }
    if (error instanceof ValidationError) return { code: 'validation_error', message: error.message }
    if (error instanceof NonFiniteValueError) return { code: 'internal', message: error.message }
    if (error instanceof Error) {
      // Config/action validation from @ark/rl arrives here with clear messages;
      // classify obvious validation failures, keep the message either way.
      if (/must be|invalid|requires|outside|non-empty/i.test(error.message)) {
        return { code: 'validation_error', message: error.message }
      }
      log(`internal error: ${error.message}`)
      return { code: 'env_error', message: error.message }
    }
    return { code: 'internal', message: 'Unknown internal error.' }
  }

  public get done(): boolean {
    return this.shuttingDown
  }

  public dispose(): void {
    this.registry.closeAll()
  }
}

async function main(): Promise<void> {
  // Parent died mid-write: exit quietly instead of an unhandled EPIPE crash.
  process.stdout.on('error', (error: unknown) => {
    if ((error as { code?: string }).code === 'EPIPE') process.exit(0)
    console.error('[bridge] stdout error:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  await PhysicsWorld.init()
  const server = new BridgeServer()
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  // Sequential chain: every line fully handled before the next starts, so two
  // requests can never interleave inside one environment.
  let chain: Promise<void> = Promise.resolve()
  let closing = false

  const respond = (line: string): void => {
    // The ONLY stdout write in this process: one JSON object + newline.
    process.stdout.write(`${line}\n`)
  }

  const handleLine = async (line: string): Promise<void> => {
    if (line.trim() === '') return
    const parsed = parseRequest(line)
    if (!parsed.request || parsed.error) {
      respond(JSON.stringify(errorResponse(parsed.requestId, parsed.error?.code ?? 'bad_request', parsed.error?.message ?? 'Bad request.')))
      return
    }
    const outcome = await server.dispatch(parsed.request)
    if ('result' in outcome) {
      respond(JSON.stringify(successResponse(parsed.requestId, outcome.result)))
    } else {
      respond(JSON.stringify(errorResponse(parsed.requestId, outcome.code, outcome.message)))
    }
    if (server.done && !closing) {
      closing = true
      server.dispose()
      rl.close()
    }
  }

  rl.on('line', (line: string) => {
    chain = chain.then(() => handleLine(line)).catch((error: unknown) => {
      log(`dispatch failure: ${error instanceof Error ? error.message : error}`)
    })
  })

  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve())
    // stdin EOF (parent died): shut down instead of idling forever.
    process.stdin.on('end', () => resolve())
  })
  await chain
  server.dispose()
}

main().catch((error: unknown) => {
  console.error('[bridge] fatal:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
