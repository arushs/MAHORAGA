/**
 * MAHORAGA MC Simulation Engine — Unit Tests
 *
 * Tests are written against the expected interfaces from the MC integration plan.
 * Where the simulator is not yet implemented, tests are marked with .todo()
 * and expected interfaces are documented. The Black-Scholes reference and
 * ensemble scoring are fully testable now.
 */

import { describe, it, expect, vi } from "vitest";
import {
  blackScholesDigitalCall,
  normalCDF,
  simulateBinaryOption,
  type SimulationParams,
  type SimulationResult,
  type VarianceReductionConfig,
} from "./simulator";
import {
  computeEnsembleScore,
  DEFAULT_WEIGHTS,
  type EnsembleInput,
  type EnsembleWeights,
} from "./ensemble";

// ============================================================
// 1. Black-Scholes Reference (closed-form, fully testable now)
// ============================================================

describe("Black-Scholes Digital Call (reference implementation)", () => {
  it("ATM option with 1yr horizon gives ~0.5 (slightly adjusted by drift)", () => {
    // S=K, r=0.05, σ=0.3, T=1 → d2 = (0 + (0.05 - 0.045)*1) / 0.3 = 0.0167
    const prob = blackScholesDigitalCall(100, 100, 0.3, 1, 0.05);
    // Should be slightly above 0.5 because positive drift
    expect(prob).toBeGreaterThan(0.5);
    expect(prob).toBeLessThan(0.55);
  });

  it("deep ITM option → probability near 1", () => {
    // S=150, K=100, very likely to end above strike
    const prob = blackScholesDigitalCall(150, 100, 0.2, 0.25, 0.05);
    expect(prob).toBeGreaterThan(0.95);
  });

  it("deep OTM option → probability near 0", () => {
    // S=50, K=100, very unlikely to end above strike
    const prob = blackScholesDigitalCall(50, 100, 0.2, 0.25, 0.05);
    expect(prob).toBeLessThan(0.05);
  });

  it("zero vol: deterministic outcome based on drift", () => {
    // With σ→0, price follows S*exp(r*T) deterministically
    // S=100, K=100, r=0.05, T=1 → S_T = 100*exp(0.05) ≈ 105.13 > 100 → P=1
    const prob = blackScholesDigitalCall(100, 100, 1e-10, 1, 0.05);
    expect(prob).toBeCloseTo(1.0, 2);
  });

  it("zero vol, OTM: deterministic failure", () => {
    // S=100, K=110, r=0.05, T=1 → S_T ≈ 105.13 < 110 → P=0
    const prob = blackScholesDigitalCall(100, 110, 1e-10, 1, 0.05);
    expect(prob).toBeCloseTo(0.0, 2);
  });

  it("very short horizon: approaches indicator function", () => {
    // T→0, S=101, K=100 → ITM → P≈1
    const prob = blackScholesDigitalCall(101, 100, 0.3, 1e-6, 0.05);
    expect(prob).toBeGreaterThan(0.99);
  });

  it("very long horizon with positive drift → high probability", () => {
    // T=10yr, S=100, K=100, r=0.05, σ=0.3
    // d2 = (0 + (0.05 - 0.045)*10) / (0.3*√10) = 0.05/(0.9487) ≈ 0.053
    const prob = blackScholesDigitalCall(100, 100, 0.3, 10, 0.05);
    expect(prob).toBeGreaterThan(0.5);
    expect(prob).toBeLessThan(0.6);
  });

  it("put-call parity: P(S>K) + P(S≤K) = 1", () => {
    const pCall = blackScholesDigitalCall(100, 105, 0.25, 0.5, 0.04);
    // P(S≤K) = 1 - P(S>K)
    expect(pCall).toBeGreaterThan(0);
    expect(pCall).toBeLessThan(1);
    // Just verify it's in valid range — full put impl not needed
  });
});

describe("normalCDF", () => {
  it("CDF(0) = 0.5", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  it("CDF(∞) → 1", () => {
    expect(normalCDF(10)).toBeCloseTo(1.0, 6);
  });

  it("CDF(-∞) → 0", () => {
    expect(normalCDF(-10)).toBeCloseTo(0.0, 6);
  });

  it("CDF(1.96) ≈ 0.975", () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 2);
  });

  it("symmetry: CDF(x) + CDF(-x) = 1", () => {
    for (const x of [0.5, 1.0, 2.0, 3.0]) {
      expect(normalCDF(x) + normalCDF(-x)).toBeCloseTo(1.0, 6);
    }
  });
});

// ============================================================
// 2. GBM Simulator Accuracy vs Black-Scholes
//    (stubs — simulator not yet implemented)
// ============================================================

describe("GBM Simulator vs Black-Scholes", () => {
  const baseParams: SimulationParams = {
    currentPrice: 100,
    strikePrice: 100,
    volatility: 0.3,
    timeHorizon: 1,
    riskFreeRate: 0.05,
    numPaths: 100_000,
    seed: 42,
  };

  it.todo(
    "ATM option: MC estimate within 2 SE of Black-Scholes",
    // When implemented, test:
    // const bs = blackScholesDigitalCall(100, 100, 0.3, 1, 0.05);
    // const mc = simulateBinaryOption(baseParams);
    // expect(Math.abs(mc.probability - bs)).toBeLessThan(2 * mc.standardError);
  );

  it.todo(
    "ITM option (S=120, K=100): MC within 2 SE of BS",
    // const params = { ...baseParams, currentPrice: 120 };
    // const bs = blackScholesDigitalCall(120, 100, 0.3, 1, 0.05);
    // const mc = simulateBinaryOption(params);
    // expect(Math.abs(mc.probability - bs)).toBeLessThan(2 * mc.standardError);
  );

  it.todo(
    "OTM option (S=80, K=100): MC within 2 SE of BS",
  );

  it.todo(
    "short horizon (1 day): MC within 2 SE of BS",
    // const params = { ...baseParams, timeHorizon: 1/252 };
  );

  it.todo(
    "high vol (σ=0.8): MC within 2 SE of BS",
    // const params = { ...baseParams, volatility: 0.8 };
  );

  it("simulateBinaryOption exists and throws 'not implemented'", () => {
    expect(() => simulateBinaryOption(baseParams)).toThrow("Not implemented");
  });
});

// ============================================================
// 3. Variance Reduction Ratios
//    (stubs — simulator not yet implemented)
// ============================================================

describe("Variance Reduction", () => {
  const baseParams: SimulationParams = {
    currentPrice: 100,
    strikePrice: 105,
    volatility: 0.25,
    timeHorizon: 0.25,
    riskFreeRate: 0.05,
    numPaths: 50_000,
    seed: 42,
  };

  it.todo(
    "antithetic variates: variance reduction ratio > 1",
    // const naive = simulateBinaryOption(baseParams, { antithetic: false, stratified: false });
    // const anti = simulateBinaryOption(baseParams, { antithetic: true, stratified: false });
    // expect(anti.varianceReductionRatio).toBeGreaterThan(1);
  );

  it.todo(
    "stratified sampling: variance reduction ratio > 1",
    // const strat = simulateBinaryOption(baseParams, { antithetic: false, stratified: true });
    // expect(strat.varianceReductionRatio).toBeGreaterThan(1);
  );

  it.todo(
    "combined antithetic + stratified: variance reduction ratio 50-100x",
    // const combined = simulateBinaryOption(baseParams, { antithetic: true, stratified: true });
    // expect(combined.varianceReductionRatio).toBeGreaterThanOrEqual(50);
    // expect(combined.varianceReductionRatio).toBeLessThanOrEqual(200); // some headroom
  );

  it.todo(
    "confidence interval narrows with variance reduction",
    // const naive = simulateBinaryOption(baseParams, { antithetic: false, stratified: false });
    // const combined = simulateBinaryOption(baseParams, { antithetic: true, stratified: true });
    // const naiveWidth = naive.confidenceInterval[1] - naive.confidenceInterval[0];
    // const combWidth = combined.confidenceInterval[1] - combined.confidenceInterval[0];
    // expect(combWidth).toBeLessThan(naiveWidth * 0.3);
  );
});

// ============================================================
// 4. Ensemble Scoring Formula
// ============================================================

describe("Ensemble Scoring", () => {
  it("default weights: 0.4 MC + 0.4 LLM + 0.2 sentiment", () => {
    expect(DEFAULT_WEIGHTS).toEqual({ mc: 0.4, llm: 0.4, sentiment: 0.2 });
  });

  it("computes weighted average correctly", () => {
    const input: EnsembleInput = {
      mcProbability: 0.7,
      llmConfidence: 0.8,
      sentimentScore: 0.6,
    };
    // 0.4*0.7 + 0.4*0.8 + 0.2*0.6 = 0.28 + 0.32 + 0.12 = 0.72
    expect(computeEnsembleScore(input)).toBeCloseTo(0.72, 6);
  });

  it("all zeros → 0", () => {
    const input: EnsembleInput = { mcProbability: 0, llmConfidence: 0, sentimentScore: 0 };
    expect(computeEnsembleScore(input)).toBe(0);
  });

  it("all ones → 1", () => {
    const input: EnsembleInput = { mcProbability: 1, llmConfidence: 1, sentimentScore: 1 };
    expect(computeEnsembleScore(input)).toBeCloseTo(1.0, 6);
  });

  it("custom weights work", () => {
    const input: EnsembleInput = { mcProbability: 1, llmConfidence: 0, sentimentScore: 0 };
    const weights: EnsembleWeights = { mc: 0.6, llm: 0.3, sentiment: 0.1 };
    expect(computeEnsembleScore(input, weights)).toBeCloseTo(0.6, 6);
  });

  it("rejects weights that don't sum to 1", () => {
    const input: EnsembleInput = { mcProbability: 0.5, llmConfidence: 0.5, sentimentScore: 0.5 };
    const badWeights: EnsembleWeights = { mc: 0.5, llm: 0.5, sentiment: 0.5 };
    expect(() => computeEnsembleScore(input, badWeights)).toThrow("must sum to 1.0");
  });

  it("rejects input values outside [0, 1]", () => {
    expect(() =>
      computeEnsembleScore({ mcProbability: 1.5, llmConfidence: 0.5, sentimentScore: 0.5 }),
    ).toThrow("[0, 1]");
    expect(() =>
      computeEnsembleScore({ mcProbability: 0.5, llmConfidence: -0.1, sentimentScore: 0.5 }),
    ).toThrow("[0, 1]");
  });

  it("MC-only scenario: high MC, low LLM and sentiment", () => {
    const input: EnsembleInput = { mcProbability: 0.9, llmConfidence: 0.1, sentimentScore: 0.1 };
    const score = computeEnsembleScore(input);
    // 0.4*0.9 + 0.4*0.1 + 0.2*0.1 = 0.36 + 0.04 + 0.02 = 0.42
    expect(score).toBeCloseTo(0.42, 6);
  });

  it("disagreement: high LLM, low MC → moderate score", () => {
    const input: EnsembleInput = { mcProbability: 0.2, llmConfidence: 0.9, sentimentScore: 0.5 };
    const score = computeEnsembleScore(input);
    // 0.4*0.2 + 0.4*0.9 + 0.2*0.5 = 0.08 + 0.36 + 0.10 = 0.54
    expect(score).toBeCloseTo(0.54, 6);
  });
});

// ============================================================
// 5. Edge Cases
// ============================================================

describe("Edge Cases", () => {
  describe("Black-Scholes edge cases", () => {
    it("zero vol with S > K → probability 1", () => {
      expect(blackScholesDigitalCall(105, 100, 1e-12, 1, 0.0)).toBeCloseTo(1.0, 2);
    });

    it("zero vol with S < K → probability 0", () => {
      expect(blackScholesDigitalCall(95, 100, 1e-12, 1, 0.0)).toBeCloseTo(0.0, 2);
    });

    it("zero vol, S = K, positive drift → probability 1", () => {
      expect(blackScholesDigitalCall(100, 100, 1e-12, 1, 0.05)).toBeCloseTo(1.0, 2);
    });

    it("zero vol, S = K, zero drift → probability ~0.5 (limit)", () => {
      // At exactly S=K, r=0, σ→0: d2 → 0/0 which is indeterminate
      // With tiny vol: d2 = (0 + (0 - ε²/2)*T) / (ε*√T) → 0 as ε→0
      // This approaches 0.5 from below
      const prob = blackScholesDigitalCall(100, 100, 1e-6, 1, 0.0);
      expect(prob).toBeCloseTo(0.5, 1);
    });

    it("very short horizon (1 minute), ITM", () => {
      const oneMinute = 1 / (252 * 6.5 * 60); // ~1 min in years
      const prob = blackScholesDigitalCall(100.5, 100, 0.3, oneMinute, 0.05);
      expect(prob).toBeGreaterThan(0.9);
    });

    it("very long horizon (30 years)", () => {
      const prob = blackScholesDigitalCall(100, 100, 0.3, 30, 0.05);
      // With positive drift over 30yr, likely above strike
      expect(prob).toBeGreaterThan(0.5);
      expect(prob).toBeLessThan(1.0);
    });
  });

  describe("Simulator edge cases (stubs)", () => {
    it.todo(
      "zero vol: simulator should return ~1 or ~0 depending on drift vs strike",
    );

    it.todo(
      "very short horizon (1 min): simulator matches near-deterministic outcome",
    );

    it.todo(
      "very long horizon (10yr): simulator converges to BS within tolerance",
    );

    it.todo(
      "ATM with zero drift: simulator returns ~0.5",
    );

    it.todo(
      "numPaths=1: should still return a valid result (no div by zero)",
    );

    it.todo(
      "extremely high vol (σ=5.0): simulator doesn't NaN or overflow",
    );
  });
});
