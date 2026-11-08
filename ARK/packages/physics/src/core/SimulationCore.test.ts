import { describe, expect, it } from 'vitest'

import { SimulationCore } from './SimulationCore'

const NEUTRAL = { left: 0, right: 0, brake: true, eStop: false }
const FORWARD = { left: 1, right: 1, brake: false, eStop: false }

describe('SimulationCore (6.1 headless facade)', () => {
  it('creates a Mars sim in Node with no DOM (Test A)', async () => {
    expect(typeof window).toBe('undefined')
    const sim = await SimulationCore.create({ planet: 'mars', seed: 42 })
    try {
      const state = sim.getState()
      expect(state.planet).toBe('mars')
      expect(state.seed).toBe(42)
      expect(state.stepCount).toBe(0)
      expect(state.simTimeS).toBe(0)
      expect(state.robots).toHaveLength(1)
    } finally {
      sim.dispose()
    }
  })

  it('drops the rover onto terrain under gravity (Tests B/C)', async () => {
    const sim = await SimulationCore.create({ planet: 'mars', seed: 7 })
    try {
      const id = sim.getState().robots[0]?.id
      if (!id) throw new Error('no rover')
      sim.applyRobotAction(id, NEUTRAL)
      const y0 = sim.getRobotState(id)?.position.y ?? 0
      for (let i = 0; i < 120; i += 1) sim.step()
      const after = sim.getRobotState(id)
      if (!after) throw new Error('rover missing')
      // Fell, then terrain stopped it (finite height, ~zero vertical speed).
      expect(after.position.y).toBeLessThan(y0)
      expect(Number.isFinite(after.position.y)).toBe(true)
      expect(Math.abs(after.linearVelocity.y)).toBeLessThan(0.5)
    } finally {
      sim.dispose()
    }
  })

  it('drives under action with valid sensors (Tests E/F/G)', async () => {
    const sim = await SimulationCore.create({ planet: 'earth', seed: 11 })
    try {
      const id = sim.getState().robots[0]?.id
      if (!id) throw new Error('no rover')
      sim.applyRobotAction(id, NEUTRAL)
      for (let i = 0; i < 60; i += 1) sim.step()
      const p0 = sim.getRobotState(id)?.position
      sim.applyRobotAction(id, FORWARD)
      for (let i = 0; i < 240; i += 1) sim.step()
      const p1 = sim.getRobotState(id)
      if (!p0 || !p1) throw new Error('rover missing')
      expect(Math.hypot(p1.position.x - p0.x, p1.position.z - p0.z)).toBeGreaterThan(1)
      expect(p1.ranges).toHaveLength(5)
      for (const reading of p1.ranges) {
        expect(Number.isFinite(reading.distance)).toBe(true)
        expect(reading.distance).toBeGreaterThanOrEqual(0)
      }
      expect(p1.batteryPercent).toBeGreaterThanOrEqual(0)
      expect(p1.batteryPercent).toBeLessThanOrEqual(1)
    } finally {
      sim.dispose()
    }
  })

  it('reset restores the initial state (Test H)', async () => {
    const sim = await SimulationCore.create({ planet: 'mars', seed: 5 })
    try {
      const id = sim.getState().robots[0]?.id
      if (!id) throw new Error('no rover')
      sim.applyRobotAction(id, FORWARD)
      for (let i = 0; i < 120; i += 1) sim.step()
      expect(sim.getState().stepCount).toBe(120)
      sim.reset()
      const state = sim.getState()
      expect(state.stepCount).toBe(0)
      expect(state.simTimeS).toBe(0)
      expect(state.robots[0]?.batteryPercent).toBeCloseTo(1, 9)
    } finally {
      sim.dispose()
    }
  })

  it('repeats seeded runs exactly (Test I)', async () => {
    const runOnce = async (): Promise<[number, number, number]> => {
      const sim = await SimulationCore.create({ planet: 'mars', seed: 42 })
      try {
        const id = sim.getState().robots[0]?.id
        if (!id) throw new Error('no rover')
        for (let step = 1; step <= 300; step += 1) {
          sim.applyRobotAction(id, step < 100 ? NEUTRAL : FORWARD)
          sim.step()
        }
        const p = sim.getRobotState(id)?.position
        if (!p) throw new Error('rover missing')
        return [p.x, p.y, p.z]
      } finally {
        sim.dispose()
      }
    }
    const first = await runOnce()
    const second = await runOnce()
    expect(first).toEqual(second)
  })

  it('rejects unknown robot ids', async () => {
    const sim = await SimulationCore.create({ planet: 'earth', seed: 3 })
    try {
      expect(() => sim.applyRobotAction('rover-999', FORWARD)).toThrow()
      expect(sim.getRobotState('rover-999')).toBeNull()
    } finally {
      sim.dispose()
    }
  })
})
