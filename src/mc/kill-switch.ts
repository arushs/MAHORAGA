/**
 * MC-Enhanced Kill Switch — probabilistic portfolio risk management.
 *
 * Uses Monte Carlo simulation to estimate forward-looking loss probabilities.
 * Actions:
 *   - Auto-reduce 50% at >15% portfolio loss probability (99% confidence)
 *   - Full kill at >25% portfolio loss probability (99% confidence)
 *
 * Unlike the static kill switch that reacts to realized losses,
 * this estimates the PROBABILITY of future losses and acts preemptively.
 */

import { estimateTailProbability } from "./importance-sampling";

// ── Types ───────────────────────────────────────────────────────────────

export interface KillSwitchPosition {
  symbol: string;
  currentPrice: number;
  marketValue: number;
  annualizedVol: number;
  weight: number; // portfolio weight (0-1)
}

export interface KillSwitchConfig {
  /** Probability confidence level (default: 0.99) */
  confidenceLevel?: number;
  /** Portfolio loss % threshold for 50% reduction (default: 15) */
  reduceThresholdPct?: number;
  /** Portfolio loss % threshold for full kill (default: 25) */
  killThresholdPct?: number;
  /** Forward-looking horizon in ms (default: 1 day) */
  horizonMs?: number;
  /** MC paths per simulation (default: 50_000) */
  numPaths?: number;
  /** Minimum probability to trigger action (default: 0.01 = 1%) */
  minProbabilityTrigger?: number;
}

export type KillAction = "none" | "reduce_50" | "full_kill";

export interface KillSwitchResult {
  /** Recommended action */
  action: KillAction;
  /** Reason for the action */
  reason: string;
  /** Estimated probability of >15% portfolio loss */
  probLoss15Pct: number;
  /** CI for 15% loss probability */
  ciLoss15Pct: [number, number];
  /** Estimated probability of >25% portfolio loss */
  probLoss25Pct: number;
  /** CI for 25% loss probability */
  ciLoss25Pct: [number, number];
  /** Portfolio-level annualized vol used */
  portfolioVol: number;
  /** Forward horizon used (ms) */
  horizonMs: number;
  /** Total compute time */
  computeTimeMs: number;
  /** Variance reduction achieved */
  varianceReductionFactor: number;
}

// ── Kill switch engine ──────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Estimate portfolio-level volatility from positions.
 * Simple model: assume moderate correlation (ρ=0.4) between all positions.
 * σ_portfolio² = Σ w_i² σ_i² + 2 Σ_{i<j} w_i w_j ρ σ_i σ_j
 */
function estimatePortfolioVol(positions: KillSwitchPosition[], rho = 0.4): number {
  if (positions.length === 0) return 0;
  if (positions.length === 1) return positions[0]!.annualizedVol;

  let variance = 0;
  for (let i = 0; i < positions.length; i++) {
    const pi = positions[i]!;
    variance += pi.weight * pi.weight * pi.annualizedVol * pi.annualizedVol;
    for (let j = i + 1; j < positions.length; j++) {
      const pj = positions[j]!;
      variance += 2 * pi.weight * pj.weight * rho * pi.annualizedVol * pj.annualizedVol;
    }
  }

  return Math.sqrt(Math.max(0, variance));
}

/**
 * Evaluate the MC-enhanced kill switch.
 *
 * Computes forward-looking probabilities of portfolio losses exceeding
 * 15% and 25% thresholds using importance sampling. Returns the
 * recommended action based on 99% confidence bounds.
 */
export function evaluateKillSwitch(
  positions: KillSwitchPosition[],
  config?: KillSwitchConfig,
): KillSwitchResult {
  const t0 = performance.now();

  const reduceThreshold = config?.reduceThresholdPct ?? 15;
  const killThreshold = config?.killThresholdPct ?? 25;
  const horizonMs = config?.horizonMs ?? ONE_DAY_MS;
  const numPaths = config?.numPaths ?? 50_000;
  const minProbTrigger = config?.minProbabilityTrigger ?? 0.01;

  if (positions.length === 0) {
    return {
      action: "none",
      reason: "No positions",
      probLoss15Pct: 0,
      ciLoss15Pct: [0, 0],
      probLoss25Pct: 0,
      ciLoss25Pct: [0, 0],
      portfolioVol: 0,
      horizonMs,
      computeTimeMs: performance.now() - t0,
      varianceReductionFactor: 1,
    };
  }

  // Normalize weights
  const totalWeight = positions.reduce((s, p) => s + p.weight, 0);
  const normalizedPositions = totalWeight > 0
    ? positions.map(p => ({ ...p, weight: p.weight / totalWeight }))
    : positions;

  const portfolioVol = estimatePortfolioVol(normalizedPositions);

  // Simulate portfolio as single entity with estimated vol
  // P(portfolio drops > X%) = P(S_T/S_0 <= 1 - X/100)
  const refPrice = 100; // normalized

  // Estimate P(loss > 15%)
  const result15 = estimateTailProbability({
    currentPrice: refPrice,
    annualizedVol: portfolioVol,
    horizonMs,
    threshold: refPrice * (1 - reduceThreshold / 100),
    direction: "loss",
    numPaths,
  });

  // Estimate P(loss > 25%)
  const result25 = estimateTailProbability({
    currentPrice: refPrice,
    annualizedVol: portfolioVol,
    horizonMs,
    threshold: refPrice * (1 - killThreshold / 100),
    direction: "loss",
    numPaths,
  });

  // Decision logic using confidence interval upper bounds (conservative)
  // Use the upper CI bound to be conservative — if we're 99% sure the probability
  // is at least this high, we should act.
  let action: KillAction = "none";
  let reason = "Portfolio risk within acceptable bounds";

  // Full kill: upper CI bound of P(loss > 25%) exceeds trigger
  if (result25.confidenceInterval[1] >= minProbTrigger) {
    action = "full_kill";
    reason = `P(loss>${killThreshold}%) = ${(result25.probability * 100).toFixed(2)}% ` +
      `[CI: ${(result25.confidenceInterval[0] * 100).toFixed(2)}-${(result25.confidenceInterval[1] * 100).toFixed(2)}%], ` +
      `portfolio vol=${(portfolioVol * 100).toFixed(1)}%`;
  }
  // 50% reduction: upper CI bound of P(loss > 15%) exceeds trigger
  else if (result15.confidenceInterval[1] >= minProbTrigger) {
    action = "reduce_50";
    reason = `P(loss>${reduceThreshold}%) = ${(result15.probability * 100).toFixed(2)}% ` +
      `[CI: ${(result15.confidenceInterval[0] * 100).toFixed(2)}-${(result15.confidenceInterval[1] * 100).toFixed(2)}%], ` +
      `portfolio vol=${(portfolioVol * 100).toFixed(1)}%`;
  }

  const avgVR = (result15.varianceReductionFactor + result25.varianceReductionFactor) / 2;

  return {
    action,
    reason,
    probLoss15Pct: result15.probability,
    ciLoss15Pct: result15.confidenceInterval,
    probLoss25Pct: result25.probability,
    ciLoss25Pct: result25.confidenceInterval,
    portfolioVol,
    horizonMs,
    computeTimeMs: performance.now() - t0,
    varianceReductionFactor: avgVR,
  };
}
