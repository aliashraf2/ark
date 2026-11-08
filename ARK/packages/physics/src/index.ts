/**
 * ARK shared simulation core (headless-safe): physics, terrain, worlds,
 * environment state, and robotics. No Three.js, no Svelte, no DOM.
 */
export { SimulationCore } from './core/SimulationCore'
export type {
  RobotStateSnapshot,
  SimulationOptions,
  SimulationStateSnapshot,
} from './core/SimulationCore'
export { SimulationClock } from './core/SimulationClock'
export { FIXED_TIME_STEP } from './types/SimulationTypes'
export type { PlanetId } from './worlds/PlanetConfig'
export type { DriveAction } from './robotics/RoverConfig'
