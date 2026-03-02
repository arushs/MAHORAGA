export { runSimulation } from './simulator';

export {
  initFilter,
  filterStep,
  getEstimate,
  filterBatch,
  type Particle,
  type ParticleFilterConfig,
  type ParticleFilterState,
  type FilterEstimate,
} from './particle-filter';

export {
  recordPrediction,
  evaluateExpiredPredictions,
  getBrierStats,
  getBrierBySymbol,
  type MCPrediction,
  type BrierStats,
} from './brier';

// Phase 3: Monte Carlo Risk Management
export {
  estimateTailProbability,
  estimateLossDistribution,
  type ISConfig,
  type ISResult,
  type LossDistributionResult,
} from './importance-sampling';

export {
  computeDynamicStop,
  computePortfolioStops,
  checkDynamicStop,
  type DynamicStopConfig,
  type DynamicStop,
  type PortfolioStopResult,
  type PositionForStop,
} from './dynamic-stop-loss';

export {
  runStressTest,
  SCENARIOS,
  type PortfolioPosition,
  type ScenarioConfig,
  type ScenarioResult,
  type StressTestResult,
} from './stress-test';

export {
  evaluateKillSwitch,
  type KillSwitchPosition,
  type KillSwitchConfig,
  type KillAction,
  type KillSwitchResult,
} from './kill-switch';
