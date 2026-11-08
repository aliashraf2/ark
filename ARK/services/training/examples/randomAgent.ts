#!/usr/bin/env tsx
/**
 * RL smoke test: drives one full episode with a seeded random policy through
 * the public ArkEnvironment API. Verifies the interface works end to end —
 * it does NOT learn anything.
 *
 *   npm run rl:smoke
 */
import { mulberry32 } from '../../../packages/physics/src/terrain/terrainNoise'
import {
  OBSERVATION_SIZE,
  createArkEnvironment,
} from '../../../packages/rl/src/index'

async function main(): Promise<void> {
  console.log('ARK RL smoke: random agent, one episode')
  const env = await createArkEnvironment({ planet: 'earth', terrainSeed: 10 })
  try {
    const { observation, info } = env.reset(123)
    console.log(`scenario: ${info.scenario.scenarioId}`)
    console.log(`observation: Float32Array[${observation.length}] (expected ${OBSERVATION_SIZE})`)
    if (observation.length !== OBSERVATION_SIZE) throw new Error('Bad observation shape.')
    console.log(`start: (${info.scenario.start.x.toFixed(1)}, ${info.scenario.start.z.toFixed(1)})`)
    console.log(`target: (${info.scenario.target.x.toFixed(1)}, ${info.scenario.target.z.toFixed(1)})`)

    const random = mulberry32(999)
    const stepCap = env.config.maxSteps
    let result = null
    let step = 0
    for (; step < stepCap; step += 1) {
      result = env.step({ leftDrive: random() * 2 - 1, rightDrive: random() * 2 - 1 })
      if ((step + 1) % 50 === 0 || result.terminated || result.truncated) {
        console.log(
          `step ${step + 1}: reward=${result.reward.toFixed(3)} total=${result.info.metrics.episodeReward.toFixed(2)} ` +
            `dist=${result.info.distanceM.toFixed(1)}m battery=${(result.info.batteryPercent * 100).toFixed(0)}%`,
        )
      }
      if (result.terminated || result.truncated) break
    }
    if (!result) throw new Error('Episode produced no steps.')
    if (!result.terminated && !result.truncated) {
      throw new Error(`Episode did not end within the ${stepCap}-step cap.`)
    }
    if (!Number.isFinite(result.info.metrics.episodeReward)) throw new Error('Non-finite episode reward.')
    console.log(
      `done: ${result.terminated ? 'terminated' : 'truncated'} ` +
        `(${result.info.metrics.terminationReason ?? result.info.metrics.truncationReason}) ` +
        `length=${result.info.metrics.length} traveled=${result.info.metrics.distanceTraveledM.toFixed(1)}m ` +
        `collisions=${result.info.metrics.collisions}`,
    )

    // Second episode proves reset works after completion.
    env.reset(124)
    env.step({ leftDrive: 0.5, rightDrive: 0.5 })
    console.log('SMOKE: PASS')
  } finally {
    env.close()
  }
}

main().catch((error: unknown) => {
  console.error('RL smoke failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
