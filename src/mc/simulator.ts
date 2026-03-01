/**
 * GBM Monte Carlo Simulator — Stub (to be implemented by Jarvis)
 *
 * Binary contract pricing via Geometric Brownian Motion simulation
 * with variance reduction (antithetic variates + stratified sampling).
 */

export interface SimulationParams {
  /** Current asset price */
  currentPrice: number;
  /** Strike / target price for binary contract */
  strikePrice: number;
  /** Annualized volatility (e.g., 0.3 = 30%) */
  volatility: number;
  /** Time horizon in years (e.g., 1/252 for 1 trading day) */
  timeHorizon: number;
  /** Risk-free rate (annualized, e.g., 0.05) */
  riskFreeRate: number;
  /** Number of simulation paths */
  numPaths: number;
  /** Random seed for reproducibility (optional) */
  seed?: number;
}

export interface SimulationResult {
  /** Estimated probability that price ends above strike */
  probability: number;
  /** Standard error of the estimate */
  standardError: number;
  /** 95% confidence interval [lower, upper] */
  confidenceInterval: [number, number];
  /** Variance reduction ratio vs naive MC (if variance reduction used) */
  varianceReductionRatio?: number;
}

export interface VarianceReductionConfig {
  /** Use antithetic variates */
  antithetic: boolean;
  /** Use stratified sampling */
  stratified: boolean;
}

/**
 * Simulate binary digital option price via GBM Monte Carlo.
 * P(S_T > K) where S_T follows GBM.
 */
export function simulateBinaryOption(
  params: SimulationParams,
  vrConfig?: VarianceReductionConfig,
): SimulationResult {
  // TODO: Implement — Jarvis
  throw new Error("Not implemented");
}

/**
 * Black-Scholes closed-form for digital call: P(S_T > K)
 * Used as reference for testing.
 */
export function blackScholesDigitalCall(
  currentPrice: number,
  strikePrice: number,
  volatility: number,
  timeHorizon: number,
  riskFreeRate: number,
): number {
  // d2 = (ln(S/K) + (r - σ²/2) * T) / (σ * √T)
  const d2 =
    (Math.log(currentPrice / strikePrice) +
      (riskFreeRate - 0.5 * volatility * volatility) * timeHorizon) /
    (volatility * Math.sqrt(timeHorizon));
  return normalCDF(d2);
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17 approximation, max error 7.5e-8) */
export function normalCDF(x: number): number {
  if (x >= 6) return 1;
  if (x <= -6) return 0;

  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;

  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const pdf = Math.exp(-0.5 * absX * absX) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const cdf = 1.0 - pdf * poly;

  return x >= 0 ? cdf : 1.0 - cdf;
}
