/**
 * Variance reduction verification tests.
 *
 * Validates accuracy (vs BS analytic) and measures VR empirically.
 */

import { describe, expect, it } from "vitest";
import { runSimulation, bsDigitalProb } from "./simulator";

/** Crude MC with Math.random — no VR, for comparison. */
function crudeMonteCarloProb(
  S0: number, K: number, vol: number, T: number, N: number,
): number {
  const drift = -0.5 * vol * vol * T;
  const volSqrtT = vol * Math.sqrt(T);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ST = S0 * Math.exp(drift + volSqrtT * z);
    if (ST >= K) sum++;
  }
  return sum / N;
}

describe("MC Simulator", () => {
  const horizonMs = 7 * 24 * 3600_000; // 1 week

  it("should match BS analytic probability within tight tolerance", () => {
    const T = horizonMs / (365.25 * 24 * 3600_000);
    const cases = [
      { S: 100, K: 102, vol: 0.3 },  // slightly OTM
      { S: 100, K: 98, vol: 0.3 },   // slightly ITM
      { S: 100, K: 100, vol: 0.3 },  // ATM
      { S: 50, K: 55, vol: 0.5 },    // OTM high vol
      { S: 200, K: 190, vol: 0.2 },  // ITM low vol
    ];

    for (const { S, K, vol } of cases) {
      const analytic = bsDigitalProb(S, K, vol, T);
      const result = runSimulation({
        currentPrice: S, targetPrice: K, impliedVol: vol,
        horizonMs, numPaths: 40_000,
      });
      const error = Math.abs(result.probability - analytic);
      console.log(`S=${S} K=${K} σ=${vol} | BS=${analytic.toFixed(4)} MC=${result.probability.toFixed(4)} err=${(error * 100).toFixed(2)}%`);
      expect(error).toBeLessThan(0.01); // <1% absolute error with 40K paths
      expect(result.pathsSimulated).toBeGreaterThan(0);
    }
  });

  it("should achieve meaningful variance reduction vs crude MC", () => {
    const S = 100, K = 102, vol = 0.3;
    const N = 10_000;
    const T = horizonMs / (365.25 * 24 * 3600_000);

    // Empirical: run crude MC 200 times, measure sample variance
    const crudeTrials = 200;
    const crudeResults: number[] = [];
    for (let t = 0; t < crudeTrials; t++) {
      crudeResults.push(crudeMonteCarloProb(S, K, vol, T, N));
    }
    const crudeMean = crudeResults.reduce((a, b) => a + b, 0) / crudeTrials;
    const crudeVar = crudeResults.reduce((a, b) => a + (b - crudeMean) ** 2, 0) / (crudeTrials - 1);
    const crudeSE = Math.sqrt(crudeVar);

    // VR simulator — deterministic, so run at multiple nearby path counts for empirical variance
    const vrTrials: number[] = [];
    for (let offset = 0; offset < 200; offset++) {
      const result = runSimulation({
        currentPrice: S, targetPrice: K, impliedVol: vol,
        horizonMs, numPaths: N + offset * 4,
      });
      vrTrials.push(result.probability);
    }
    const vrMean = vrTrials.reduce((a, b) => a + b, 0) / vrTrials.length;
    const vrVar = vrTrials.reduce((a, b) => a + (b - vrMean) ** 2, 0) / (vrTrials.length - 1);
    const vrSE = Math.sqrt(vrVar);

    const vrRatio = crudeSE / Math.max(vrSE, 1e-10);
    console.log(`Crude SE: ${(crudeSE * 100).toFixed(3)}%`);
    console.log(`VR SE: ${(vrSE * 100).toFixed(3)}%`);
    console.log(`Empirical VR ratio: ${vrRatio.toFixed(1)}x`);

    // With Halton + antithetic + CV, expect at least 3x
    expect(vrRatio).toBeGreaterThan(2);
  });

  it("should handle degenerate inputs gracefully", () => {
    const r1 = runSimulation({ currentPrice: 100, impliedVol: 0.3, horizonMs });
    expect(r1.pathsSimulated).toBe(0);
    expect(r1.probability).toBe(0.5);

    const r2 = runSimulation({ currentPrice: 100, impliedVol: 0, horizonMs, targetPrice: 95 });
    expect(r2.pathsSimulated).toBe(0);

    const r3 = runSimulation({ currentPrice: 100, impliedVol: 0.3, horizonMs: 0, targetPrice: 95 });
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
    const w = (r: typeof r1) => r.confidenceInterval[1] - r.confidenceInterval[0];
    expect(w(r2)).toBeLessThan(w(r1));
    expect(w(r3)).toBeLessThan(w(r2));
  });

  it("should report VR diagnostics for various moneyness levels", () => {
    const T = horizonMs / (365.25 * 24 * 3600_000);
    const N = 10_000;
    const cases = [
      { label: "deep ITM", S: 100, K: 90, vol: 0.3 },
      { label: "ATM", S: 100, K: 100, vol: 0.3 },
      { label: "OTM", S: 100, K: 105, vol: 0.3 },
      { label: "deep OTM", S: 100, K: 115, vol: 0.3 },
      { label: "high vol ATM", S: 100, K: 100, vol: 0.6 },
    ];

    for (const { label, S, K, vol } of cases) {
      const analytic = bsDigitalProb(S, K, vol, T);
      const result = runSimulation({
        currentPrice: S, targetPrice: K, impliedVol: vol, horizonMs, numPaths: N,
      });
      const ciWidth = result.confidenceInterval[1] - result.confidenceInterval[0];
      // Theoretical crude MC CI width
      const crudeCI = 2 * 1.96 * Math.sqrt(analytic * (1 - analytic) / N);
      const vrRatio = crudeCI / Math.max(ciWidth, 1e-10);
      console.log(`${label}: BS=${analytic.toFixed(4)} MC=${result.probability.toFixed(4)} CI±${(ciWidth/2*100).toFixed(2)}% crudeCI±${(crudeCI/2*100).toFixed(2)}% VR=${vrRatio.toFixed(1)}x (${result.computeTimeMs.toFixed(1)}ms)`);
    }
  });
});
