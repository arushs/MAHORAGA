import { describe, expect, it } from "vitest";
import { cholesky, simulateCopula, simulateCopulaFlat } from "./copula";
import type { CorrelationMatrix } from "./correlation";

describe("cholesky", () => {
  it("decomposes 2x2 identity", () => {
    const L = cholesky([1, 0, 0, 1], 2);
    expect(L[0]).toBeCloseTo(1);
    expect(L[1]).toBeCloseTo(0);
    expect(L[2]).toBeCloseTo(0);
    expect(L[3]).toBeCloseTo(1);
  });

  it("decomposes correlated 2x2", () => {
    const rho = 0.6;
    const L = cholesky([1, rho, rho, 1], 2);
    expect(L[0]! * L[0]!).toBeCloseTo(1, 5);
    expect(L[2]! * L[0]!).toBeCloseTo(rho, 5);
    expect(L[2]! * L[2]! + L[3]! * L[3]!).toBeCloseTo(1, 5);
  });

  it("handles non-PD matrix via regularization", () => {
    // Slightly non-PD
    const L = cholesky([1, 1.01, 1.01, 1], 2);
    expect(L).toHaveLength(4);
    // Should not throw, regularization kicks in
  });
});

describe("simulateCopula", () => {
  it("generates correct number of scenarios", () => {
    const matrix: CorrelationMatrix = {
      symbols: ["A", "B"],
      values: [1, 0.5, 0.5, 1],
      observationCount: 20,
      updatedAt: Date.now(),
    };
    const result = simulateCopula(
      matrix,
      { vols: [0.3, 0.25], numScenarios: 1000, degreesOfFreedom: 5 },
      42
    );
    expect(result.scenarios).toHaveLength(1000);
    expect(result.scenarios[0]).toHaveLength(2);
    expect(result.symbols).toEqual(["A", "B"]);
    expect(result.degreesOfFreedom).toBe(5);
  });

  it("produces correlated returns", () => {
    const matrix: CorrelationMatrix = {
      symbols: ["A", "B"],
      values: [1, 0.9, 0.9, 1],
      observationCount: 20,
      updatedAt: Date.now(),
    };
    const result = simulateCopula(
      matrix,
      { vols: [0.3, 0.3], numScenarios: 10_000 },
      123
    );

    // Compute empirical correlation
    const a = result.scenarios.map((s) => s[0]!);
    const b = result.scenarios.map((s) => s[1]!);
    const meanA = a.reduce((s, v) => s + v, 0) / a.length;
    const meanB = b.reduce((s, v) => s + v, 0) / b.length;
    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < a.length; i++) {
      cov += (a[i]! - meanA) * (b[i]! - meanB);
      varA += (a[i]! - meanA) ** 2;
      varB += (b[i]! - meanB) ** 2;
    }
    const empiricalCorr = cov / Math.sqrt(varA * varB);

    // Should be close to 0.9 (within MC noise)
    expect(empiricalCorr).toBeGreaterThan(0.7);
    expect(empiricalCorr).toBeLessThan(1.0);
  });

  it("rejects invalid asset count", () => {
    const matrix: CorrelationMatrix = {
      symbols: ["A"],
      values: [1],
      observationCount: 20,
      updatedAt: Date.now(),
    };
    expect(() =>
      simulateCopula(matrix, { vols: [0.3], numScenarios: 100 })
    ).toThrow(/2-8 assets/);
  });
});

describe("simulateCopulaFlat", () => {
  it("works with flat correlation", () => {
    const result = simulateCopulaFlat(
      ["A", "B", "C"],
      [0.3, 0.25, 0.35],
      0.5,
      { numScenarios: 500 },
      99
    );
    expect(result.scenarios).toHaveLength(500);
    expect(result.scenarios[0]).toHaveLength(3);
  });
});
