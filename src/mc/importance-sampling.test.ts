import { describe, expect, it } from "vitest";
import { estimateTailProbability, estimateLossDistribution } from "./importance-sampling";

describe("importance-sampling", () => {
  describe("estimateTailProbability", () => {
    it("estimates loss probability for moderate tail event", () => {
      // Stock at $100, vol 30%, 1 week horizon, P(S <= $95) — 5% drop
      const result = estimateTailProbability({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        threshold: 95,
        direction: "loss",
        numPaths: 50_000,
      });

      // Analytical: Z = (log(95/100) - (-0.3²/2)*(7/365.25)) / (0.3 * sqrt(7/365.25))
      // ≈ (-0.0513 + 0.000863) / 0.04155 ≈ -1.213
      // P(Z <= -1.213) ≈ 0.1125
      expect(result.probability).toBeGreaterThan(0.05);
      expect(result.probability).toBeLessThan(0.25);
      expect(result.confidenceInterval[0]).toBeLessThan(result.probability);
      expect(result.confidenceInterval[1]).toBeGreaterThan(result.probability);
      expect(result.tiltTheta).toBeLessThan(0); // Should tilt left for losses
    });

    it("estimates extreme tail event with high VR", () => {
      // P(S <= $80) — 20% crash in 1 week. Very rare event.
      const result = estimateTailProbability({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        threshold: 80,
        direction: "loss",
        numPaths: 100_000,
      });

      // This is a ~5.4 sigma event — extremely rare
      expect(result.probability).toBeLessThan(0.001);
      expect(result.probability).toBeGreaterThan(0);
      // Should achieve significant variance reduction for extreme tails
      expect(result.varianceReductionFactor).toBeGreaterThan(10);
    });

    it("estimates gain probability", () => {
      // P(S >= $110) — 10% gain in 1 month
      const result = estimateTailProbability({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 30 * 24 * 60 * 60 * 1000,
        threshold: 110,
        direction: "gain",
        numPaths: 50_000,
      });

      expect(result.probability).toBeGreaterThan(0.05);
      expect(result.probability).toBeLessThan(0.5);
      expect(result.tiltTheta).toBeGreaterThan(0); // Should tilt right for gains
    });

    it("handles very short horizons", () => {
      // 1 hour horizon
      const result = estimateTailProbability({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 60 * 60 * 1000,
        threshold: 99,
        direction: "loss",
        numPaths: 10_000,
      });

      expect(result.probability).toBeGreaterThan(0);
      expect(result.probability).toBeLessThan(1);
      expect(result.pathsSimulated).toBeGreaterThan(0);
      expect(result.computeTimeMs).toBeGreaterThan(0);
    });

    it("returns tight confidence intervals with enough paths", () => {
      const result = estimateTailProbability({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 30 * 24 * 60 * 60 * 1000,
        threshold: 90,
        direction: "loss",
        numPaths: 100_000,
      });

      const ciWidth = result.confidenceInterval[1] - result.confidenceInterval[0];
      expect(ciWidth).toBeLessThan(0.05); // CI should be reasonably tight
    });
  });

  describe("estimateLossDistribution", () => {
    it("returns valid percentile losses", () => {
      const result = estimateLossDistribution({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        numPaths: 50_000,
      });

      expect(result.percentileLosses.length).toBe(99);
      // Percentiles should be monotonically non-decreasing
      for (let i = 1; i < 99; i++) {
        expect(result.percentileLosses[i]!).toBeGreaterThanOrEqual(result.percentileLosses[i - 1]!);
      }
      // 1st percentile should be a loss (negative)
      expect(result.percentileLosses[0]!).toBeLessThan(0);
      // 99th percentile should be positive (gain)
      expect(result.percentileLosses[98]!).toBeGreaterThan(result.percentileLosses[0]!);
    });

    it("VaR and CVaR are negative (losses)", () => {
      const result = estimateLossDistribution({
        currentPrice: 100,
        annualizedVol: 0.3,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        confidenceLevel: 0.99,
        numPaths: 50_000,
      });

      expect(result.varAtConfidence).toBeLessThan(0); // VaR should indicate loss
      expect(result.cvarAtConfidence).toBeLessThanOrEqual(result.varAtConfidence); // CVaR >= VaR in magnitude
      expect(result.confidenceLevel).toBe(0.99);
    });

    it("higher vol produces wider loss distribution", () => {
      const lowVol = estimateLossDistribution({
        currentPrice: 100,
        annualizedVol: 0.15,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        numPaths: 50_000,
      });

      const highVol = estimateLossDistribution({
        currentPrice: 100,
        annualizedVol: 0.45,
        horizonMs: 7 * 24 * 60 * 60 * 1000,
        numPaths: 50_000,
      });

      // 1st percentile loss should be worse (more negative) for higher vol
      expect(highVol.percentileLosses[0]!).toBeLessThan(lowVol.percentileLosses[0]!);
    });
  });
});
