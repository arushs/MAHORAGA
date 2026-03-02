/**
 * Execution Optimizer
 *
 * Splits large orders into optimal child slices using ABM simulator
 * to minimize total market impact + timing risk.
 *
 * Strategies:
 *   - TWAP: Time-weighted average price — equal slices over time
 *   - VWAP: Volume-weighted — front-loads during high volume periods
 *   - Adaptive: ABM-guided — simulates each slice, optimizes split
 *
 * Output: ExecutionPlan consumed by PolicyBroker to drip-feed orders.
 */

import { runABM } from './abm';

// ── Types ───────────────────────────────────────────────────────────────

export type ExecutionStrategy = 'twap' | 'vwap' | 'adaptive';

export interface ExecutionRequest {
  /** Total order size in shares */
  totalShares: number;
  /** Order side */
  side: 'buy' | 'sell';
  /** Current market price */
  currentPrice: number;
  /** Estimated daily volume */
  dailyVolume: number;
  /** Annualized volatility */
  annualizedVol: number;
  /** Strategy to use. Default: 'adaptive' */
  strategy?: ExecutionStrategy;
  /** Maximum number of child slices. Default: 10 */
  maxSlices?: number;
  /** Maximum participation rate (fraction of volume per slice). Default: 0.05 */
  maxParticipationRate?: number;
  /** Time horizon for execution (minutes). Default: 60 */
  horizonMinutes?: number;
  /** PRNG seed */
  seed?: number;
}

export interface ExecutionSlice {
  /** Slice index (0-based) */
  index: number;
  /** Number of shares in this slice */
  shares: number;
  /** Delay from execution start (minutes) */
  delayMinutes: number;
  /** Estimated slippage for this slice (bps) */
  estimatedSlippageBps: number;
  /** Estimated fill price */
  estimatedFillPrice: number;
  /** Fraction of total order */
  fractionOfTotal: number;
}

export interface ExecutionPlan {
  /** Ordered list of slices to execute */
  slices: ExecutionSlice[];
  /** Strategy used */
  strategy: ExecutionStrategy;
  /** Total estimated slippage (volume-weighted average, bps) */
  totalSlippageBps: number;
  /** Total estimated cost (dollars above/below mid) */
  totalImpactCost: number;
  /** Estimated total fill price (VWAP of slices) */
  estimatedVwap: number;
  /** Participation rate (max slice / volume-per-interval) */
  maxParticipationRate: number;
  /** Computation time (ms) */
  computeTimeMs: number;
}

// ── Volume profile (intraday U-shape) ───────────────────────────────────

/**
 * Typical intraday volume profile (U-shape).
 * Returns relative volume weight for a given fraction of trading day [0, 1].
 */
function intradayVolumeWeight(fractionOfDay: number): number {
  // U-shape: high at open/close, low midday
  // Quadratic: w(t) = 4*(t-0.5)^2 + 0.5
  const t = Math.max(0, Math.min(1, fractionOfDay));
  return 4 * (t - 0.5) ** 2 + 0.5;
}

// ── TWAP Strategy ───────────────────────────────────────────────────────

function planTWAP(req: ExecutionRequest, numSlices: number): ExecutionSlice[] {
  const sharesPerSlice = Math.max(1, Math.round(req.totalShares / numSlices));
  const intervalMin = req.horizonMinutes! / numSlices;
  const slices: ExecutionSlice[] = [];

  let remaining = req.totalShares;
  for (let i = 0; i < numSlices; i++) {
    const shares = i === numSlices - 1 ? remaining : Math.min(sharesPerSlice, remaining);
    if (shares <= 0) break;
    slices.push({
      index: i,
      shares,
      delayMinutes: i * intervalMin,
      estimatedSlippageBps: 0, // filled later
      estimatedFillPrice: 0,
      fractionOfTotal: shares / req.totalShares,
    });
    remaining -= shares;
  }

  return slices;
}

// ── VWAP Strategy ───────────────────────────────────────────────────────

function planVWAP(req: ExecutionRequest, numSlices: number): ExecutionSlice[] {
  const intervalMin = req.horizonMinutes! / numSlices;
  const tradingDayMin = 390; // 6.5 hours

  // Get volume weights for each interval
  const weights: number[] = [];
  for (let i = 0; i < numSlices; i++) {
    const tFrac = (i * intervalMin) / tradingDayMin;
    weights.push(intradayVolumeWeight(tFrac));
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const slices: ExecutionSlice[] = [];
  let remaining = req.totalShares;

  for (let i = 0; i < numSlices; i++) {
    const fraction = weights[i]! / totalWeight;
    const shares = i === numSlices - 1
      ? remaining
      : Math.max(1, Math.round(req.totalShares * fraction));
    const actualShares = Math.min(shares, remaining);
    if (actualShares <= 0) break;

    slices.push({
      index: i,
      shares: actualShares,
      delayMinutes: i * intervalMin,
      estimatedSlippageBps: 0,
      estimatedFillPrice: 0,
      fractionOfTotal: actualShares / req.totalShares,
    });
    remaining -= actualShares;
  }

  return slices;
}

// ── Adaptive Strategy (ABM-guided) ──────────────────────────────────────

function planAdaptive(req: ExecutionRequest, numSlices: number): ExecutionSlice[] {
  // Start with VWAP split, then adjust based on ABM slippage estimates
  const base = planVWAP(req, numSlices);
  const seed = req.seed ?? (Date.now() ^ 0xfeed);

  // Simulate slippage for different slice sizes to find optimal split
  // Binary search: if a slice has high slippage, split it further
  for (let iter = 0; iter < 3; iter++) {
    for (const slice of base) {
      const abm = runABM(
        {
          initialPrice: req.currentPrice,
          dailyVolume: req.dailyVolume,
          annualizedVol: req.annualizedVol,
          numSteps: 100, // Fast sim for estimation
          seed: seed + slice.index + iter * 100,
        },
        slice.shares,
        req.side,
        20, // fewer trials for speed
      );
      slice.estimatedSlippageBps = abm.slippage.expectedSlippageBps;
    }

    // Redistribute: take from high-slippage slices, give to low-slippage
    const avgSlippage = base.reduce((s, sl) => s + sl.estimatedSlippageBps, 0) / base.length;
    let anyRedistributed = false;

    for (let i = 0; i < base.length; i++) {
      const sl = base[i]!;
      if (sl.estimatedSlippageBps > avgSlippage * 1.5 && sl.shares > 2) {
        // Find the lowest-slippage slice to receive
        let minIdx = -1;
        let minSlip = Infinity;
        for (let j = 0; j < base.length; j++) {
          if (j !== i && base[j]!.estimatedSlippageBps < minSlip) {
            minSlip = base[j]!.estimatedSlippageBps;
            minIdx = j;
          }
        }
        if (minIdx >= 0) {
          const transfer = Math.max(1, Math.round(sl.shares * 0.2));
          sl.shares -= transfer;
          base[minIdx]!.shares += transfer;
          anyRedistributed = true;
        }
      }
    }

    if (!anyRedistributed) break;
  }

  // Update fractions
  const total = base.reduce((s, sl) => s + sl.shares, 0);
  for (const sl of base) {
    sl.fractionOfTotal = sl.shares / total;
  }

  return base;
}

// ── Main entry point ────────────────────────────────────────────────────

export function optimizeExecution(req: ExecutionRequest): ExecutionPlan {
  const t0 = performance.now();

  const strategy = req.strategy ?? 'adaptive';
  const maxSlices = req.maxSlices ?? 10;
  const maxParticipation = req.maxParticipationRate ?? 0.05;
  const horizonMin = req.horizonMinutes ?? 60;

  // Determine number of slices based on participation rate
  const volumePerMinute = req.dailyVolume / 390;
  const intervalMin = horizonMin / maxSlices;
  const volumePerInterval = volumePerMinute * intervalMin;
  const maxSharesPerSlice = Math.floor(volumePerInterval * maxParticipation);

  const minSlices = maxSharesPerSlice > 0
    ? Math.max(2, Math.ceil(req.totalShares / maxSharesPerSlice))
    : maxSlices;
  const numSlices = Math.min(maxSlices, Math.max(minSlices, 2));

  const fullReq = { ...req, horizonMinutes: horizonMin };

  // Plan slices
  let slices: ExecutionSlice[];
  switch (strategy) {
    case 'twap':
      slices = planTWAP(fullReq, numSlices);
      break;
    case 'vwap':
      slices = planVWAP(fullReq, numSlices);
      break;
    case 'adaptive':
      slices = planAdaptive(fullReq, numSlices);
      break;
  }

  // Run ABM for final slippage estimates
  const seed = req.seed ?? (Date.now() ^ 0xfeed);
  for (const slice of slices) {
    const abm = runABM(
      {
        initialPrice: req.currentPrice,
        dailyVolume: req.dailyVolume,
        annualizedVol: req.annualizedVol,
        numSteps: 200,
        seed: seed + slice.index * 1000,
      },
      slice.shares,
      req.side,
      30,
    );
    slice.estimatedSlippageBps = abm.slippage.expectedSlippageBps;
    slice.estimatedFillPrice = abm.slippage.avgFillPrice;
  }

  // Aggregate metrics
  const totalShares = slices.reduce((s, sl) => s + sl.shares, 0);
  const totalSlippageBps = slices.reduce(
    (s, sl) => s + sl.estimatedSlippageBps * sl.fractionOfTotal, 0,
  );
  const estimatedVwap = totalShares > 0
    ? slices.reduce((s, sl) => s + sl.estimatedFillPrice * sl.shares, 0) / totalShares
    : req.currentPrice;
  const totalImpactCost = Math.abs(estimatedVwap - req.currentPrice) * totalShares;

  const actualMaxParticipation = volumePerInterval > 0
    ? Math.max(...slices.map((sl) => sl.shares)) / volumePerInterval
    : 1;

  return {
    slices,
    strategy,
    totalSlippageBps,
    totalImpactCost,
    estimatedVwap,
    maxParticipationRate: actualMaxParticipation,
    computeTimeMs: performance.now() - t0,
  };
}
