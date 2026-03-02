import { describe, expect, it } from "vitest";
import { computeDynamicStop, computePortfolioStops, checkDynamicStop } from "./dynamic-stop-loss";

describe("dynamic-stop-loss", () => {
  it("computes wider stop for higher volatility", () => {
    const lowVol = computeDynamicStop({
      symbol: "AAPL",
      currentPrice: 150,
      annualizedVol: 0.2,
    });

    const highVol = computeDynamicStop({
      symbol: "TSLA",
      currentPrice: 250,
      annualizedVol: 0.6,
    });

    expect(highVol.stopLossPct).toBeGreaterThan(lowVol.stopLossPct);
    expect(lowVol.var99).toBeLessThan(0);
    expect(highVol.var99).toBeLessThan(0);
  });

  it("clamps to min/max bounds", () => {
    // Very low vol should hit min
    const lowVolStop = computeDynamicStop(
      { symbol: "BND", currentPrice: 100, annualizedVol: 0.03 },
      { minStopPct: 2, maxStopPct: 25 },
    );
    expect(lowVolStop.stopLossPct).toBeGreaterThanOrEqual(2);

    // Very high vol should hit max
    const highVolStop = computeDynamicStop(
      { symbol: "UVXY", currentPrice: 50, annualizedVol: 1.5 },
      { maxStopPct: 25 },
    );
    expect(highVolStop.stopLossPct).toBeLessThanOrEqual(25);
  });

  it("portfolio stops compute for multiple positions", () => {
    const result = computePortfolioStops([
      { symbol: "AAPL", currentPrice: 150, annualizedVol: 0.25 },
      { symbol: "GOOGL", currentPrice: 140, annualizedVol: 0.3 },
      { symbol: "TSLA", currentPrice: 250, annualizedVol: 0.55 },
    ]);

    expect(result.stops).toHaveLength(3);
    expect(result.totalComputeTimeMs).toBeGreaterThan(0);
    for (const stop of result.stops) {
      expect(stop.stopLossPct).toBeGreaterThan(0);
      expect(stop.var99).toBeLessThan(0);
    }
  });

  it("checkDynamicStop triggers when PL exceeds stop", () => {
    const stop = computeDynamicStop({
      symbol: "AAPL",
      currentPrice: 150,
      annualizedVol: 0.25,
    });

    // Not triggered at small loss
    expect(checkDynamicStop("AAPL", -1, stop)).toBeNull();

    // Triggered at large loss exceeding dynamic stop
    const reason = checkDynamicStop("AAPL", -(stop.stopLossPct + 1), stop);
    expect(reason).not.toBeNull();
    expect(reason).toContain("MC dynamic stop");
  });
});
