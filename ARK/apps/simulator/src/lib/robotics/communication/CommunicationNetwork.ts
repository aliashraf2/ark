import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'
import { validateRobotMessage, type RobotMessage } from './MessageProtocol'

export interface CommunicationSettings {
  rangeM: number
  latencyS: number
  lossProbability: number
}

export const DEFAULT_COMMUNICATION_SETTINGS: Readonly<CommunicationSettings> = Object.freeze({
  rangeM: 40,
  latencyS: 0.25,
  lossProbability: 0,
})

export interface DeliveredRobotMessage {
  recipientId: string
  message: RobotMessage
  deliveredAtS: number
}

interface QueuedDelivery {
  recipientId: string
  message: RobotMessage
  deliverAtS: number
}

export type LineOfSight = (from: Vector3, to: Vector3) => boolean

/** Deterministic in-process message bus; it never routes beyond configured range. */
export class CommunicationNetwork {
  private queue: QueuedDelivery[] = []
  private random: () => number
  private droppedMessages = 0

  constructor(
    public settings: CommunicationSettings = { ...DEFAULT_COMMUNICATION_SETTINGS },
    seed = 1,
    private readonly lineOfSight?: LineOfSight,
  ) {
    this.random = mulberry32(seed)
    this.validateSettings(settings)
  }

  public get pendingCount(): number {
    return this.queue.length
  }

  public get droppedCount(): number {
    return this.droppedMessages
  }

  public send(message: RobotMessage, positions: ReadonlyMap<string, Vector3>): number {
    const error = validateRobotMessage(message)
    if (error) throw new Error(`Invalid robot message: ${error}`)
    const senderPosition = positions.get(message.senderId)
    if (!senderPosition) return 0
    const recipients = message.recipientId ? [message.recipientId] : [...positions.keys()]
    let scheduled = 0
    for (const recipientId of recipients) {
      if (recipientId === message.senderId) continue
      const recipientPosition = positions.get(recipientId)
      if (!recipientPosition || distanceXZ(senderPosition, recipientPosition) > this.settings.rangeM) continue
      if (this.lineOfSight && !this.lineOfSight(senderPosition, recipientPosition)) continue
      if (this.random() < this.settings.lossProbability) {
        this.droppedMessages += 1
        continue
      }
      this.queue.push({
        recipientId,
        message: cloneMessage(message),
        deliverAtS: message.simulationTimeS + this.settings.latencyS,
      })
      scheduled += 1
    }
    return scheduled
  }

  /** Returns due messages; a moving receiver must still be in radio range. */
  public update(
    simulationTimeS: number,
    positions: ReadonlyMap<string, Vector3>,
  ): DeliveredRobotMessage[] {
    const due: DeliveredRobotMessage[] = []
    const pending: QueuedDelivery[] = []
    for (const delivery of this.queue) {
      if (delivery.deliverAtS > simulationTimeS) {
        pending.push(delivery)
        continue
      }
      const senderPosition = positions.get(delivery.message.senderId)
      const recipientPosition = positions.get(delivery.recipientId)
      if (
        senderPosition && recipientPosition &&
        distanceXZ(senderPosition, recipientPosition) <= this.settings.rangeM &&
        (!this.lineOfSight || this.lineOfSight(senderPosition, recipientPosition))
      ) {
        due.push({ recipientId: delivery.recipientId, message: cloneMessage(delivery.message), deliveredAtS: simulationTimeS })
      }
    }
    this.queue = pending
    return due
  }

  public reset(seed = 1): void {
    this.queue = []
    this.droppedMessages = 0
    this.random = mulberry32(seed)
  }

  private validateSettings(settings: CommunicationSettings): void {
    if (!Number.isFinite(settings.rangeM) || settings.rangeM <= 0) throw new Error('rangeM must be positive.')
    if (!Number.isFinite(settings.latencyS) || settings.latencyS < 0) throw new Error('latencyS must be non-negative.')
    if (!Number.isFinite(settings.lossProbability) || settings.lossProbability < 0 || settings.lossProbability > 1) {
      throw new Error('lossProbability must be in [0, 1].')
    }
  }
}

function distanceXZ(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function cloneMessage(message: RobotMessage): RobotMessage {
  return {
    ...message,
    position: { ...message.position },
    capabilities: [...message.capabilities],
    ...(message.payload ? { payload: { ...message.payload } } : {}),
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

