/**
 * @ark/rl — Gymnasium-style RL environment API over ARK's shared Rapier core.
 *
 * Headless-safe: no Three.js, no Svelte, no DOM. Physics, terrain, worlds,
 * and rover dynamics are imported from @ark/physics (single implementation).
 */
export { ACTION_SIZE, actionBounds, toDriveAction, validateRoverAction, type RoverRLAction, type ValidatedRoverAction } from './actions/validateRoverAction'
export {
  ArkEnvironment,
  createArkEnvironment,
  type ArkEnvironmentConfig,
  type EpisodeMetrics,
  type ResetInfo,
  type ResetOptions,
  type ResolvedArkEnvironmentConfig,
  type RewardTerms,
  type ScenarioMetadata,
  type ScenarioSplit,
  type StepInfo,
  type StepResult,
  type TerminationReason,
  type TruncationReason,
} from './environment/ArkEnvironment'
export { DEFAULT_RL_CONFIG, resolveEnvironmentConfig } from './environment/EnvironmentConfig'
export { EpisodeTracker, createEpisodeMetrics } from './environment/EpisodeState'
export { OBSERVATION_SIZE, OBSERVATION_SPEC, observationBounds, toFloat32Array } from './observations/observationSpec'
export {
  EVAL_SEED_BASE,
  evalEpisodeSeed,
  generateScenario,
  makeScenarioId,
  type NavigationScenario,
  type ScenarioRequest,
} from './scenarios/generateScenario'
