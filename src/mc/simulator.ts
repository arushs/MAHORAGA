/**
 * Monte Carlo GBM path simulator with variance reduction stack.
 *
 * Variance reduction techniques (combined):
 *   1. Halton quasi-random sequences — bases 2 & 3 for 2D Box-Muller pairs
 *   2. Antithetic variates — pair each Z with -Z
 *   3. Control variates — BS call payoff as analytic control for digital payoff
 *
 * GBM model: S_T = S_0 · exp((μ − σ²/2)T + σ√T · Z), drift μ = 0 (conservative).
 * Estimand: P(S_T ≥ K) — probability of reaching target price.
 */

import type { MCSimulationParams, MCSimulationResult } from "./types";

// ── Halton quasi-random sequence ────────────────────────────────────────

/** Halton sequence value for index n in given base. Returns value in (0, 1). */
function halton(n: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = n;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result || 5e-11; // avoid exact 0
}

// ── Box-Muller ──────────────────────────────────────────────────────────

function boxMuller(u1: number, u2: number): [number, number] {
  // Clamp away from 0 and 1 for numerical safety
  const cu1 = Math.max(1e-10, Math.min(1 - 1e-10, u1));
  const cu2 = Math.max(1e-10, Math.min(1 - 1e-10, u2));
  const r = Math.sqrt(-2 * Math.log(cu1));
  const theta = 2 * Math.PI * cu2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ── Black-Scholes analytics ─────────────────────────────────────────────

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7). */
function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2; // erf argument
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** BS digital call: P(S_T ≥ K) = N(d2) under real-world measure (μ = drift). */
function bsDigitalProb(S: number, K: number, vol: number, T: number, mu = 0): number {
  if (T <= 0) return S >= K ? 1 : 0;
  if (vol <= 0) return S * Math.exp(mu * T) >= K ? 1 : 0;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(S / K) + (mu - 0.5 * vol * vol) * T) / (vol * sqrtT);
  return normalCDF(d2);
}

/** BS call expected value: E[max(S_T - K, 0)] under real-world measure. */
function bsCallExpected(S: number, K: number, vol: number, T: number, mu = 0): number {
  if (T <= 0) return Math.max(0, S - K);
  if (vol <= 0) return Math.max(0, S * Math.exp(mu * T) - K);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (mu + 0.5 * vol * vol) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return S * Math.exp(mu * T) * normalCDF(d1) - K * normalCDF(d2);
}

// ── Simulator ───────────────────────────────────────────────────────────

/**
 * Run Monte Carlo simulation estimating P(S_T ≥ targetPrice).
 *
 * Control variate: continuous call payoff max(S_T - K, 0) — its analytic
 * expectation is the BS call formula. Highly correlated with digital payoff.
 */
export function runSimulation(
  params: MCSimulationParams,
  fallbackConfidence?: number,
): MCSimulationResult {
  const {
    currentPrice: S0,
    impliedVol: vol,
    horizonMs,
    targetPrice: K,
    numPaths: requestedPaths = 10_000,
  } = params;

  // Degenerate cases → fallback
  if (!K || vol <= 0 || horizonMs <= 0) {
    const p = fallbackConfidence ?? 0.5;
    const hw = 1.96 * Math.sqrt((p * (1 - p)) / requestedPaths);
    return {
      probability: p,
      confidenceInterval: [Math.max(0, p - hw), Math.min(1, p + hw)],
      pathsSimulated: 0,
      computeTimeMs: 0,
    };
  }

  const t0 = performance.now();

  const T = horizonMs / (365.25 * 24 * 3600_000); // ms → years
  const mu = 0;
  const driftTerm = (mu - 0.5 * vol * vol) * T;
  const volSqrtT = vol * Math.sqrt(T);

  // Analytic expectation for control variate (BS call price)
  const EcCall = bsCallExpected(S0, K, vol, T, mu);

  // Each Halton point → 2 normals (Box-Muller) × 2 antithetic = 4 paths
  const nHalton = Math.max(1, Math.ceil(requestedPaths / 4));
  const N = nHalton * 4;

  // Accumulators for control variate regression
  // Y = digital payoff, C = call payoff
  let sumY = 0, sumC = 0;
  let sumYY = 0, sumCC = 0, sumYC = 0;

  for (let i = 0; i < nHalton; i++) {
    const u1 = halton(i + 1, 2);
    const u2 = halton(i + 1, 3);
    const [z1, z2] = boxMuller(u1, u2);

    // 4 paths: z1, z2, -z1, -z2
    const normals = [z1, z2, -z1, -z2];
    for (let j = 0; j < 4; j++) {
      const z = normals[j]!;
      const ST = S0 * Math.exp(driftTerm + volSqrtT * z);

      const y = ST >= K ? 1 : 0;
      const c = Math.max(0, ST - K);

      sumY += y;
      sumC += c;
      sumYY += y; // y² = y for binary
      sumCC += c * c;
      sumYC += y * c;
    }
  }

  const meanY = sumY / N;
  const meanC = sumC / N;
  const varY = sumYY / N - meanY * meanY;
  const varC = sumCC / N - meanC * meanC;
  const covYC = sumYC / N - meanY * meanC;

  let probability: number;
  let estimateVar: number;

  if (varC > 1e-20 && varY > 1e-20) {
    const beta = covYC / varC;
    probability = meanY - beta * (meanC - EcCall);

    const rho2 = Math.min(0.9999, (covYC * covYC) / (varY * varC));
    estimateVar = varY * (1 - rho2) / N;
  } else {
    // Edge case: all paths hit or all miss → use analytic
    probability = varY < 1e-20 ? meanY : meanY;
    estimateVar = varY / N;
  }

  probability = Math.max(0, Math.min(1, probability));
  const se = Math.sqrt(Math.max(0, estimateVar));
  const hw = 1.96 * se;

  return {
    probability,
    confidenceInterval: [
      Math.max(0, probability - hw),
      Math.min(1, probability + hw),
    ],
    pathsSimulated: N,
    computeTimeMs: performance.now() - t0,
  };
}

// Exported for testing
export { bsDigitalProb, bsCallExpected, normalCDF };
