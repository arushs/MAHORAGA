import { describe, expect, it } from "vitest";
import { computeKelly, kellyFromFilterEstimate, batchKelly } from "./kelly";

describe("computeKelly", () => {
  it("computes positive edge correctly", () => {
    const result = computeKelly({
      probProfit: 0.6,
      expectedGainRatio: 0.1,
      expectedLossRatio: 0.05,
      availableCash: 100_000,
      equity: 100_000,
      openPositions: 0,
      maxPositions: 5,
    });
    expect(result.shouldTrade).toBe(true);
    expect(result.rawKellyF).toBeGreaterThan(0);
    expect(result.halfKellyF).toBeCloseTo(result.rawKellyF * 0.5, 10);
    expect(result.notional).toBeGreaterThan(0);
    expect(result.edge).toBeGreaterThan(0);
  });

  it("rejects negative edge", () => {
    const result = computeKelly({
      probProfit: 0.3,
      expectedGainRatio: 0.05,
      expectedLossRatio: 0.05,
      availableCash: 100_000,
      equity: 100_000,
      openPositions: 0,
      maxPositions: 5,
    });
    expect(result.shouldTrade).toBe(false);
    expect(result.rawKellyF).toBeLessThanOrEqual(0);
    expect(result.notional).toBe(0);
  });

  it("rejects low probability", () => {
    const result = computeKelly({
      probProfit: 0.52, // below 0.55 threshold
      expectedGainRatio: 0.2,
      expectedLossRatio: 0.05,
      availableCash: 100_000,
      equity: 100_000,
      openPositions: 0,
      maxPositions: 5,
    });
    expect(result.shouldTrade).toBe(false);
    expect(result.reason).toContain("below threshold");
  });

  it("caps at maxPositionPct", () => {
    const result = computeKelly(
      {
        probProfit: 0.9,
        expectedGainRatio: 0.5,
        expectedLossRatio: 0.1,
        availableCash: 100_000,
        equity: 100_000,
        openPositions: 0,
        maxPositions: 5,
      },
      { maxPositionPct: 0.10 }
    );
    expect(result.shouldTrade).toBe(true);
    expect(result.finalFraction).toBeLessThanOrEqual(0.10);
  });

  it("respects minimum notional", () => {
    const result = computeKelly(
      {
        probProfit: 0.56,
        expectedGainRatio: 0.05,
        expectedLossRatio: 0.04,
        availableCash: 500, // tiny account
        equity: 500,
        openPositions: 0,
        maxPositions: 5,
      },
      { minNotional: 200 }
    );
    // With small cash, notional might be below minimum
    if (result.notional > 0 && result.notional < 200) {
      expect(result.shouldTrade).toBe(false);
    }
  });
});

describe("kellyFromFilterEstimate", () => {
  it("derives gain/loss ratios from prices", () => {
    const result = kellyFromFilterEstimate(
      0.65,    // probProfit
      100,     // currentPrice
      110,     // targetPrice (10% gain)
      95,      // stopLoss (5% loss)
      50_000,  // cash
      50_000,  // equity
      1,       // openPositions
      5        // maxPositions
    );
    expect(result.shouldTrade).toBe(true);
    expect(result.edge).toBeGreaterThan(0);
    expect(result.notional).toBeGreaterThan(0);
    expect(result.notional).toBeLessThan(50_000);
  });
});

describe("batchKelly", () => {
  it("sorts by edge descending", () => {
    const candidates = [
      { symbol: "LOW", probProfit: 0.56, expectedGainRatio: 0.05, expectedLossRatio: 0.05 },
      { symbol: "HIGH", probProfit: 0.75, expectedGainRatio: 0.15, expectedLossRatio: 0.05 },
      { symbol: "MED", probProfit: 0.65, expectedGainRatio: 0.10, expectedLossRatio: 0.05 },
    ];
    const results = batchKelly(candidates, 100_000, 100_000, 0, 5);
    expect(results[0]!.symbol).toBe("HIGH");
    expect(results[results.length - 1]!.symbol).toBe("LOW");
  });
});
