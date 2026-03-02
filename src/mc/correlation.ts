/**
 * Rolling Correlation Estimator
 *
 * Computes rolling 20-day pairwise Pearson correlations from Alpaca daily bars.
 * Stores correlation matrix in Durable Object state for consumption by the
 * t-copula simulator and portfolio VaR engine.
 *
 * Design:
 *   - Maintains a rolling window of daily log-returns per symbol
 *   - Pairwise correlation via standard Pearson formula
 *   - Exponential weighting (halflife=10d) for regime-responsiveness
 *   - Persists to DO state under key "correlation_matrix"
 */

import type { Bar } from "../providers/types";

// ── Types ───────────────────────────────────────────────────────────────

export interface CorrelationMatrix {
  /** Symbol list in order (row/col labels) */
  symbols: string[];
  /** Flat row-major correlation values (n×n) */
  values: number[];
  /** Number of overlapping observations used */
  observationCount: number;
  /** Timestamp of last update */
  updatedAt: number;
}

export interface ReturnSeries {
  symbol: string;
  /** Daily log-returns, newest last */
  returns: number[];
  /** Corresponding dates (ISO strings) */
  dates: string[];
}

export interface CorrelationEstimatorState {
  /** Rolling return series per symbol */
  series: Record<string, ReturnSeries>;
  /** Last computed correlation matrix */
  matrix: CorrelationMatrix | null;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_WINDOW = 20;
const DEFAULT_HALFLIFE = 10;
const MAX_WINDOW = 60;

// ── Exponential weights ─────────────────────────────────────────────────

function expWeights(n: number, halflife: number): number[] {
  const lambda = Math.log(2) / halflife;
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    weights.push(Math.exp(-lambda * (n - 1 - i)));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / sum);
}

// ── Core math ───────────────────────────────────────────────────────────

export function weightedCorrelation(
  x: number[],
  y: number[],
  weights: number[]
): number {
  const n = x.length;
  if (n < 3 || y.length !== n || weights.length !== n) return NaN;

  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += weights[i]! * x[i]!;
    meanY += weights[i]! * y[i]!;
  }

  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    covXY += weights[i]! * dx * dy;
    varX += weights[i]! * dx * dx;
    varY += weights[i]! * dy * dy;
  }

  if (varX < 1e-15 || varY < 1e-15) return 0;
  return covXY / Math.sqrt(varX * varY);
}

// ── Log-return extraction from bars ─────────────────────────────────────

export function barsToLogReturns(bars: Bar[]): { returns: number[]; dates: string[] } {
  if (bars.length < 2) return { returns: [], dates: [] };

  const returns: number[] = [];
  const dates: string[] = [];

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.c;
    const curr = bars[i]!.c;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
      dates.push(bars[i]!.t);
    }
  }

  return { returns, dates };
}

// ── Correlation matrix computation ──────────────────────────────────────

export function computeCorrelationMatrix(
  seriesList: ReturnSeries[],
  window: number = DEFAULT_WINDOW,
  halflife: number = DEFAULT_HALFLIFE
): CorrelationMatrix {
  const n = seriesList.length;
  const symbols = seriesList.map((s) => s.symbol);

  if (n === 0) {
    return { symbols: [], values: [], observationCount: 0, updatedAt: Date.now() };
  }

  if (n === 1) {
    return { symbols, values: [1], observationCount: seriesList[0]!.returns.length, updatedAt: Date.now() };
  }

  const dateMaps: Map<string, number>[] = seriesList.map((s) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.dates.length; i++) {
      m.set(s.dates[i]!, s.returns[i]!);
    }
    return m;
  });

  const allDates = new Set<string>();
  for (const dm of dateMaps) {
    for (const d of dm.keys()) allDates.add(d);
  }

  const commonDates = [...allDates]
    .filter((d) => dateMaps.every((dm) => dm.has(d)))
    .sort();

  const useDates = commonDates.slice(-window);
  const obsCount = useDates.length;

  const aligned: number[][] = seriesList.map((_, idx) =>
    useDates.map((d) => dateMaps[idx]!.get(d)!)
  );

  const weights = obsCount >= 3 ? expWeights(obsCount, halflife) : [];

  const values = new Array<number>(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        values[i * n + j] = 1;
      } else if (j > i) {
        const rho = obsCount >= 3
          ? weightedCorrelation(aligned[i]!, aligned[j]!, weights)
          : 0;
        values[i * n + j] = Number.isNaN(rho) ? 0 : rho;
      } else {
        values[i * n + j] = values[j * n + i]!;
      }
    }
  }

  return { symbols, values, observationCount: obsCount, updatedAt: Date.now() };
}

// ── State management ────────────────────────────────────────────────────

export function updateCorrelationState(
  state: CorrelationEstimatorState,
  symbolBars: Map<string, Bar[]>,
  window: number = DEFAULT_WINDOW
): CorrelationEstimatorState {
  for (const [symbol, bars] of symbolBars) {
    const { returns, dates } = barsToLogReturns(bars);

    if (state.series[symbol]) {
      const existing = state.series[symbol]!;
      const existingDateSet = new Set(existing.dates);

      for (let i = 0; i < dates.length; i++) {
        if (!existingDateSet.has(dates[i]!)) {
          existing.returns.push(returns[i]!);
          existing.dates.push(dates[i]!);
        }
      }

      if (existing.returns.length > MAX_WINDOW) {
        const excess = existing.returns.length - MAX_WINDOW;
        existing.returns.splice(0, excess);
        existing.dates.splice(0, excess);
      }
    } else {
      const trimmed = returns.length > MAX_WINDOW
        ? { returns: returns.slice(-MAX_WINDOW), dates: dates.slice(-MAX_WINDOW) }
        : { returns, dates };
      state.series[symbol] = { symbol, ...trimmed };
    }
  }

  const seriesList = Object.values(state.series);
  const matrix = computeCorrelationMatrix(seriesList, window);

  return { series: state.series, matrix };
}

export function pruneCorrelationState(
  state: CorrelationEstimatorState,
  activeSymbols: Set<string>
): CorrelationEstimatorState {
  const pruned: Record<string, ReturnSeries> = {};
  for (const [sym, series] of Object.entries(state.series)) {
    if (activeSymbols.has(sym)) {
      pruned[sym] = series;
    }
  }
  state.series = pruned;

  const seriesList = Object.values(pruned);
  state.matrix = computeCorrelationMatrix(seriesList);

  return state;
}

export function getPairwiseCorrelation(
  matrix: CorrelationMatrix,
  symbolA: string,
  symbolB: string
): number {
  const idxA = matrix.symbols.indexOf(symbolA);
  const idxB = matrix.symbols.indexOf(symbolB);
  if (idxA < 0 || idxB < 0) return 0;
  const n = matrix.symbols.length;
  return matrix.values[idxA * n + idxB]!;
}

export function extractSubMatrix(
  matrix: CorrelationMatrix,
  symbols: string[]
): CorrelationMatrix {
  const indices = symbols.map((s) => matrix.symbols.indexOf(s));
  if (indices.some((i) => i < 0)) {
    const found = symbols.filter((s) => matrix.symbols.includes(s));
    return extractSubMatrix(matrix, found);
  }

  const n = symbols.length;
  const fullN = matrix.symbols.length;
  const values = new Array<number>(n * n);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      values[i * n + j] = matrix.values[indices[i]! * fullN + indices[j]!]!;
    }
  }

  return {
    symbols,
    values,
    observationCount: matrix.observationCount,
    updatedAt: matrix.updatedAt,
  };
}

export function createEmptyCorrelationState(): CorrelationEstimatorState {
  return { series: {}, matrix: null };
}
