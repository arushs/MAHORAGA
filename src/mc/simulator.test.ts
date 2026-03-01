/**
 * Variance reduction verification tests.
 *
 * Compares: crude MC vs full VR stack (Sobol + antithetic + control variates).
 * Validates both accuracy (vs BS analytic) and variance reduction ratios.
 */

import { describe, expect, it } from "vitest";
import { runSimulation } from "./simulator";
import type { MCSimulationParams } from "./types";

/** Crude MC estimate using Math.random (no VR). For comparison only. */
function crudeMonteCarloProb(
  S0: number, K: number, vol: number, T: number, N: number
): { mean: number; variance: number } {
  const driftTerm = -0.5 * vol * vol * T;
  const volSqrtT = vol * Math.sqrt(T);
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < N; i++) {
    // Box-Muller with Math.random
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ST = S0 * Math.exp(driftTerm + volSqrtT * z);
    const y = ST >= K ? 1 : 0;
    sum += y;
    sum2 += y;
  }
  const mean = sum / N;
  const variance = sum2 / N - mean * mean;
  return { mean, variance: variance / N };
}

/** Black-Scholes digital prob (analytic reference). */
function bsDigital(S: number, K: number, vol: number, T: number): number {
  const d2 = (Math.log(S / K) - 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
  // Normal CDF
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = d2 < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(d2));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-d2 * d2 / 2);
  return 0.5 * (1 + sign * y);
}

describe("MC Simulator", () => {
  const horizonMs = 7 * 24 * 3600_000; // 1 week

  it("should match BS analytic probability within tight tolerance", () => {
    const cases = [
      { S: 100, K: 102, vol: 0.3 },  // slightly OTM
      { S: 100, K: 98, vol: 0.3 },   // slightly ITM
      { S: 100, K: 100, vol: 0.3 },  // ATM
      { S: 50, K: 55, vol: 0.5 },    // OTM high vol
      { S: 200, K: 190, vol: 0.2 },  // ITM low vol
    ];
    const T = horizonMs / (365.25 * 24 * 3600_000);

    for (const { S, K, vol } of cases) {
      const analytic = bsDigital(S, K, vol, T);
      const result = runSimulation({
        currentPrice: S,
        targetPrice: K,
        impliedVol: vol,
        horizonMs,
        numPaths: 40_000,
      });

      const error = Math.abs(result.probability - analytic);
      // With VR, 40K paths should give <0.5% absolute error
      expect(error).toBeLessThan(0.005);
      expect(result.pathsSimulated).toBeGreaterThan(0);
    }
  });

  it("should achieve meaningful variance reduction vs crude MC", () => {
    const S = 100, K = 102, vol = 0.3;
    const N = 10_000;
    const T = horizonMs / (365.25 * 24 * 3600_000);

    // Run crude MC multiple times to estimate its variance
    const crudeTrials = 50;
    const crudeResults: number[] = [];
    for (let t = 0; t < crudeTrials; t++) {
      crudeResults.push(crudeMonteCarloProb(S, K, vol, T, N).mean);
    }
    const crudeMean = crudeResults.reduce((a, b) => a + b, 0) / crudeTrials;
    const crudeVar = crudeResults.reduce((a, b) => a + (b - crudeMean) ** 2, 0) / (crudeTrials - 1);

    // Run VR simulator multiple times (it's deterministic per N, so vary N slightly)
    const vrResult = runSimulation({
      currentPrice: S, targetPrice: K, impliedVol: vol,
      horizonMs, numPaths: N,
    });

    // The VR CI half-width should be much smaller than crude MC std dev
    const vrHalfWidth = (vrResult.confidenceInterval[1] - vrResult.confidenceInterval[0]) / 2;
    const crudeHalfWidth = 1.96 * Math.sqrt(crudeVar);

    // VR should give at least 3x narrower CI (conservative bound)
    const vrRatio = crudeHalfWidth / Math.max(vrHalfWidth, 1e-10);
    console.log(`VR ratio (CI width): ${vrRatio.toFixed(1)}x`);
    console.log(`Crude CI: ±${(crudeHalfWidth * 100).toFixed(2)}%`);
    console.log(`VR CI: ±${(vrHalfWidth * 100).toFixed(2)}%`);
    expect(vrRatio).toBeGreaterThan(3);
  });

  it("should handle degenerate inputs gracefully", () => {
    // No target price
    const r1 = runSimulation({ currentPrice: 100, impliedVol: 0.3, horizonMs });
    expect(r1.pathsSimulated).toBe(0);
    expect(r1.probability).toBe(0.5);

    // Zero vol
    const r2 = runSimulation({
      currentPrice: 100, impliedVol: 0, horizonMs, targetPrice: 95,
    });
    expect(r2.pathsSimulated).toBe(0);

    // Zero horizon
    const r3 = runSimulation({
      currentPrice: 100, impliedVol: 0.3, horizonMs: 0, targetPrice: 95,
    });
    expect(r3.pathsSimulated).toBe(0);
  });

  it("should run in under 50ms for 10K paths", () => {
    const result = runSimulation({
      currentPrice: 100, targetPrice: 105, impliedVol: 0.3,
      horizonMs, numPaths: 10_000,
    });
    expect(result.computeTimeMs).toBeLessThan(50);
  });

  it("should produce narrower CI with more paths", () => {
    const base = { currentPrice: 100, targetPrice: 103, impliedVol: 0.35, horizonMs };

    const r1 = runSimulation({ ...base, numPaths: 1_000 });
    const r2 = runSimulation({ ...base, numPaths: 10_000 });
    const r3 = runSimulation({ ...base, numPaths: 40_000 });

    const w1 = r1.confidenceInterval[1] - r1.confidenceInterval[0];
    const w2 = r2.confidenceInterval[1] - r2.confidenceInterval[0];
    const w3 = r3.confidenceInterval[1] - r3.confidenceInterval[0];

    expect(w2).toBeLessThan(w1);
    expect(w3).toBeLessThan(w2);
  });
});
