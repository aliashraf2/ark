#!/usr/bin/env tsx
/**
 * RL throughput benchmark: measures real ArkEnvironment step/reset rates.
 *
 *   npm run rl:benchmark -- --episodes 4 --max-steps 512 --planet mars
 */
import os from 'node:os'

import { mulberry32 } from '../../../packages/physics/src/terrain/terrainNoise'
import { createArkEnvironment, type ArkEnvironmentConfig } from '../../../packages/rl/src/index'

interface BenchOptions {
  episodes: number
  maxSteps: number
  planet: 'earth' | 'mars'
  terrainSeed: number
  actionRepeat: number
  subdivisions: number
}

function parseArgs(argv: string[]): BenchOptions {
  const options: BenchOptions = {
    episodes: 4,
    maxSteps: 512,
    planet: 'mars',
    terrainSeed: 42,
    actionRepeat: 4,
    subdivisions: 160,
  }
  const flag = (name: string, value: string | undefined, parse: (raw: string) => number): number => {
    if (value === undefined) throw new Error(`Missing value for ${name}.`)
    const parsed = parse(value)
    if (!Number.isFinite(parsed)) throw new Error(`Invalid value for ${name}: "${value}".`)
    return parsed
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--episodes') options.episodes = flag(arg, argv[++i], Number)
    else if (arg === '--max-steps') options.maxSteps = flag(arg, argv[++i], Number)
    else if (arg === '--action-repeat') options.actionRepeat = flag(arg, argv[++i], Number)
    else if (arg === '--subdivisions') options.subdivisions = flag(arg, argv[++i], Number)
    else if (arg === '--terrain-seed') options.terrainSeed = flag(arg, argv[++i], Number)
    else if (arg === '--planet') {
      const value = argv[++i]
      if (value !== 'earth' && value !== 'mars') throw new Error(`--planet must be earth|mars, got "${value}".`)
      options.planet = value
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run rl:benchmark -- [--episodes N] [--max-steps N] [--planet earth|mars] [--terrain-seed N] [--action-repeat N] [--subdivisions N]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument "${arg}". Use --help.`)
    }
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const config: ArkEnvironmentConfig = {
    planet: options.planet,
    terrainSeed: options.terrainSeed,
    actionRepeat: options.actionRepeat,
    maxSteps: options.maxSteps,
    terrainSubdivisions: options.subdivisions,
  }
  console.log('ARK RL Benchmark')
  console.log(
    `planet=${options.planet} episodes=${options.episodes} maxSteps=${options.maxSteps} ` +
      `actionRepeat=${options.actionRepeat} subdivisions=${options.subdivisions}`,
  )

  const buildStart = process.hrtime.bigint()
  const env = await createArkEnvironment(config)
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6
  try {
    const random = mulberry32(2026)
    let rlSteps = 0
    let physicsSteps = 0
    let successes = 0
    let resetMs = 0
    const loopStart = process.hrtime.bigint()
    for (let episode = 0; episode < options.episodes; episode += 1) {
      const resetStart = process.hrtime.bigint()
      env.reset(1000 + episode)
      resetMs += Number(process.hrtime.bigint() - resetStart) / 1e6
      for (;;) {
        const result = env.step({ leftDrive: random() * 2 - 1, rightDrive: random() * 2 - 1 })
        rlSteps += 1
        if (result.terminated || result.truncated) {
          physicsSteps += result.info.physicsSteps
          if (result.info.metrics.success) successes += 1
          break
        }
      }
    }
    const loopMs = Number(process.hrtime.bigint() - loopStart) / 1e6
    const stepMs = loopMs - resetMs
    const simSeconds = physicsSteps / 60
    console.log(`episodes completed: ${options.episodes} (successes: ${successes})`)
    console.log(`env build: ${buildMs.toFixed(0)} ms (one-time: terrain gen + WASM init)`)
    console.log(`avg reset: ${(resetMs / options.episodes).toFixed(1)} ms`)
    console.log(`RL steps: ${rlSteps} in ${(stepMs / 1000).toFixed(2)} s -> ${(rlSteps / (stepMs / 1000)).toFixed(1)} RL steps/s`)
    console.log(`physics steps: ${physicsSteps} -> ${(physicsSteps / (stepMs / 1000)).toFixed(0)} physics steps/s`)
    console.log(`sim time: ${simSeconds.toFixed(1)} s -> ${(simSeconds / (stepMs / 1000)).toFixed(1)}x realtime`)
    const cpus = os.cpus()
    console.log(`hardware: ${os.platform()}/${os.arch()} ${cpus.length}x ${cpus[0]?.model ?? 'unknown'} node ${process.version}`)
  } finally {
    env.close()
  }
}

main().catch((error: unknown) => {
  console.error('RL benchmark failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
