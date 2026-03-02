/**
 * Kelly Criterion Position Sizing
 *
 * Replaces the fixed `position_size_pct_of_cash` with dynamic sizing
 * based on the Kelly formula:
 *
 *   f* = (p * b - q) / b
 *
 * where:
 *   p = probability of profit (from particle filter)
 *   q = 1 - p = probability of loss
 *   b = win/loss ratio (expected gain / expected loss)
 *
 * Safety: uses HALF-Kelly (f* / 2) to reduce variance and drawdown risk.
 * Additional guardrails: floor, ceiling, and portfolio-level caps.
 *
 * Integration: called from strategy entry rules to determine notional size.
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface KellyInput {
  /** Estimated probability of profit [0, 1] — from particle filter */
  probProfit: number;
  /** Expected gain per dollar risked if profitable (e.g., 1.5 = 150% gain) */
  expectedGainRatio: number;
  /** Expected loss per dollar risked if unprofitable (e.g., 0.8 = 80% loss). Always positive. */
  expectedLossRatio: number;
  /** Available cash for allocation */
  availableCash: number;
  /** Total account equity */
  equity: number;
  /** Current number of open positions */
  openPositions: number;
  /** Maximum allowed positions */
  maxPositions: number;
}

export interface KellyConfig {
  /** Kelly fraction multiplier (0.5 = half-Kelly). Default: 0.5 */
  kellyFraction?: number;
  /** Minimum position size as % of cash. Default: 0.02 (2%) */
  minPositionPct?: number;
  /** Maximum position size as % of cash. Default: 0.25 (25%) */
  maxPositionPct?: number;
  /** Minimum probability to trade at all. Default: 0.55 */
  minProbThreshold?: number;
  /** Minimum edge (f* before fraction) to trade. Default: 0.02 */
  minEdgeThreshold?: number;
  /** Maximum total allocation across all positions as % of equity. Default: 0.80 */
  maxTotalAllocationPct?: number;
  /** Minimum dollar amount for a trade. Default: 100 */
  minNotional?: number;
}

export interface KellyResult {
  /** Recommended position size as fraction of cash [0, maxPositionPct] */
  fractionOfCash: number;
  /** Recommended notional dollar amount */
  notional: number;
  /** Raw Kelly fraction before safety adjustments */
  rawKellyF: number;
  /** Half-Kelly fraction */
  halfKellyF: number;
  /** Final fraction after all caps/floors */
  finalFraction: number;
  /** Whether the trade meets minimum edge requirements */
  shouldTrade: boolean;
  /** Reason if shouldTrade is false */
  reason?: string;
  /** Kelly edge = p*b - q (positive = positive expected value) */
  edge: number;
}

// ── Core Kelly computation ──────────────────────────────────────────────

/**
 * Compute the Kelly criterion position size.
 *
 * f* = (p * b - q) / b
 *
 * where b = expectedGainRatio / expectedLossRatio (odds offered)
 */
export function computeKelly(
  input: KellyInput,
  config?: KellyConfig
): KellyResult {
  const {
    kellyFraction = 0.5,
    minPositionPct = 0.02,
    maxPositionPct = 0.25,
    minProbThreshold = 0.55,
    minEdgeThreshold = 0.02,
    maxTotalAllocationPct = 0.80,
    minNotional = 100,
  } = config ?? {};

  const { probProfit, expectedGainRatio, expectedLossRatio, availableCash, equity: _equity, openPositions, maxPositions } = input;

  // Validate inputs
  const p = Math.max(0, Math.min(1, probProfit));
  const q = 1 - p;
  const gain = Math.max(0.001, expectedGainRatio);
  const loss = Math.max(0.001, expectedLossRatio);

  // b = win/loss ratio (how much you win per unit you could lose)
  const b = gain / loss;

  // Raw Kelly: f* = (p*b - q) / b
  const rawKellyF = (p * b - q) / b;
  const edge = p * b - q; // positive = positive EV

  // Check: no edge
  if (rawKellyF <= 0) {
    return {
      fractionOfCash: 0,
      notional: 0,
      rawKellyF,
      halfKellyF: 0,
      finalFraction: 0,
      shouldTrade: false,
      reason: `Negative edge: f*=${rawKellyF.toFixed(4)} (p=${p.toFixed(3)}, b=${b.toFixed(2)})`,
      edge,
    };
  }

  // Check: probability below minimum
  if (p < minProbThreshold) {
    return {
      fractionOfCash: 0,
      notional: 0,
      rawKellyF,
      halfKellyF: rawKellyF * kellyFraction,
      finalFraction: 0,
      shouldTrade: false,
      reason: `P(profit)=${p.toFixed(3)} below threshold ${minProbThreshold}`,
      edge,
    };
  }

  // Check: edge below minimum
  if (edge < minEdgeThreshold) {
    return {
      fractionOfCash: 0,
      notional: 0,
      rawKellyF,
      halfKellyF: rawKellyF * kellyFraction,
      finalFraction: 0,
      shouldTrade: false,
      reason: `Edge=${edge.toFixed(4)} below threshold ${minEdgeThreshold}`,
      edge,
    };
  }

  // Apply Kelly fraction (half-Kelly for safety)
  const halfKellyF = rawKellyF * kellyFraction;

  // Apply position size bounds
  let finalFraction = Math.max(minPositionPct, Math.min(maxPositionPct, halfKellyF));

  // Portfolio-level cap: don't exceed max total allocation
  // Remaining allocation budget = maxTotal - currently_allocated
  // Simple model: assume each open position uses equal share
  if (openPositions > 0 && maxPositions > 0) {
    const estimatedCurrentAllocation = (openPositions / maxPositions) * maxTotalAllocationPct;
    const remainingBudget = Math.max(0, maxTotalAllocationPct - estimatedCurrentAllocation);
    // Scale position to fit within remaining budget
    const perPositionBudget = remainingBudget / Math.max(1, maxPositions - openPositions);
    finalFraction = Math.min(finalFraction, perPositionBudget);
  }

  // Ensure minimum position size
  finalFraction = Math.max(0, finalFraction);

  const notional = finalFraction * availableCash;

  // Check minimum notional
  if (notional < minNotional) {
    return {
      fractionOfCash: 0,
      notional: 0,
      rawKellyF,
      halfKellyF,
      finalFraction: 0,
      shouldTrade: false,
      reason: `Notional $${notional.toFixed(0)} below minimum $${minNotional}`,
      edge,
    };
  }

  return {
    fractionOfCash: finalFraction,
    notional,
    rawKellyF,
    halfKellyF,
    finalFraction,
    shouldTrade: true,
    edge,
  };
}

/**
 * Convenience: compute Kelly sizing from particle filter estimates.
 *
 * Uses the filter's P(profit) as probability and derives win/loss ratios
 * from the target price and current price.
 */
export function kellyFromFilterEstimate(
  probProfit: number,
  currentPrice: number,
  targetPrice: number,
  stopLossPrice: number,
  availableCash: number,
  equity: number,
  openPositions: number,
  maxPositions: number,
  config?: KellyConfig
): KellyResult {
  // Expected gain = (target - current) / current
  const expectedGainRatio = Math.abs(targetPrice - currentPrice) / currentPrice;
  // Expected loss = (current - stopLoss) / current
  const expectedLossRatio = Math.abs(currentPrice - stopLossPrice) / currentPrice;

  return computeKelly(
    {
      probProfit,
      expectedGainRatio,
      expectedLossRatio,
      availableCash,
      equity,
      openPositions,
      maxPositions,
    },
    config
  );
}

/**
 * Batch Kelly sizing for multiple candidates. Useful for ranking and allocation.
 * Returns results sorted by edge (descending).
 */
export function batchKelly(
  candidates: Array<{
    symbol: string;
    probProfit: number;
    expectedGainRatio: number;
    expectedLossRatio: number;
  }>,
  availableCash: number,
  equity: number,
  openPositions: number,
  maxPositions: number,
  config?: KellyConfig
): Array<{ symbol: string; kelly: KellyResult }> {
  return candidates
    .map((c) => ({
      symbol: c.symbol,
      kelly: computeKelly(
        {
          ...c,
          availableCash,
          equity,
          openPositions,
          maxPositions,
        },
        config
      ),
    }))
    .sort((a, b) => b.kelly.edge - a.kelly.edge);
}
