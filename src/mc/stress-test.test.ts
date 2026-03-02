import { describe, expect, it } from "vitest";
import { runStressTest, SCENARIOS } from "./stress-test";
import type { PortfolioPosition } from "./stress-test";

const testPortfolio: PortfolioPosition[] = [
  { symbol: "AAPL", currentPrice: 150, marketValue: 15000, annualizedVol: 0.25, sector: "tech", weight: 0.3 },
  { symbol: "GOOGL", currentPrice: 140, marketValue: 14000, annualizedVol: 0.30, sector: "tech", weight: 0.3 },
  { symbol: "JPM", currentPrice: 180, marketValue: 9000, annualizedVol: 0.22, sector: "finance", weight: 0.2 },
  { symbol: "XOM", currentPrice: 110, marketValue: 5500, annualizedVol: 0.28, sector: "energy", weight: 0.2 },
];

describe("stress-test", () => {
  it("runs all predefined scenarios", () => {
    const result = runStressTest(testPortfolio, { numPaths: 10_000 });

    expect(result.scenarios).toHaveLength(SCENARIOS.length);
    expect(result.worstScenario).toBeTruthy();
    expect(result.maxPortfolioLossPct).toBeLessThan(0);
    expect(result.timestamp).toBeTruthy();
  });

  it("flash crash produces worst losses", () => {
    const result = runStressTest(testPortfolio, { numPaths: 10_000 });
    
    const flashCrash = result.scenarios.find(s => s.scenario.name === "flash_crash");
    const sectorRotation = result.scenarios.find(s => s.scenario.name === "sector_rotation");

    expect(flashCrash).toBeDefined();
    expect(sectorRotation).toBeDefined();
    // Flash crash should generally produce larger expected losses than mild sector rotation
    expect(flashCrash!.expectedLossPct).toBeLessThan(sectorRotation!.expectedLossPct);
  });

  it("each scenario has valid per-position losses", () => {
    const result = runStressTest(testPortfolio, { numPaths: 10_000 });

    for (const scenario of result.scenarios) {
      expect(scenario.positionLosses).toHaveLength(testPortfolio.length);
      for (const pl of scenario.positionLosses) {
        expect(pl.lossPct).toBeLessThan(0); // Under stress, all positions should show losses at 99th pct
      }
      expect(scenario.probExceedingThreshold).toBeGreaterThanOrEqual(0);
      expect(scenario.probExceedingThreshold).toBeLessThanOrEqual(1);
      expect(scenario.computeTimeMs).toBeGreaterThan(0);
    }
  });

  it("handles empty portfolio", () => {
    const result = runStressTest([]);
    expect(result.scenarios).toHaveLength(0);
    expect(result.worstScenario).toBe("none");
    expect(result.maxPortfolioLossPct).toBe(0);
  });

  it("supports custom scenarios", () => {
    const result = runStressTest(testPortfolio, {
      numPaths: 5_000,
      scenarios: [{
        name: "custom",
        description: "Custom test scenario",
        volMultiplier: 2.0,
        driftShock: -0.5,
        correlationBoost: 0.5,
        horizonMs: 24 * 60 * 60 * 1000,
        lossThresholdPct: -8,
      }],
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]!.scenario.name).toBe("custom");
  });
});
