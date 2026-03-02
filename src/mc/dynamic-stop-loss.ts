/**
 * Dynamic Stop-Loss — MC-derived stop levels using importance sampling.
 *
 * Replaces static stop_loss_pct with position-specific stops computed
 * at the 99th percentile of simulated losses. Each position gets a
 * stop calibrated to its volatility and holding period.
 */

import { estimateLossDistribution, type LossDistributionResult } from "./importance-sampling";

// ── Types ───────────────────────────────────────────────────────────────

export interface DynamicStopConfig {
  /** Confidence level for VaR-based stop (default: 0.99 = 99th percentile) */
  confidenceLevel?: number;
  /** Holding period horizon in ms (default: 7 days) */
  horizonMs?: number;
  /** MC simulation paths (default: 30_000 for speed) */
  numPaths?: number;
  /** Minimum stop-loss % (floor, default: 2%) */
  minStopPct?: number;
  /** Maximum stop-loss % (ceiling, default: 25%) */
  maxStopPct?: number;
  /** Drift rate (default: 0, conservative) */
  drift?: number;
}

export interface DynamicStop {
  /** Symbol this stop applies to */
  symbol: string;
  /** Computed stop-loss percentage (positive number, e.g. 7.5 = -7.5% from entry) */
  stopLossPct: number;
  /** VaR at confidence level (negative % return) */
  var99: number;
  /** CVaR / expected shortfall (negative % return) */
  cvar99: number;
  /** Annualized vol used for computation */
  volUsed: number;
  /** Was the stop clamped to min/max bounds? */
  clamped: boolean;
  /** Variance reduction achieved */
  varianceReductionFactor: number;
  /** Compute time in ms */
  computeTimeMs: number;
}

export interface PortfolioStopResult {
  /** Per-position dynamic stops */
  stops: DynamicStop[];
  /** Total compute time */
  totalComputeTimeMs: number;
}

// ── Position info needed for stop calculation ───────────────────────────

export interface PositionForStop {
  symbol: string;
  currentPrice: number;
  /** Annualized realized or implied volatility */
  annualizedVol: number;
  /** How long the position has been held (ms) — used to adjust horizon */
  heldSinceMs?: number;
}

// ── Stop calculation ────────────────────────────────────────────────────

const DEFAULT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DEFAULT_CONFIDENCE = 0.99;
const DEFAULT_MIN_STOP = 2;   // 2%
const DEFAULT_MAX_STOP = 25;  // 25%

/**
 * Compute a dynamic stop-loss for a single position.
 * Uses importance sampling to efficiently estimate the 99th percentile
 * of the loss distribution.
 */
export function computeDynamicStop(
  position: PositionForStop,
  config?: DynamicStopConfig,
): DynamicStop {
  const confidence = config?.confidenceLevel ?? DEFAULT_CONFIDENCE;
  const horizonMs = config?.horizonMs ?? DEFAULT_HORIZON_MS;
  const numPaths = config?.numPaths ?? 30_000;
  const minStop = config?.minStopPct ?? DEFAULT_MIN_STOP;
  const maxStop = config?.maxStopPct ?? DEFAULT_MAX_STOP;

  const dist: LossDistributionResult = estimateLossDistribution({
    currentPrice: position.currentPrice,
    annualizedVol: position.annualizedVol,
    horizonMs,
    confidenceLevel: confidence,
    numPaths,
    drift: config?.drift ?? 0,
  });

  // VaR is negative (loss) — convert to positive stop percentage
  let rawStopPct = Math.abs(dist.varAtConfidence);
  const clamped = rawStopPct < minStop || rawStopPct > maxStop;
  const stopLossPct = Math.max(minStop, Math.min(maxStop, rawStopPct));

  return {
    symbol: position.symbol,
    stopLossPct,
    var99: dist.varAtConfidence,
    cvar99: dist.cvarAtConfidence,
    volUsed: position.annualizedVol,
    clamped,
    varianceReductionFactor: dist.varianceReductionFactor,
    computeTimeMs: dist.computeTimeMs,
  };
}

/**
 * Compute dynamic stops for all positions in a portfolio.
 */
export function computePortfolioStops(
  positions: PositionForStop[],
  config?: DynamicStopConfig,
): PortfolioStopResult {
  const t0 = performance.now();
  const stops = positions.map(pos => computeDynamicStop(pos, config));
  return {
    stops,
    totalComputeTimeMs: performance.now() - t0,
  };
}

/**
 * Check if a position should be stopped out based on dynamic stop levels.
 * Returns the stop reason if triggered, null otherwise.
 */
export function checkDynamicStop(
  _symbol: string,
  currentPLPct: number,
  dynamicStop: DynamicStop,
): string | null {
  if (currentPLPct <= -dynamicStop.stopLossPct) {
    return `MC dynamic stop at ${currentPLPct.toFixed(1)}% (VaR99=${dynamicStop.var99.toFixed(1)}%, vol=${(dynamicStop.volUsed * 100).toFixed(0)}%)`;
  }
  return null;
}
