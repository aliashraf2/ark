import { describe, expect, it } from 'vitest'
import { CommunicationNetwork } from './CommunicationNetwork'
import type { RobotMessage } from './MessageProtocol'

const message: RobotMessage = {
  messageId: 'm1', senderId: 'a', recipientId: 'b', type: 'STATUS_UPDATE', simulationTimeS: 1,
  position: { x: 0, y: 0, z: 0 }, batteryPercent: 1, missionStatus: 'idle', capabilities: [],
}

describe('CommunicationNetwork', () => {
  it('delivers only after configured latency and while still in range', () => {
    const network = new CommunicationNetwork({ rangeM: 10, latencyS: 0.5, lossProbability: 0 }, 1)
    const positions = new Map([['a', message.position], ['b', { x: 2, y: 0, z: 0 }]])
    expect(network.send(message, positions)).toBe(1)
    expect(network.update(1.49, positions)).toHaveLength(0)
    expect(network.update(1.5, positions)).toHaveLength(1)
    network.send(message, positions)
    positions.set('b', { x: 20, y: 0, z: 0 })
    expect(network.update(2, positions)).toHaveLength(0)
  })

  it('enforces range and seeded packet loss', () => {
    const far = new CommunicationNetwork({ rangeM: 3, latencyS: 0, lossProbability: 0 }, 1)
    expect(far.send(message, new Map([['a', message.position], ['b', { x: 4, y: 0, z: 0 }]]))).toBe(0)
    const lossy = new CommunicationNetwork({ rangeM: 10, latencyS: 0, lossProbability: 1 }, 1)
    expect(lossy.send(message, new Map([['a', message.position], ['b', { x: 1, y: 0, z: 0 }]]))).toBe(0)
    expect(lossy.droppedCount).toBe(1)
  })
})
