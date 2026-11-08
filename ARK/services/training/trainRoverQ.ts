import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PhysicsWorld } from '../../packages/physics/src/physics/PhysicsWorld'
import { RoverEnv } from '../../packages/physics/src/robotics/RoverEnv'
import { NavigationController } from '../../packages/physics/src/robotics/controllers'
import { generateHeightfield } from '../../packages/physics/src/terrain/generateHeightfield'
import { mulberry32 } from '../../packages/physics/src/terrain/terrainNoise'
import { getPlanet, resolveTerrainParams } from '../../packages/physics/src/worlds/planetPresets'
import { generateScenario } from '../../packages/rl/src/scenarios/generateScenario'
import { getTerrainHeight } from '../../packages/physics/src/terrain/terrainSampling'
import { RoverQController, greedyAction, qState, updateQ, validateQPolicy, type RoverQPolicy } from '../../packages/rl/src/policies/RoverQPolicy'
import { createPpoController } from '../../apps/simulator/src/lib/robotics/PpoPolicy'
import ppo from '../../apps/simulator/src/lib/robotics/ppo_rover_mars.json'

const flags = process.argv.slice(2)
const allowed = ['seconds', 'episodes', 'eval-episodes', 'resolution', 'max-steps', 'eval-seed']
for (let i = 0; i < flags.length; i += 2) {
  if (!allowed.includes(flags[i]!.replace(/^--/, '')) || flags[i + 1] === undefined) throw new Error('Unknown or missing training option')
}
function option(name: string, fallback: number): number {
  const index = flags.indexOf(`--${name}`)
  const value = index < 0 ? fallback : Number(flags[index + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name}`)
  return value
}
const seconds = option('seconds', 60), episodes = option('episodes', 120), evalEpisodes = option('eval-episodes', 24)
const subdivisions = option('resolution', 160), maxSteps = option('max-steps', 900)
const evalSeed = option('eval-seed', 2000000)
if (![episodes, evalEpisodes, subdivisions, maxSteps, evalSeed].every(Number.isInteger) || subdivisions < 8 || evalSeed < 1000000 || episodes >= 999000) throw new Error('Use integer episode/step counts and separate evaluation seeds >= 1000000')
const planet = getPlanet('mars'), terrainSeed = 42, random = mulberry32(12345)
await PhysicsWorld.init()
const terrain = generateHeightfield({ ...resolveTerrainParams(planet, 'cratered-plains'), subdivisions }, terrainSeed)
const env = new RoverEnv({ gravityMps2: planet.gravity, terrainFriction: planet.terrainFriction, heightfield: terrain,
  actionRepeat: 8, bounds: { halfExtent: 45 }, timeLimitS: 120, toleranceM: 2 })
const policy: RoverQPolicy = { format: 'ark-rover-q-v1', planet: 'mars', terrainSeed, terrainSubdivisions: subdivisions,
  trainedSteps: 0, trainingSeconds: 0, q: {} }
const controller = new RoverQController(policy)
function scenario(seed: number) {
  return generateScenario({ random: mulberry32(seed), sampleHeight: (x, z) => getTerrainHeight(terrain, x, z),
    boundsHalfExtentM: 30, goalMinDistanceM: 5, goalMaxDistanceM: 12, maxStartSlope: 0.27, maxGoalSlope: 0.35 })
}
const started = performance.now()
let trainedEpisodes = 0
try {
  for (let episode = 0; episode < episodes && (performance.now() - started) / 1000 < seconds; episode++) {
    const sample = scenario(1000 + episode)
    let obs = env.reset(1000 + episode, { start: sample.start, target: sample.target }).observation
    env.setController(controller)
    const epsilon = 0.4 * (1 - episode / episodes) + 0.05
    for (let step = 0; step < maxSteps; step++) {
      const state = qState(obs)
      const action = random() < epsilon ? Math.floor(random() * 5) : greedyAction(policy.q[state])
      controller.forceAction(action)
      const result = env.step({ left: 0, right: 0, brake: false, eStop: false })
      const terminal = result.terminated || result.truncated || step === maxSteps - 1
      // Emphasize navigation progress during learning; evaluation uses unmodified environment reward.
      const reward = result.reward + result.terms.progress * 9 + (result.info.upY < 0.3 ? -100 : 0)
      updateQ(policy, state, action, reward, qState(result.observation), terminal)
      policy.trainedSteps++
      obs = result.observation
      if (terminal || (performance.now() - started) / 1000 >= seconds) break
    }
    trainedEpisodes++
    if (episode % 20 === 0) console.log(`Training episode ${episode + 1}; ${policy.trainedSteps} transitions`)
  }
  policy.trainingSeconds = (performance.now() - started) / 1000
  const trainingSnapshot = JSON.stringify(policy.q)
  const report: Record<string, unknown> = { algorithm: 'tabular Q-learning over navigation options', trainedEpisodes,
    trainedSteps: policy.trainedSteps, trainingSeconds: policy.trainingSeconds, terrainSeed, subdivisions, maxSteps,
    trainingSeeds: [1000, 1000 + trainedEpisodes - 1], evaluationSeedBase: evalSeed, goalDistanceM: [5, 12],
    learningReward: 'environment reward + 9 * progress term - 100 on rollover; evaluation uses environment reward', cases: {} }
  for (const [name, control] of [['q', new RoverQController(policy)], ['waypoint', new NavigationController()], ['ppoAssisted', createPpoController(ppo as Parameters<typeof createPpoController>[0])]] as const) {
    const cases = []
    for (let episode = 0; episode < evalEpisodes; episode++) {
      const sample = scenario(evalSeed + episode)
      env.reset(evalSeed + episode, { start: sample.start, target: sample.target })
      env.setController(control)
      let reward = 0, success = false, steps = 0, reason = 'step-limit', distance = 0
      for (; steps < maxSteps; steps++) {
        const result = env.step({ left: 0, right: 0, brake: false, eStop: false })
        reward += result.reward; distance = result.info.distanceM
        if (result.terminated || result.truncated) {
          success = result.info.missionStatus === 'succeeded'
          reason = success ? 'goal' : result.info.upY < 0.3 ? 'rollover' : result.info.missionFailReason ?? 'terminated'
          steps++; break
        }
      }
      cases.push({ seed: evalSeed + episode, success, reward, steps, distance, reason })
    }
    const summary = { episodes: cases.length, successes: cases.filter((c) => c.success).length,
      successRate: cases.filter((c) => c.success).length / cases.length,
      meanReturn: cases.reduce((sum, c) => sum + c.reward, 0) / cases.length, cases }
    ;(report.cases as Record<string, unknown>)[name] = summary
    console.log(`${name}: ${summary.successes}/${summary.episodes}; mean return ${summary.meanReturn.toFixed(2)}`)
  }
  if (JSON.stringify(policy.q) !== trainingSnapshot) throw new Error('Evaluation mutated training data')
  const summaries = report.cases as Record<string, { successRate: number; meanReturn: number }>
  policy.evaluation = { episodes: evalEpisodes, successRate: summaries.q!.successRate,
    baselineSuccessRate: summaries.waypoint!.successRate, meanReturn: summaries.q!.meanReturn }
  validateQPolicy(policy)
  for (const [file, data] of [['packages/rl/policies/rover-q-mars.json', policy], ['services/training/results/rover-q-mars-evaluation.json', report]] as const) {
    const path = resolve(file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
  }
  console.log(`Training completed in ${policy.trainingSeconds.toFixed(2)}s; saved checkpoint and held-out evaluation.`)
} finally { env.dispose() }
