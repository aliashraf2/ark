#!/usr/bin/env tsx
/**
 * ARK headless simulator: real Rapier physics + procedural terrain + rover,
 * no browser. Usage:
 *   npm run sim:headless -- --planet mars --seed 42 --steps 600
 *   npm run sim:headless -- --steps 10000 --benchmark
 *   npm run sim:headless -- --check-determinism
 */
import { SimulationCore, type DriveAction } from '../../../packages/physics/src/index'

interface CliOptions {
  planet: 'earth' | 'mars'
  seed: number
  steps: number
  benchmark: boolean
  checkDeterminism: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { planet: 'mars', seed: 42, steps: 600, benchmark: false, checkDeterminism: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--planet' && argv[i + 1]) {
      const value = argv[++i]
      if (value !== 'earth' && value !== 'mars') throw new Error(`--planet must be earth|mars, got "${value}".`)
      options.planet = value
    } else if (arg === '--seed' && argv[i + 1]) {
      options.seed = Number(argv[++i])
      if (!Number.isInteger(options.seed)) throw new Error(`--seed must be an integer, got "${argv[i]}".`)
    } else if (arg === '--steps' && argv[i + 1]) {
      options.steps = Number(argv[++i])
      if (!Number.isInteger(options.steps) || options.steps <= 0) {
        throw new Error(`--steps must be a positive integer, got "${argv[i]}".`)
      }
    } else if (arg === '--benchmark') {
      options.benchmark = true
    } else if (arg === '--check-determinism') {
      options.checkDeterminism = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run sim:headless -- [--planet earth|mars] [--seed N] [--steps N] [--benchmark] [--check-determinism]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument "${arg}". Use --help.`)
    }
  }
  return options
}

const NEUTRAL: DriveAction = { left: 0, right: 0, brake: true, eStop: false }
const FORWARD: DriveAction = { left: 1, right: 1, brake: false, eStop: false }

function formatVector(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`
}

async function runDemo(options: CliOptions): Promise<void> {
  console.log('ARK Headless Simulator')
  console.log(`Planet: ${options.planet}  Seed: ${options.seed}  Steps: ${options.steps}`)
  console.log('Rendering: Disabled')
  console.log('')
  const sim = await SimulationCore.create({ planet: options.planet, seed: options.seed })
  try {
    const robotId = sim.getState().robots[0]?.id
    if (!robotId) throw new Error('No rover spawned.')
    const report = (step: number) => {
      const state = sim.getState()
      const robot = state.robots[0]
      if (!robot) throw new Error('Rover missing mid-run.')
      console.log(`Step ${step}  t=${state.simTimeS.toFixed(2)}s`)
      console.log(`  Position: ${formatVector(robot.position)}`)
      console.log(`  Velocity: ${formatVector(robot.linearVelocity)}`)
      console.log(`  Yaw: ${robot.yawRad.toFixed(3)} rad  Battery: ${(robot.batteryPercent * 100).toFixed(1)}%`)
    }
    // Phase 1: settle under neutral/brake. Phase 2: drive forward.
    sim.applyRobotAction(robotId, NEUTRAL)
    report(0)
    const reportEvery = Math.max(1, Math.floor(options.steps / 5))
    for (let step = 1; step <= options.steps; step += 1) {
      if (step === Math.floor(options.steps / 3)) sim.applyRobotAction(robotId, FORWARD)
      sim.step()
      if (step % reportEvery === 0 || step === options.steps) report(step)
    }
    console.log('')
    console.log('Simulation completed successfully.')
  } finally {
    sim.dispose()
  }
}

async function runBenchmark(options: CliOptions): Promise<void> {
  const steps = options.steps === 600 ? 10000 : options.steps
  const sim = await SimulationCore.create({ planet: options.planet, seed: options.seed })
  try {
    const robotId = sim.getState().robots[0]?.id
    if (!robotId) throw new Error('No rover spawned.')
    sim.applyRobotAction(robotId, FORWARD)
    // Warm up outside the timed region (solver caches, JIT).
    for (let i = 0; i < 120; i += 1) sim.step()
    const start = process.hrtime.bigint()
    for (let i = 0; i < steps; i += 1) sim.step()
    const end = process.hrtime.bigint()
    const wallS = Number(end - start) / 1e9
    const simTimeS = steps / 60
    console.log('ARK Headless Benchmark')
    console.log(`Planet: ${options.planet}  Seed: ${options.seed}`)
    console.log(`Steps: ${steps}`)
    console.log(`Simulated time: ${simTimeS.toFixed(2)} s`)
    console.log(`Wall time: ${wallS.toFixed(2)} s`)
    console.log(`Throughput: ${(steps / wallS).toFixed(1)} steps/s`)
    console.log(`Realtime factor: ${(simTimeS / wallS).toFixed(2)}x`)
  } finally {
    sim.dispose()
  }
}

async function runDeterminismCheck(options: CliOptions): Promise<void> {
  const runOnce = async (): Promise<{ pos: [number, number, number]; vel: [number, number, number] }> => {
    const sim = await SimulationCore.create({ planet: options.planet, seed: options.seed })
    try {
      const robotId = sim.getState().robots[0]?.id
      if (!robotId) throw new Error('No rover spawned.')
      for (let step = 1; step <= options.steps; step += 1) {
        if (step === Math.floor(options.steps / 3)) sim.applyRobotAction(robotId, FORWARD)
        else if (step === 1) sim.applyRobotAction(robotId, NEUTRAL)
        sim.step()
      }
      const robot = sim.getRobotState(robotId)
      if (!robot) throw new Error('Rover missing.')
      return {
        pos: [robot.position.x, robot.position.y, robot.position.z],
        vel: [robot.linearVelocity.x, robot.linearVelocity.y, robot.linearVelocity.z],
      }
    } finally {
      sim.dispose()
    }
  }
  const first = await runOnce()
  const second = await runOnce()
  const diffs = [...first.pos.map((v, i) => Math.abs(v - (second.pos[i] ?? 0))), ...first.vel.map((v, i) => Math.abs(v - (second.vel[i] ?? 0)))]
  const maxDiff = Math.max(...diffs)
  console.log('ARK Determinism Check')
  console.log(`Planet: ${options.planet}  Seed: ${options.seed}  Steps: ${options.steps}`)
  console.log(`Run 1 final pos: ${formatVector({ x: first.pos[0] ?? 0, y: first.pos[1] ?? 0, z: first.pos[2] ?? 0 })}`)
  console.log(`Run 2 final pos: ${formatVector({ x: second.pos[0] ?? 0, y: second.pos[1] ?? 0, z: second.pos[2] ?? 0 })}`)
  console.log(`Max state difference: ${maxDiff.toExponential(3)}`)
  // Same process, same machine, same build: expect bitwise-identical floats.
  // Tolerance stays tight (1e-9) to catch nondeterminism; cross-platform or
  // cross-version bitwise equality is NOT claimed.
  if (maxDiff > 1e-9) {
    console.log('DETERMINISM: FAIL')
    process.exitCode = 1
  } else {
    console.log('DETERMINISM: PASS')
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.checkDeterminism) {
    await runDeterminismCheck(options)
  } else if (options.benchmark) {
    await runBenchmark(options)
  } else {
    await runDemo(options)
  }
}

main().catch((error: unknown) => {
  console.error('Headless simulation failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
