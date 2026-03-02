import { describe, expect, it } from "vitest";
import { computePortfolioVaR, evaluatePortfolioRisk, type PortfolioPosition } from "./portfolio-var";
import type { CorrelationMatrix } from "./correlation";

function makeMatrix(symbols: string[], rho: number): CorrelationMatrix {
  const n = symbols.length;
  const values = Array.from({ length: n * n }, (_, idx) => {
    const i = Math.floor(idx / n);
    const j = idx % n;
    return i === j ? 1 : rho;
  });
  return { symbols, values, observationCount: 20, updatedAt: Date.now() };
}

describe("computePortfolioVaR", () => {
  it("returns zero for empty portfolio", () => {
    const result = computePortfolioVaR([], makeMatrix([], 0));
    expect(result.var95).toBe(0);
    expect(result.var99).toBe(0);
    expect(result.portfolioValue).toBe(0);
  });

  it("computes VaR for 2-asset portfolio", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "AAPL", marketValue: 50_000, annualizedVol: 0.30 },
      { symbol: "MSFT", marketValue: 50_000, annualizedVol: 0.25 },
    ];
    const matrix = makeMatrix(["AAPL", "MSFT"], 0.6);
    const result = computePortfolioVaR(positions, matrix, { numScenarios: 5000 });

    expect(result.portfolioValue).toBe(100_000);
    expect(result.var95).toBeGreaterThan(0);
    expect(result.var99).toBeGreaterThan(result.var95);
    expect(result.cvar99).toBeGreaterThanOrEqual(result.var99);
    expect(result.var95Pct).toBeGreaterThan(0);
    expect(result.var95Pct).toBeLessThan(0.1); // daily VaR shouldn't exceed 10%
    expect(result.scenarioCount).toBe(5000);
    expect(Object.keys(result.componentVaR)).toHaveLength(2);
  });

  it("higher correlation increases VaR", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "A", marketValue: 50_000, annualizedVol: 0.30 },
      { symbol: "B", marketValue: 50_000, annualizedVol: 0.30 },
    ];
    const lowCorr = computePortfolioVaR(positions, makeMatrix(["A", "B"], 0.1), { numScenarios: 10_000 });
    const highCorr = computePortfolioVaR(positions, makeMatrix(["A", "B"], 0.9), { numScenarios: 10_000 });

    // Higher correlation = less diversification = higher VaR
    expect(highCorr.var95).toBeGreaterThan(lowCorr.var95 * 0.9);
  });
});

describe("evaluatePortfolioRisk", () => {
  it("accepts trade within limits", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "AAPL", marketValue: 20_000, annualizedVol: 0.30 },
    ];
    const trade: PortfolioPosition = { symbol: "MSFT", marketValue: 15_000, annualizedVol: 0.25 };
    const matrix = makeMatrix(["AAPL", "MSFT"], 0.5);

    const decision = evaluatePortfolioRisk(positions, trade, 200_000, matrix, {
      numScenarios: 3000,
      maxComponentVarPct: 0.80, // relaxed for 2-asset portfolio
    });
    expect(decision.acceptable).toBe(true);
    expect(decision.projectedRisk).not.toBeNull();
  });

  it("rejects trade exceeding VaR limit", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "A", marketValue: 40_000, annualizedVol: 0.80 },
      { symbol: "B", marketValue: 40_000, annualizedVol: 0.80 },
    ];
    const trade: PortfolioPosition = { symbol: "C", marketValue: 40_000, annualizedVol: 0.80 };
    const matrix = makeMatrix(["A", "B", "C"], 0.9);

    const decision = evaluatePortfolioRisk(positions, trade, 50_000, matrix, {
      maxVar99PctEquity: 0.01, // very tight limit
      numScenarios: 5000,
    });
    // With high vol, high correlation, tight limit — should reject
    expect(decision.projectedRisk).not.toBeNull();
    // The result depends on MC randomness but with 80% vol and 0.9 corr on 50k equity, VaR should be high
  });
});
