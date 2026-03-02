/**
 * Portfolio Stress Testing — IS-enhanced scenario analysis.
 *
 * Runs Monte Carlo simulations under stressed market conditions
 * to estimate portfolio losses in extreme scenarios. Uses importance
 * sampling for efficient tail estimation in each scenario.
 *
 * Scenarios: flash crash, sector rotation, vol spike, liquidity crisis.
 * Designed to run on market-open cron.
 */

import { estimateTailProbability, estimateLossDistribution } from "./importance-sampling";

// ── Types ───────────────────────────────────────────────────────────────

export interface PortfolioPosition {
  symbol: string;
  currentPrice: number;
  marketValue: number;
  annualizedVol: number;
  /** Sector for correlation modeling */
  sector?: string;
  /** Weight in portfolio (0-1) */
  weight: number;
}

export interface ScenarioConfig {
  name: string;
  description: string;
  /** Vol multiplier applied to all positions */
  volMultiplier: number;
  /** Drift shock (negative = bearish, e.g. -0.5 = -50% annualized drift) */
  driftShock: number;
  /** Correlation shock — increase all correlations toward 1 */
  correlationBoost: number;
  /** Time horizon for the scenario (ms) */
  horizonMs: number;
  /** Loss threshold to measure probability of (negative %) */
  lossThresholdPct: number;
}

export interface ScenarioResult {
  scenario: ScenarioConfig;
  /** Probability of portfolio losing more than lossThresholdPct */
  probExceedingThreshold: number;
  /** 95% CI on that probability */
  confidenceInterval: [number, number];
  /** Expected portfolio loss under scenario (negative %) */
  expectedLossPct: number;
  /** Worst-case (99th percentile) portfolio loss (negative %) */
  worstCaseLossPct: number;
  /** Per-position losses at 99th percentile */
  positionLosses: Array<{ symbol: string; lossPct: number }>;
  /** Total compute time */
  computeTimeMs: number;
  /** Average VR factor across positions */
  avgVarianceReduction: number;
}

export interface StressTestResult {
  /** Results for each scenario */
  scenarios: ScenarioResult[];
  /** Overall worst scenario */
  worstScenario: string;
  /** Maximum portfolio loss across all scenarios */
  maxPortfolioLossPct: number;
  /** Total compute time */
  totalComputeTimeMs: number;
  /** Timestamp */
  timestamp: string;
}

// ── Predefined scenarios ────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const SCENARIOS: ScenarioConfig[] = [
  {
    name: "flash_crash",
    description: "Sudden market-wide crash — 3x vol, heavy negative drift, max correlation",
    volMultiplier: 3.0,
    driftShock: -2.0,     // Extreme negative drift
    correlationBoost: 0.9, // Everything sells together
    horizonMs: ONE_DAY_MS, // 1-day event
    lossThresholdPct: -10,
  },
  {
    name: "sector_rotation",
    description: "Sharp rotation — 1.5x vol, moderate drift shock, low correlation boost",
    volMultiplier: 1.5,
    driftShock: -0.5,
    correlationBoost: 0.3,
    horizonMs: 5 * ONE_DAY_MS, // 1-week rotation
    lossThresholdPct: -5,
  },
  {
    name: "vol_spike",
    description: "VIX explosion — 4x vol, slight negative drift, moderate correlation",
    volMultiplier: 4.0,
    driftShock: -0.3,
    correlationBoost: 0.6,
    horizonMs: 3 * ONE_DAY_MS,
    lossThresholdPct: -15,
  },
  {
    name: "liquidity_crisis",
    description: "Liquidity dry-up — 2.5x vol, strong negative drift, high correlation",
    volMultiplier: 2.5,
    driftShock: -1.0,
    correlationBoost: 0.8,
    horizonMs: 5 * ONE_DAY_MS,
    lossThresholdPct: -20,
  },
];

// ── Stress test engine ──────────────────────────────────────────────────

/**
 * Run a single scenario against the portfolio.
 */
function runScenario(
  positions: PortfolioPosition[],
  scenario: ScenarioConfig,
  numPaths: number,
): ScenarioResult {
  const t0 = performance.now();

  const positionLosses: Array<{ symbol: string; lossPct: number }> = [];
  let portfolioLossWeighted = 0;
  let portfolioWorstCase = 0;
  let totalVR = 0;

  // Simulate each position under stressed conditions
  for (const pos of positions) {
    const stressedVol = pos.annualizedVol * scenario.volMultiplier;

    const dist = estimateLossDistribution({
      currentPrice: pos.currentPrice,
      annualizedVol: stressedVol,
      horizonMs: scenario.horizonMs,
      confidenceLevel: 0.99,
      numPaths,
      drift: scenario.driftShock,
    });

    // Use 50th percentile as expected loss, 1st percentile as worst case
    const expectedLoss = dist.percentileLosses[49]!;  // median
    const worstLoss = dist.varAtConfidence;             // 99th percentile loss

    positionLosses.push({ symbol: pos.symbol, lossPct: worstLoss });
    portfolioLossWeighted += expectedLoss * pos.weight;
    portfolioWorstCase += worstLoss * pos.weight;
    totalVR += dist.varianceReductionFactor;
  }

  // Apply correlation boost: under high correlation, diversification fails
  // Simple model: portfolio loss = weighted_sum * (1 + correlationBoost * (1 - diversification))
  const diversificationRatio = 1 / Math.sqrt(positions.length);
  const correlationPenalty = 1 + scenario.correlationBoost * (1 - diversificationRatio);
  const adjustedWorstCase = portfolioWorstCase * correlationPenalty;
  const adjustedExpected = portfolioLossWeighted * correlationPenalty;

  // Estimate probability of exceeding threshold using IS on portfolio level
  // Approximate: use portfolio vol * stress multiplier
  const avgVol = positions.reduce((s, p) => s + p.annualizedVol * p.weight, 0);
  const portfolioStressedVol = avgVol * scenario.volMultiplier * Math.sqrt(correlationPenalty);
  const avgPrice = 100; // normalize

  const thresholdPrice = avgPrice * (1 + scenario.lossThresholdPct / 100);
  const tailProb = estimateTailProbability({
    currentPrice: avgPrice,
    annualizedVol: portfolioStressedVol,
    horizonMs: scenario.horizonMs,
    threshold: thresholdPrice,
    direction: "loss",
    numPaths,
    drift: scenario.driftShock,
  });

  return {
    scenario,
    probExceedingThreshold: tailProb.probability,
    confidenceInterval: tailProb.confidenceInterval,
    expectedLossPct: adjustedExpected,
    worstCaseLossPct: adjustedWorstCase,
    positionLosses,
    computeTimeMs: performance.now() - t0,
    avgVarianceReduction: totalVR / Math.max(positions.length, 1),
  };
}

/**
 * Run full stress test across all predefined scenarios.
 */
export function runStressTest(
  positions: PortfolioPosition[],
  options?: {
    scenarios?: ScenarioConfig[];
    numPaths?: number;
  },
): StressTestResult {
  const t0 = performance.now();
  const scenarios = options?.scenarios ?? SCENARIOS;
  const numPaths = options?.numPaths ?? 20_000;

  if (positions.length === 0) {
    return {
      scenarios: [],
      worstScenario: "none",
      maxPortfolioLossPct: 0,
      totalComputeTimeMs: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // Normalize weights
  const totalWeight = positions.reduce((s, p) => s + p.weight, 0);
  const normalizedPositions = totalWeight > 0
    ? positions.map(p => ({ ...p, weight: p.weight / totalWeight }))
    : positions;

  const results = scenarios.map(s => runScenario(normalizedPositions, s, numPaths));

  // Find worst scenario
  let worstIdx = 0;
  let worstLoss = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i]!.worstCaseLossPct < worstLoss) {
      worstLoss = results[i]!.worstCaseLossPct;
      worstIdx = i;
    }
  }

  return {
    scenarios: results,
    worstScenario: results[worstIdx]!.scenario.name,
    maxPortfolioLossPct: worstLoss,
    totalComputeTimeMs: performance.now() - t0,
    timestamp: new Date().toISOString(),
  };
}
