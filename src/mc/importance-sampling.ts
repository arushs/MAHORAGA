/**
 * Importance Sampling for Monte Carlo tail event estimation.
 *
 * Uses exponential tilting (mean-shift) of the GBM log-return distribution
 * to oversample tail events. The likelihood ratio corrects for the bias,
 * yielding unbiased estimates with dramatically reduced variance for rare events.
 *
 * Key idea: Under GBM, log(S_T/S_0) ~ N(m, v²) where m = (μ - σ²/2)T, v = σ√T.
 * We shift the mean by θ·v to tilt the distribution toward the tail of interest.
 * The likelihood ratio is exp(-θ·Z_tilted + θ²/2) for each sample.
 *
 * Achieves 1000x+ variance reduction for events at 3+ sigma.
 */

import type { MCSimulationResult } from "./types";

// ── Types ───────────────────────────────────────────────────────────────

export interface ISConfig {
  /** Current asset price */
  currentPrice: number;
  /** Annualized volatility */
  annualizedVol: number;
  /** Time horizon in milliseconds */
  horizonMs: number;
  /** Threshold price (estimate P(S_T <= threshold) for losses, P(S_T >= threshold) for gains) */
  threshold: number;
  /** Direction: 'loss' estimates P(S_T <= threshold), 'gain' estimates P(S_T >= threshold) */
  direction: "loss" | "gain";
  /** Number of simulation paths (default: 50_000) */
  numPaths?: number;
  /** Drift rate μ (default: 0, conservative) */
  drift?: number;
}

export interface ISResult extends MCSimulationResult {
  /** Optimal tilt parameter θ used */
  tiltTheta: number;
  /** Estimated variance reduction factor vs naive MC */
  varianceReductionFactor: number;
  /** Effective sample size (ESS) as fraction of numPaths */
  effectiveSampleSizePct: number;
}

/** Result from simulating full loss distribution (used by stop-loss) */
export interface LossDistributionResult {
  /** Percentile losses (negative = loss). Index i = (i+1)th percentile. */
  percentileLosses: Float64Array;
  /** VaR at given confidence level */
  varAtConfidence: number;
  /** CVaR (expected shortfall) at given confidence level */
  cvarAtConfidence: number;
  /** Confidence level used */
  confidenceLevel: number;
  /** Number of paths simulated */
  pathsSimulated: number;
  /** Compute time in ms */
  computeTimeMs: number;
  /** Variance reduction factor */
  varianceReductionFactor: number;
}

// ── Core helpers ────────────────────────────────────────────────────────

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Standard normal CDF via rational approximation (Abramowitz & Stegun 26.2.17) */
function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * erf);
}

/** Box-Muller transform for normal random pairs */
function boxMuller(u1: number, u2: number): [number, number] {
  const cu1 = Math.max(1e-10, Math.min(1 - 1e-10, u1));
  const cu2 = Math.max(1e-10, Math.min(1 - 1e-10, u2));
  const r = Math.sqrt(-2 * Math.log(cu1));
  const theta = 2 * Math.PI * cu2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** Halton quasi-random sequence */
function halton(n: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = n;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result || 5e-11;
}

/** Compute optimal tilt parameter θ for exponential tilting.
 *  For P(S_T <= K) (loss tail), we want θ < 0 to shift distribution left.
 *  For P(S_T >= K) (gain tail), we want θ > 0 to shift distribution right.
 *  Optimal θ makes the threshold the new mean: θ = (log(K/S) - m) / v
 */
function computeOptimalTilt(
  currentPrice: number,
  threshold: number,
  m: number,
  v: number,
  direction: "loss" | "gain",
): number {
  const logReturn = Math.log(threshold / currentPrice);
  // θ shifts the standard normal mean: Z_tilted ~ N(θ, 1)
  let theta = (logReturn - m) / v;

  // For loss direction, we want θ < 0; for gain, θ > 0
  if (direction === "loss" && theta > 0) theta = -Math.abs(theta);
  if (direction === "gain" && theta < 0) theta = Math.abs(theta);

  // Clamp to avoid extreme tilts (numerical stability)
  return Math.max(-10, Math.min(10, theta));
}

// ── Main importance sampling estimator ──────────────────────────────────

/**
 * Estimate tail probability using importance sampling with exponential tilting.
 *
 * For a GBM model S_T = S_0 * exp(m + v*Z), we tilt Z ~ N(0,1) to Z' ~ N(θ,1).
 * The likelihood ratio w(Z') = exp(-θ*Z' + θ²/2) corrects the bias.
 * Estimate = (1/N) Σ 1{event}(Z'_i) * w(Z'_i)
 */
export function estimateTailProbability(config: ISConfig): ISResult {
  const t0 = performance.now();

  const numPaths = config.numPaths ?? 50_000;
  const drift = config.drift ?? 0;
  const T = config.horizonMs / YEAR_MS;
  const v = config.annualizedVol * Math.sqrt(T); // vol * sqrt(T)
  const m = (drift - config.annualizedVol * config.annualizedVol / 2) * T; // log-return mean

  // Compute optimal tilt
  const theta = computeOptimalTilt(config.currentPrice, config.threshold, m, v, config.direction);
  const thetaSq = theta * theta;

  // For naive MC variance estimate (theoretical)
  const zThreshold = (Math.log(config.threshold / config.currentPrice) - m) / v;
  const naiveProbEst = config.direction === "loss"
    ? normalCDF(zThreshold)
    : 1 - normalCDF(zThreshold);

  let sumW = 0;
  let sumW2 = 0;

  // Generate tilted samples using Halton QMC + Box-Muller
  const halfPaths = Math.ceil(numPaths / 2);

  for (let i = 1; i <= halfPaths; i++) {
    const u1 = halton(i, 2);
    const u2 = halton(i, 3);
    const [z1Base, z2Base] = boxMuller(u1, u2);

    // Process both z values from Box-Muller + antithetic
    const zValues = [z1Base, z2Base, -z1Base, -z2Base];

    for (const zRaw of zValues) {
      // Tilted sample: Z' = Z + θ (shift the mean)
      const zTilted = zRaw + theta;

      // Log return under tilted measure
      const logReturn = m + v * zTilted;
      const sT = config.currentPrice * Math.exp(logReturn);

      // Check if event occurred
      const eventOccurred = config.direction === "loss"
        ? sT <= config.threshold
        : sT >= config.threshold;

      if (eventOccurred) {
        // Likelihood ratio: w = exp(-θ*Z_tilted + θ²/2)
        // = exp(-θ*(Z+θ) + θ²/2) = exp(-θ*Z - θ² + θ²/2) = exp(-θ*Z - θ²/2)
        const w = Math.exp(-theta * zTilted + thetaSq / 2);
        sumW += w;
        sumW2 += w * w;
      }
    }
  }

  const actualPaths = halfPaths * 4; // 2 from Box-Muller × 2 antithetic
  const probability = sumW / actualPaths;

  // Variance of IS estimator
  const varIS = (sumW2 / actualPaths) - probability * probability;

  // Variance of naive MC (Bernoulli: p(1-p))
  const naiveVar = Math.max(naiveProbEst * (1 - naiveProbEst), 1e-20);

  // Variance reduction factor
  const vrFactor = varIS > 0 ? naiveVar / varIS : naiveVar / 1e-20;

  // Effective sample size
  const ess = sumW > 0 ? (sumW * sumW) / sumW2 : 0;
  const essPct = (ess / actualPaths) * 100;

  // Confidence interval (Wald)
  const se = Math.sqrt(Math.max(varIS, 0) / actualPaths);
  const ci: [number, number] = [
    Math.max(0, probability - 1.96 * se),
    Math.min(1, probability + 1.96 * se),
  ];

  return {
    probability: Math.max(0, Math.min(1, probability)),
    confidenceInterval: ci,
    pathsSimulated: actualPaths,
    computeTimeMs: performance.now() - t0,
    tiltTheta: theta,
    varianceReductionFactor: Math.max(1, vrFactor),
    effectiveSampleSizePct: Math.min(100, essPct),
  };
}

// ── Loss distribution estimator (for dynamic stop-loss) ─────────────────

/**
 * Estimate the full loss distribution using IS-enhanced simulation.
 * Returns percentile losses and VaR/CVaR at specified confidence.
 *
 * Uses a two-pass approach:
 * 1. Generate weighted samples of terminal returns
 * 2. Build weighted empirical CDF for percentile extraction
 */
export function estimateLossDistribution(config: {
  currentPrice: number;
  annualizedVol: number;
  horizonMs: number;
  confidenceLevel?: number; // default 0.99
  numPaths?: number; // default 50_000
  drift?: number;
}): LossDistributionResult {
  const t0 = performance.now();

  const numPaths = config.numPaths ?? 50_000;
  const drift = config.drift ?? 0;
  const confidence = config.confidenceLevel ?? 0.99;
  const T = config.horizonMs / YEAR_MS;
  const v = config.annualizedVol * Math.sqrt(T);
  const m = (drift - config.annualizedVol * config.annualizedVol / 2) * T;

  // Tilt toward the left tail (losses) at ~2.5 sigma
  const theta = -2.5;
  const thetaSq = theta * theta;

  interface WeightedSample { returnPct: number; weight: number }
  const samples: WeightedSample[] = [];

  const halfPaths = Math.ceil(numPaths / 2);

  for (let i = 1; i <= halfPaths; i++) {
    const u1 = halton(i, 2);
    const u2 = halton(i, 3);
    const [z1, z2] = boxMuller(u1, u2);

    for (const zRaw of [z1, z2, -z1, -z2]) {
      const zTilted = zRaw + theta;
      const logReturn = m + v * zTilted;
      const returnPct = (Math.exp(logReturn) - 1) * 100; // % return

      // Likelihood ratio
      const w = Math.exp(-theta * zTilted + thetaSq / 2);
      samples.push({ returnPct, weight: w });
    }
  }

  // Sort by return (ascending — worst first)
  samples.sort((a, b) => a.returnPct - b.returnPct);

  // Build weighted CDF and extract percentiles
  const totalWeight = samples.reduce((s, x) => s + x.weight, 0);
  const percentileLosses = new Float64Array(99);

  let cumWeight = 0;
  let pIdx = 0;

  // Also compute CVaR (expected shortfall): E[loss | loss > VaR]
  let cvarNumerator = 0;
  let cvarDenominator = 0;
  let varValue = 0;
  const varPercentile = confidence;

  for (const sample of samples) {
    cumWeight += sample.weight;
    const cdf = cumWeight / totalWeight;

    // Fill percentiles
    while (pIdx < 99 && cdf >= (pIdx + 1) / 100) {
      percentileLosses[pIdx] = sample.returnPct;
      pIdx++;
    }

    // CVaR accumulation (left tail)
    if (cdf <= 1 - varPercentile) {
      cvarNumerator += sample.returnPct * sample.weight;
      cvarDenominator += sample.weight;
    }

    // VaR
    if (cdf <= 1 - varPercentile) {
      varValue = sample.returnPct;
    }
  }

  // Fill remaining percentiles
  while (pIdx < 99) {
    percentileLosses[pIdx] = samples[samples.length - 1]!.returnPct;
    pIdx++;
  }

  const cvar = cvarDenominator > 0 ? cvarNumerator / cvarDenominator : varValue;

  // Estimate VR factor: compare IS variance to naive for the VaR quantile
  const naiveVarProb = (1 - confidence) * confidence;
  const isWeights = samples.map(s => s.weight);
  const wMean = totalWeight / samples.length;
  const wVar = isWeights.reduce((s, w) => s + (w - wMean) ** 2, 0) / samples.length;
  const vrFactor = wVar > 0 ? naiveVarProb / (wVar / (samples.length * wMean * wMean)) : 1;

  return {
    percentileLosses,
    varAtConfidence: varValue,
    cvarAtConfidence: cvar,
    confidenceLevel: confidence,
    pathsSimulated: samples.length,
    computeTimeMs: performance.now() - t0,
    varianceReductionFactor: Math.max(1, vrFactor),
  };
}
