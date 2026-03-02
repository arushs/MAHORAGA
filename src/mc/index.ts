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
  type PortfolioPosition as StressTestPosition,
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

// Phase 4: Portfolio-Level Risk Management
export {
  computeCorrelationMatrix,
  updateCorrelationState,
  createEmptyCorrelationState,
  getPairwiseCorrelation,
  extractSubMatrix,
  weightedCorrelation,
  barsToLogReturns,
  type CorrelationMatrix,
  type ReturnSeries,
  type CorrelationEstimatorState,
} from './correlation';

export {
  simulateCopula,
  simulateCopulaFlat,
  cholesky,
  type CopulaConfig,
  type CopulaResult,
} from './copula';

export {
  computePortfolioVaR,
  evaluatePortfolioRisk,
  type PortfolioPosition,
  type VaRResult,
  type PortfolioRiskDecision,
  type PortfolioRiskConfig,
} from './portfolio-var';

export {
  computeKelly,
  kellyFromFilterEstimate,
  batchKelly,
  type KellyInput,
  type KellyConfig,
  type KellyResult,
} from './kelly';
