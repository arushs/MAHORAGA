/**
 * Monte Carlo GBM path simulator with variance reduction stack.
 *
 * Variance reduction techniques (combined):
 *   1. Sobol quasi-random sequences — 2D low-discrepancy for Box-Muller pairs
 *   2. Antithetic variates — pair each Z with -Z
 *   3. Control variates — BS call price as analytic control for digital payoff
 *
 * GBM model: S_T = S_0 · exp((μ − σ²/2)T + σ√T · Z), drift μ = 0 (conservative).
 * Estimand: P(S_T ≥ K) — probability of reaching target price.
 */

import type { MCSimulationParams, MCSimulationResult } from "./types";

// ── Sobol quasi-random (2D) ─────────────────────────────────────────────

/**
 * Van der Corput (base-2 bit-reversal) for dimension 0.
 * Maps n ∈ [1, 2^32) → (0, 1).
 */
function vanDerCorput(n: number): number {
  n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
  n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
  n = ((n >>> 4) & 0x0f0f0f0f) | ((n & 0x0f0f0f0f) << 4);
  n = ((n >>> 8) & 0x00ff00ff) | ((n & 0x00ff00ff) << 8);
  n = (n >>> 16) | (n << 16);
  return (n >>> 0) / 4294967296 + 5e-11;
}

/** Sobol direction numbers for dimension 1 (primitive polynomial x+1, degree 1). */
const DIR1: number[] = new Array(32);
for (let i = 0; i < 32; i++) DIR1[i] = 1 << (31 - i);

/** Gray-code Sobol generator for dimension 1. */
class SobolDim1 {
  private x = 0;
  private idx = 0;
  next(): number {
    if (this.idx === 0) { this.idx++; return 0.5; }
    let c = 0;
    let v = this.idx;
    while ((v & 1) === 0) { v >>>= 1; c++; }
    this.x ^= DIR1[c]!;
    this.idx++;
    return (this.x >>> 0) / 4294967296 + 5e-11;
  }
}

// ── Box-Muller ──────────────────────────────────────────────────────────

function boxMuller(u1: number, u2: number): [number, number] {
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ── Black-Scholes analytics ─────────────────────────────────────────────

/** Standard normal CDF (Abramowitz & Stegun, |ε| < 7.5e-8). */
function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/** BS digital call: P(S_T ≥ K) = N(d2) under real-world measure (r=drift). */
export function bsDigitalProb(S: number, K: number, vol: number, T: number, mu = 0): number {
  if (T <= 0) return S >= K ? 1 : 0;
  if (vol <= 0) return S * Math.exp(mu * T) >= K ? 1 : 0;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(S / K) + (mu - 0.5 * vol * vol) * T) / (vol * sqrtT);
  return normalCDF(d2);
}

/** BS vanilla call price: E[max(S_T - K, 0)] under real-world measure. */
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
 * Control variate: use continuous call payoff max(S_T - K, 0) as control.
 * Its analytic expectation is the BS call formula. The digital payoff (our target)
 * is highly correlated with it, giving substantial variance reduction.
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
  const mu = 0; // conservative drift
  const sqrtT = Math.sqrt(T);
  const driftTerm = (mu - 0.5 * vol * vol) * T;
  const volSqrtT = vol * sqrtT;

  // Analytic control expectations
  const Ec = bsCallExpected(S0, K, vol, T, mu); // E[max(S_T - K, 0)]

  // Each Sobol point → 2 normals via Box-Muller, × 2 antithetic = 4 paths
  const nSobol = Math.max(1, Math.ceil(requestedPaths / 4));
  const N = nSobol * 4;

  const sobol1 = new SobolDim1();

  // Accumulators (Welford-style would be more stable but for N≤100K this is fine)
  let sumY = 0;  // digital payoff
  let sumC = 0;  // call payoff (control)
  let sumYY = 0;
  let sumCC = 0;
  let sumYC = 0;

  for (let i = 0; i < nSobol; i++) {
    const u1 = vanDerCorput(i + 1);
    const u2 = sobol1.next();
    const [z1, z2] = boxMuller(u1, u2);

    // 4 paths: z1, z2, -z1, -z2
    for (let j = 0; j < 4; j++) {
      const z = j === 0 ? z1 : j === 1 ? z2 : j === 2 ? -z1 : -z2;
      const ST = S0 * Math.exp(driftTerm + volSqrtT * z);

      const y = ST >= K ? 1 : 0;         // digital (target estimand)
      const c = Math.max(0, ST - K);     // vanilla call (control)

      sumY += y;
      sumC += c;
      sumYY += y * y; // y² = y for binary
      sumCC += c * c;
      sumYC += y * c;
    }
  }

  const meanY = sumY / N;
  const meanC = sumC / N;

  // Optimal beta = Cov(Y,C) / Var(C)
  const varC = sumCC / N - meanC * meanC;
  const covYC = sumYC / N - meanY * meanC;
  const varY = sumYY / N - meanY * meanY;

  let probability: number;
  let estimateVar: number;

  if (varC > 1e-20 && varY > 1e-20) {
    const beta = covYC / varC;
    probability = meanY - beta * (meanC - Ec);

    // Var(Y_cv) = Var(Y)(1 - ρ²) / N
    const rho2 = Math.min(1, (covYC * covYC) / (varY * varC));
    estimateVar = varY * (1 - rho2) / N;
  } else {
    probability = meanY;
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
