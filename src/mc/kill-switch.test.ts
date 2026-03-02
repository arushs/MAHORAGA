import { describe, expect, it } from "vitest";
import { evaluateKillSwitch, type KillSwitchPosition } from "./kill-switch";

const calmPortfolio: KillSwitchPosition[] = [
  { symbol: "AAPL", currentPrice: 150, marketValue: 15000, annualizedVol: 0.2, weight: 0.3 },
  { symbol: "MSFT", currentPrice: 400, marketValue: 12000, annualizedVol: 0.22, weight: 0.3 },
  { symbol: "JNJ", currentPrice: 160, marketValue: 8000, annualizedVol: 0.15, weight: 0.2 },
  { symbol: "PG", currentPrice: 155, marketValue: 7000, annualizedVol: 0.14, weight: 0.2 },
];

const wildPortfolio: KillSwitchPosition[] = [
  { symbol: "TSLA", currentPrice: 250, marketValue: 25000, annualizedVol: 0.65, weight: 0.4 },
  { symbol: "NVDA", currentPrice: 800, marketValue: 24000, annualizedVol: 0.55, weight: 0.3 },
  { symbol: "MSTR", currentPrice: 1500, marketValue: 15000, annualizedVol: 0.90, weight: 0.3 },
];

describe("kill-switch", () => {
  it("returns 'none' for calm, diversified portfolio over 1 day", () => {
    const result = evaluateKillSwitch(calmPortfolio, {
      horizonMs: 24 * 60 * 60 * 1000,
      numPaths: 30_000,
    });

    // A calm portfolio over 1 day shouldn't trigger kill switch
    expect(result.action).toBe("none");
    expect(result.probLoss25Pct).toBeLessThan(0.01);
    expect(result.portfolioVol).toBeGreaterThan(0);
  });

  it("triggers for high-vol portfolio over longer horizon", () => {
    const result = evaluateKillSwitch(wildPortfolio, {
      horizonMs: 30 * 24 * 60 * 60 * 1000, // 1 month
      numPaths: 50_000,
      minProbabilityTrigger: 0.005,
    });

    // High vol portfolio over 1 month — should likely trigger something
    expect(["reduce_50", "full_kill"]).toContain(result.action);
    expect(result.probLoss15Pct).toBeGreaterThan(0);
  });

  it("handles empty portfolio", () => {
    const result = evaluateKillSwitch([]);
    expect(result.action).toBe("none");
    expect(result.reason).toBe("No positions");
    expect(result.portfolioVol).toBe(0);
  });

  it("single position portfolio works", () => {
    const result = evaluateKillSwitch([
      { symbol: "SPY", currentPrice: 500, marketValue: 50000, annualizedVol: 0.18, weight: 1.0 },
    ], { numPaths: 20_000 });

    expect(result.portfolioVol).toBeCloseTo(0.18, 1);
    expect(result.computeTimeMs).toBeGreaterThan(0);
    expect(result.probLoss15Pct).toBeGreaterThanOrEqual(0);
    expect(result.probLoss25Pct).toBeGreaterThanOrEqual(0);
  });

  it("higher minProbabilityTrigger makes kill switch less sensitive", () => {
    const sensitive = evaluateKillSwitch(wildPortfolio, {
      horizonMs: 14 * 24 * 60 * 60 * 1000,
      numPaths: 20_000,
      minProbabilityTrigger: 0.001,
    });

    const insensitive = evaluateKillSwitch(wildPortfolio, {
      horizonMs: 14 * 24 * 60 * 60 * 1000,
      numPaths: 20_000,
      minProbabilityTrigger: 0.5,
    });

    // More sensitive trigger should be more likely to act
    const actionRank = { none: 0, reduce_50: 1, full_kill: 2 };
    expect(actionRank[sensitive.action]).toBeGreaterThanOrEqual(actionRank[insensitive.action]);
  });

  it("returns valid confidence intervals", () => {
    const result = evaluateKillSwitch(calmPortfolio, { numPaths: 30_000 });

    expect(result.ciLoss15Pct[0]).toBeLessThanOrEqual(result.probLoss15Pct);
    expect(result.ciLoss15Pct[1]).toBeGreaterThanOrEqual(result.probLoss15Pct);
    expect(result.ciLoss25Pct[0]).toBeLessThanOrEqual(result.probLoss25Pct);
    expect(result.ciLoss25Pct[1]).toBeGreaterThanOrEqual(result.probLoss25Pct);
  });
});
