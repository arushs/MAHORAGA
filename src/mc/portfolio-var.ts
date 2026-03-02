/**
 * Portfolio VaR/CVaR Engine
 *
 * Replaces per-position risk checks with portfolio-level Monte Carlo VaR
 * using the t-copula joint return simulator. Results feed into PolicyEngine
 * for position-level accept/reject decisions.
 *
 * Metrics:
 *   - Portfolio VaR (95%, 99%)
 *   - Portfolio CVaR (Expected Shortfall)
 *   - Marginal VaR per position
 *   - Component VaR per position (Euler decomposition)
 */

import type { CorrelationMatrix } from "./correlation";
import { extractSubMatrix } from "./correlation";
import { simulateCopula, type CopulaConfig, type CopulaResult } from "./copula";

// ── Types ───────────────────────────────────────────────────────────────

export interface PortfolioPosition {
  symbol: string;
  marketValue: number;
  annualizedVol: number;
  expectedReturn?: number;
}

export interface VaRResult {
  var95: number;
  var99: number;
  cvar95: number;
  cvar99: number;
  portfolioValue: number;
  var95Pct: number;
  var99Pct: number;
  marginalVaR: Record<string, number>;
  componentVaR: Record<string, number>;
  scenarioCount: number;
  computeTimeMs: number;
}

export interface PortfolioRiskDecision {
  acceptable: boolean;
  currentRisk: VaRResult;
  projectedRisk: VaRResult | null;
  reason?: string;
  warnings: string[];
}

export interface PortfolioRiskConfig {
  maxVar99PctEquity?: number;
  maxComponentVarPct?: number;
  numScenarios?: number;
  degreesOfFreedom?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length;
}

// ── Single-asset VaR (no copula needed) ─────────────────────────────────

function normalInvCdfApprox(p: number): number {
  // Abramowitz & Stegun 26.2.23
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328;
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308;
  const z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
  return p < 0.5 ? -z : z;
}

function singleAssetVaR(pos: PortfolioPosition, numScenarios: number, startTime: number): VaRResult {
  const dailyVol = pos.annualizedVol / Math.sqrt(252);
  const pnls: number[] = [];

  for (let i = 1; i <= numScenarios; i++) {
    // Halton base-2 for quasi-random
    let result = 0, f = 0.5, idx = i;
    while (idx > 0) { result += f * (idx % 2); idx = Math.floor(idx / 2); f /= 2; }
    const u = Math.max(1e-10, Math.min(1 - 1e-10, result));
    const z = normalInvCdfApprox(u);
    pnls.push(pos.marketValue * dailyVol * z);
  }

  pnls.sort((a, b) => a - b);
  const n = pnls.length;
  const var95 = -pnls[Math.floor(n * 0.05)]!;
  const var99 = -pnls[Math.floor(n * 0.01)]!;
  const cvar95 = -mean(pnls.slice(0, Math.floor(n * 0.05)));
  const cvar99 = -mean(pnls.slice(0, Math.floor(n * 0.01)));

  return {
    var95: Math.max(0, var95),
    var99: Math.max(0, var99),
    cvar95: Math.max(0, cvar95),
    cvar99: Math.max(0, cvar99),
    portfolioValue: pos.marketValue,
    var95Pct: pos.marketValue > 0 ? Math.max(0, var95) / pos.marketValue : 0,
    var99Pct: pos.marketValue > 0 ? Math.max(0, var99) / pos.marketValue : 0,
    marginalVaR: { [pos.symbol]: Math.max(0, var95) },
    componentVaR: { [pos.symbol]: Math.max(0, var95) },
    scenarioCount: n,
    computeTimeMs: Date.now() - startTime,
  };
}

function emptyVaR(startTime: number): VaRResult {
  return {
    var95: 0, var99: 0, cvar95: 0, cvar99: 0,
    portfolioValue: 0, var95Pct: 0, var99Pct: 0,
    marginalVaR: {}, componentVaR: {},
    scenarioCount: 0, computeTimeMs: Date.now() - startTime,
  };
}

// ── Core VaR computation ────────────────────────────────────────────────

export function computePortfolioVaR(
  positions: PortfolioPosition[],
  corrMatrix: CorrelationMatrix,
  config?: Partial<PortfolioRiskConfig>
): VaRResult {
  const start = Date.now();
  const numScenarios = config?.numScenarios ?? 10_000;
  const dof = config?.degreesOfFreedom ?? 5;

  if (positions.length === 0) return emptyVaR(start);
  if (positions.length === 1) return singleAssetVaR(positions[0]!, numScenarios, start);

  const symbols = positions.map((p) => p.symbol);
  const weights = positions.map((p) => p.marketValue);
  const totalValue = weights.reduce((a, b) => a + b, 0);
  if (totalValue <= 0) return emptyVaR(start);

  const subMatrix = extractSubMatrix(corrMatrix, symbols);

  const copulaConfig: CopulaConfig = {
    vols: positions.map((p) => p.annualizedVol),
    expectedReturns: positions.map((p) => p.expectedReturn ?? 0),
    numScenarios,
    degreesOfFreedom: dof,
  };

  let result: CopulaResult;
  try {
    result = simulateCopula(subMatrix, copulaConfig);
  } catch {
    const n = symbols.length;
    const identity: CorrelationMatrix = {
      symbols,
      values: Array.from({ length: n * n }, (_, idx) => (Math.floor(idx / n) === idx % n ? 1 : 0)),
      observationCount: 0,
      updatedAt: Date.now(),
    };
    result = simulateCopula(identity, copulaConfig);
  }

  const portfolioPnL: number[] = new Array(numScenarios);
  const positionPnL: number[][] = positions.map(() => new Array<number>(numScenarios));

  for (let s = 0; s < result.scenarios.length; s++) {
    let totalPnl = 0;
    const scenario = result.scenarios[s]!;
    for (let i = 0; i < positions.length; i++) {
      const pnl = weights[i]! * scenario[i]!;
      positionPnL[i]![s] = pnl;
      totalPnl += pnl;
    }
    portfolioPnL[s] = totalPnl;
  }

  const sorted = portfolioPnL.slice().sort((a, b) => a! - b!);
  const n = sorted.length;

  const var95 = -sorted[Math.floor(n * 0.05)]!;
  const var99 = -sorted[Math.floor(n * 0.01)]!;
  const cvar95 = -mean(sorted.slice(0, Math.floor(n * 0.05)) as number[]);
  const cvar99 = -mean(sorted.slice(0, Math.floor(n * 0.01)) as number[]);

  const marginalVaR: Record<string, number> = {};
  const componentVaR: Record<string, number> = {};
  const meanPortfolio = mean(portfolioPnL as number[]);

  for (let i = 0; i < positions.length; i++) {
    const posPnl = positionPnL[i]!;
    const meanPos = mean(posPnl);
    let cov = 0;
    for (let s = 0; s < n; s++) {
      cov += (posPnl[s]! - meanPos) * (portfolioPnL[s]! - meanPortfolio);
    }
    cov /= n;

    const portfolioVar = variance(portfolioPnL as number[]);
    const beta = portfolioVar > 0 ? cov / portfolioVar : 1 / positions.length;

    componentVaR[positions[i]!.symbol] = beta * var95;
    marginalVaR[positions[i]!.symbol] = var95 > 0 ? cov / Math.sqrt(portfolioVar) : 0;
  }

  return {
    var95: Math.max(0, var95),
    var99: Math.max(0, var99),
    cvar95: Math.max(0, cvar95),
    cvar99: Math.max(0, cvar99),
    portfolioValue: totalValue,
    var95Pct: totalValue > 0 ? var95 / totalValue : 0,
    var99Pct: totalValue > 0 ? var99 / totalValue : 0,
    marginalVaR,
    componentVaR,
    scenarioCount: result.scenarios.length,
    computeTimeMs: Date.now() - start,
  };
}

// ── Portfolio risk decision ─────────────────────────────────────────────

export function evaluatePortfolioRisk(
  currentPositions: PortfolioPosition[],
  proposedTrade: PortfolioPosition,
  equity: number,
  corrMatrix: CorrelationMatrix,
  config?: PortfolioRiskConfig
): PortfolioRiskDecision {
  const maxVar99Pct = config?.maxVar99PctEquity ?? 0.05;
  const maxComponentPct = config?.maxComponentVarPct ?? 0.40;
  const warnings: string[] = [];

  const currentRisk = computePortfolioVaR(currentPositions, corrMatrix, config);

  const projectedPositions = [...currentPositions];
  const existingIdx = projectedPositions.findIndex((p) => p.symbol === proposedTrade.symbol);
  if (existingIdx >= 0) {
    const existing = projectedPositions[existingIdx]!;
    projectedPositions[existingIdx] = {
      ...existing,
      marketValue: existing.marketValue + proposedTrade.marketValue,
    };
  } else {
    projectedPositions.push(proposedTrade);
  }

  const projectedRisk = computePortfolioVaR(projectedPositions, corrMatrix, config);

  if (projectedRisk.var99 > maxVar99Pct * equity) {
    return {
      acceptable: false,
      currentRisk,
      projectedRisk,
      reason: `Portfolio VaR(99%) would be $${projectedRisk.var99.toFixed(0)} (${(projectedRisk.var99Pct * 100).toFixed(1)}% of equity), exceeding ${(maxVar99Pct * 100).toFixed(0)}% limit`,
      warnings,
    };
  }

  const totalVar = projectedRisk.var95;
  if (totalVar > 0) {
    for (const [sym, compVar] of Object.entries(projectedRisk.componentVaR)) {
      const pct = compVar / totalVar;
      if (pct > maxComponentPct) {
        return {
          acceptable: false,
          currentRisk,
          projectedRisk,
          reason: `${sym} would contribute ${(pct * 100).toFixed(0)}% of portfolio VaR, exceeding ${(maxComponentPct * 100).toFixed(0)}% concentration limit`,
          warnings,
        };
      }
      if (pct > maxComponentPct * 0.8) {
        warnings.push(`${sym} contributes ${(pct * 100).toFixed(0)}% of portfolio VaR, approaching limit`);
      }
    }
  }

  if (currentRisk.var99 > 0) {
    const varIncrease = (projectedRisk.var99 - currentRisk.var99) / currentRisk.var99;
    if (varIncrease > 0.2) {
      warnings.push(`Trade increases portfolio VaR(99%) by ${(varIncrease * 100).toFixed(0)}%`);
    }
  }

  return { acceptable: true, currentRisk, projectedRisk, warnings };
}
