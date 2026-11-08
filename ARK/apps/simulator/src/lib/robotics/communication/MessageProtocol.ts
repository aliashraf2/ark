import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'

export const ROBOT_MESSAGE_TYPES = [
  'STATUS_UPDATE',
  'CAPABILITY_ADVERTISEMENT',
  'ASSISTANCE_REQUEST',
  'TASK_PROPOSAL',
  'TASK_ACCEPTED',
  'TASK_REJECTED',
  'MISSION_UPDATE',
  'MISSION_COMPLETE',
  'MISSION_FAILED',
] as const

export type RobotMessageType = (typeof ROBOT_MESSAGE_TYPES)[number]

/** Structured in-world message. Broadcasts omit recipientId. */
export interface RobotMessage {
  messageId: string
  senderId: string
  recipientId?: string
  type: RobotMessageType
  simulationTimeS: number
  position: Vector3
  batteryPercent: number
  missionStatus: string
  capabilities: readonly string[]
  taskId?: string
  payload?: Readonly<Record<string, unknown>>
}

export function validateRobotMessage(value: RobotMessage): string | null {
  if (!value.messageId || !value.senderId) return 'messageId and senderId are required.'
  if (!ROBOT_MESSAGE_TYPES.includes(value.type)) return 'unsupported message type.'
  if (!Number.isFinite(value.simulationTimeS) || value.simulationTimeS < 0) {
    return 'simulationTimeS must be a non-negative finite number.'
  }
  if (![value.position.x, value.position.y, value.position.z].every(Number.isFinite)) {
    return 'position must contain finite coordinates.'
  }
  if (!Number.isFinite(value.batteryPercent) || value.batteryPercent < 0 || value.batteryPercent > 1) {
    return 'batteryPercent must be within [0, 1].'
  }
  if (!Array.isArray(value.capabilities)) return 'capabilities must be an array.'
  return null
}

