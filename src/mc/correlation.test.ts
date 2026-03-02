import { describe, expect, it } from "vitest";
import {
  weightedCorrelation,
  barsToLogReturns,
  computeCorrelationMatrix,
  createEmptyCorrelationState,
  updateCorrelationState,
  getPairwiseCorrelation,
  extractSubMatrix,
  type ReturnSeries,
} from "./correlation";

describe("weightedCorrelation", () => {
  it("returns 1 for perfectly correlated series", () => {
    const x = [0.01, 0.02, -0.01, 0.03, 0.01];
    const w = [0.2, 0.2, 0.2, 0.2, 0.2];
    expect(weightedCorrelation(x, x, w)).toBeCloseTo(1, 5);
  });

  it("returns -1 for perfectly anti-correlated series", () => {
    const x = [0.01, 0.02, -0.01, 0.03, 0.01];
    const y = x.map((v) => -v);
    const w = [0.2, 0.2, 0.2, 0.2, 0.2];
    expect(weightedCorrelation(x, y, w)).toBeCloseTo(-1, 5);
  });

  it("returns NaN for insufficient data", () => {
    expect(weightedCorrelation([1], [2], [1])).toBeNaN();
  });
});

describe("barsToLogReturns", () => {
  it("computes log returns from bars", () => {
    const bars = [
      { t: "2024-01-01", o: 100, h: 105, l: 99, c: 100, v: 1000, n: 10, vw: 101 },
      { t: "2024-01-02", o: 100, h: 110, l: 98, c: 105, v: 1200, n: 12, vw: 104 },
      { t: "2024-01-03", o: 105, h: 112, l: 104, c: 110, v: 1100, n: 11, vw: 108 },
    ];
    const { returns, dates } = barsToLogReturns(bars);
    expect(returns).toHaveLength(2);
    expect(dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(returns[0]).toBeCloseTo(Math.log(105 / 100), 10);
    expect(returns[1]).toBeCloseTo(Math.log(110 / 105), 10);
  });

  it("returns empty for single bar", () => {
    const { returns } = barsToLogReturns([
      { t: "2024-01-01", o: 100, h: 100, l: 100, c: 100, v: 100, n: 1, vw: 100 },
    ]);
    expect(returns).toHaveLength(0);
  });
});

describe("computeCorrelationMatrix", () => {
  it("returns identity for single asset", () => {
    const series: ReturnSeries[] = [
      { symbol: "AAPL", returns: [0.01, -0.02, 0.03], dates: ["d1", "d2", "d3"] },
    ];
    const m = computeCorrelationMatrix(series);
    expect(m.symbols).toEqual(["AAPL"]);
    expect(m.values).toEqual([1]);
  });

  it("computes 2x2 symmetric matrix", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const r1 = dates.map((_, i) => Math.sin(i * 0.5) * 0.02);
    const r2 = dates.map((_, i) => Math.sin(i * 0.5 + 0.1) * 0.02); // highly correlated

    const series: ReturnSeries[] = [
      { symbol: "AAPL", returns: r1, dates },
      { symbol: "MSFT", returns: r2, dates },
    ];
    const m = computeCorrelationMatrix(series);
    expect(m.symbols).toHaveLength(2);
    expect(m.values[0]).toBe(1); // AAPL-AAPL
    expect(m.values[3]).toBe(1); // MSFT-MSFT
    expect(m.values[1]!).toBeCloseTo(m.values[2]!, 10); // symmetric
    expect(m.values[1]!).toBeGreaterThan(0.9); // highly correlated
  });
});

describe("getPairwiseCorrelation", () => {
  it("returns 0 for unknown symbols", () => {
    const m = computeCorrelationMatrix([
      { symbol: "A", returns: [0.01, 0.02, 0.03], dates: ["d1", "d2", "d3"] },
    ]);
    expect(getPairwiseCorrelation(m, "A", "B")).toBe(0);
  });
});

describe("extractSubMatrix", () => {
  it("extracts correct sub-matrix", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const series: ReturnSeries[] = [
      { symbol: "A", returns: dates.map(() => 0.01), dates },
      { symbol: "B", returns: dates.map(() => 0.02), dates },
      { symbol: "C", returns: dates.map(() => -0.01), dates },
    ];
    const full = computeCorrelationMatrix(series);
    const sub = extractSubMatrix(full, ["A", "C"]);
    expect(sub.symbols).toEqual(["A", "C"]);
    expect(sub.values).toHaveLength(4);
    expect(sub.values[0]).toBe(1); // A-A
    expect(sub.values[3]).toBe(1); // C-C
  });
});

describe("updateCorrelationState", () => {
  it("initializes and updates state", () => {
    const state = createEmptyCorrelationState();
    const bars = new Map([
      ["AAPL", Array.from({ length: 25 }, (_, i) => ({
        t: `2024-01-${String(i + 1).padStart(2, "0")}`,
        o: 100 + i, h: 105 + i, l: 99 + i, c: 100 + i + Math.sin(i), v: 1000, n: 10, vw: 101,
      }))],
      ["MSFT", Array.from({ length: 25 }, (_, i) => ({
        t: `2024-01-${String(i + 1).padStart(2, "0")}`,
        o: 300 + i, h: 305 + i, l: 299 + i, c: 300 + i + Math.cos(i), v: 2000, n: 20, vw: 301,
      }))],
    ]);

    const updated = updateCorrelationState(state, bars);
    expect(updated.matrix).not.toBeNull();
    expect(updated.matrix!.symbols).toEqual(["AAPL", "MSFT"]);
    expect(Object.keys(updated.series)).toHaveLength(2);
  });
});
