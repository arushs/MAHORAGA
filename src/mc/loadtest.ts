/**
 * Load Testing for MC Stack on Cloudflare Workers
 *
 * Benchmarks the full MC pipeline (particle filter → copula → VaR → kill switch)
 * running within a 30-second alarm cycle. Identifies hot paths and validates
 * that the stack completes in <5s per cycle.
 *
 * Usage: called from a cron trigger or API endpoint to profile performance.
 * Results stored in KV for dashboard consumption.
 */

import { initFilter, filterBatch, type ParticleFilterConfig } from './particle-filter';
import { runSimulation } from './simulator';
import type { MCSimulationParams } from './types';
import { computeCorrelationMatrix, type ReturnSeries } from './correlation';
import { simulateCopulaFlat } from './copula';
import { computePortfolioVaR, type PortfolioPosition } from './portfolio-var';
import { computeKelly, type KellyInput } from './kelly';
import { runABM } from './abm';
import {
  ensemblePredict,
  createEnsembleState,
  registerModel,
  updateEnsemble,
} from './ensemble';

// ── Types ───────────────────────────────────────────────────────────────

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  avgMs: number;
  p99Ms: number;
  peakMemoryKB?: number;
}

export interface LoadTestReport {
  /** Total wall-clock time for full pipeline (ms) */
  totalMs: number;
  /** Per-component benchmarks */
  components: BenchmarkResult[];
  /** Whether pipeline completed within budget */
  withinBudget: boolean;
  /** Budget in ms */
  budgetMs: number;
  /** Optimization recommendations */
  recommendations: string[];
  /** Timestamp */
  timestamp: number;
}

// ── Benchmark harness ───────────────────────────────────────────────────

function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 10,
): BenchmarkResult {
  const times: number[] = [];

  // Warmup
  fn();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p99Idx = Math.min(times.length - 1, Math.floor(times.length * 0.99));

  return {
    name,
    durationMs: times.reduce((a, b) => a + b, 0),
    iterations,
    avgMs: avg,
    p99Ms: times[p99Idx]!,
  };
}

// ── Synthetic test data generators ──────────────────────────────────────

function generateReturnSeries(symbol: string, days: number): ReturnSeries {
  const returns: number[] = [];
  const dates: string[] = [];
  const base = new Date('2025-01-01');
  for (let i = 0; i < days; i++) {
    returns.push((Math.random() - 0.5) * 0.04); // ~2% daily vol
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return { symbol, returns, dates };
}

function generatePositions(n: number): PortfolioPosition[] {
  const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM'];
  return symbols.slice(0, n).map((symbol) => ({
    symbol,
    marketValue: 10000 + Math.random() * 20000,
    annualizedVol: 0.2 + Math.random() * 0.3,
    expectedReturn: 0.05 + Math.random() * 0.1,
  }));
}

// ── Load test pipeline ──────────────────────────────────────────────────

/**
 * Run full MC stack load test simulating a 30s alarm cycle.
 *
 * Pipeline:
 *   1. Particle filter update (5 symbols × 10 price observations)
 *   2. MC GBM simulation (5 symbols × 10K paths)
 *   3. Correlation matrix computation (5 symbols)
 *   4. Copula simulation (5 assets × 10K scenarios)
 *   5. Portfolio VaR (full portfolio)
 *   6. Kelly sizing (5 candidates)
 *   7. ABM slippage estimation (1 order)
 *   8. Ensemble calibration update
 */
export function runLoadTest(budgetMs: number = 5000): LoadTestReport {
  const t0 = performance.now();
  const components: BenchmarkResult[] = [];
  const recommendations: string[] = [];

  // 1. Particle filter
  const pfConfig: ParticleFilterConfig = { numParticles: 2000 };
  components.push(benchmark('particle-filter-init', () => {
    initFilter(100, Date.now(), pfConfig);
  }, 5));

  components.push(benchmark('particle-filter-batch-10', () => {
    const obs: Array<{ price: number; timestampMs: number }> = [];
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      obs.push({ price: 100 + (Math.random() - 0.5) * 2, timestampMs: now + i * 60_000 });
    }
    filterBatch(100, obs, pfConfig);
  }, 5));

  // 2. MC GBM simulation
  const mcParams: MCSimulationParams = {
    currentPrice: 150,
    impliedVol: 0.3,
    horizonMs: 24 * 3600_000,
    targetPrice: 155,
    numPaths: 10_000,
  };
  components.push(benchmark('mc-gbm-10k-paths', () => {
    runSimulation(mcParams);
  }, 10));

  // 3. Correlation matrix
  const series = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'].map((s) =>
    generateReturnSeries(s, 30),
  );
  components.push(benchmark('correlation-5-assets', () => {
    computeCorrelationMatrix(series, 20, 10);
  }, 10));

  // 4. Copula simulation
  const vols = [0.25, 0.3, 0.35, 0.28, 0.4];
  components.push(benchmark('copula-5-assets-10k', () => {
    simulateCopulaFlat(
      ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'],
      vols,
      0.4,
      { numScenarios: 10_000, degreesOfFreedom: 5 },
      42,
    );
  }, 5));

  // 5. Portfolio VaR
  const positions = generatePositions(5);
  const corrMatrix = computeCorrelationMatrix(series, 20, 10);
  components.push(benchmark('portfolio-var-5-assets', () => {
    computePortfolioVaR(positions, corrMatrix, { numScenarios: 5_000 });
  }, 5));

  // 6. Kelly sizing
  const kellyInput: KellyInput = {
    probProfit: 0.65,
    expectedGainRatio: 0.08,
    expectedLossRatio: 0.05,
    availableCash: 50_000,
    equity: 100_000,
    openPositions: 3,
    maxPositions: 10,
  };
  components.push(benchmark('kelly-sizing', () => {
    for (let i = 0; i < 5; i++) {
      computeKelly({ ...kellyInput, probProfit: 0.55 + Math.random() * 0.2 });
    }
  }, 10));

  // 7. ABM slippage estimation
  components.push(benchmark('abm-slippage', () => {
    runABM(
      { initialPrice: 150, dailyVolume: 1_000_000, numSteps: 200, seed: 42 },
      100,
      'buy',
      20,
    );
  }, 5));

  // 8. Ensemble calibration
  components.push(benchmark('ensemble-update', () => {
    let state = createEnsembleState();
    state = registerModel(state, 'mc-gbm');
    state = registerModel(state, 'particle-filter');
    state = registerModel(state, 'llm-signal');
    for (let i = 0; i < 20; i++) {
      const preds: Record<string, number> = {
        'mc-gbm': 0.5 + Math.random() * 0.3,
        'particle-filter': 0.5 + Math.random() * 0.3,
        'llm-signal': 0.4 + Math.random() * 0.4,
      };
      state = updateEnsemble(state, preds, Math.random() > 0.5 ? 1 : 0);
    }
    ensemblePredict(state, [
      { modelId: 'mc-gbm', probability: 0.65 },
      { modelId: 'particle-filter', probability: 0.72 },
      { modelId: 'llm-signal', probability: 0.58 },
    ]);
  }, 5));

  const totalMs = performance.now() - t0;

  // Identify hot paths
  const sorted = [...components].sort((a, b) => b.avgMs - a.avgMs);
  if (sorted[0] && sorted[0].avgMs > budgetMs * 0.3) {
    recommendations.push(
      `Hot path: ${sorted[0].name} takes ${sorted[0].avgMs.toFixed(1)}ms avg — consider reducing iterations or scenarios`,
    );
  }

  if (totalMs > budgetMs) {
    const overage = ((totalMs - budgetMs) / budgetMs * 100).toFixed(0);
    recommendations.push(`Pipeline ${overage}% over budget. Consider: reducing copula scenarios, fewer PF particles, or caching correlation matrix.`);
  }

  // Component-specific recommendations
  for (const c of components) {
    if (c.name === 'copula-5-assets-10k' && c.avgMs > 500) {
      recommendations.push('Copula: reduce to 5K scenarios or cache Cholesky decomposition');
    }
    if (c.name === 'portfolio-var-5-assets' && c.avgMs > 1000) {
      recommendations.push('VaR: use delta-normal approximation for intra-day, full MC for EOD only');
    }
    if (c.name === 'abm-slippage' && c.avgMs > 300) {
      recommendations.push('ABM: reduce numSteps to 100 and numTrials to 10 for real-time use');
    }
  }

  return {
    totalMs,
    components,
    withinBudget: totalMs <= budgetMs,
    budgetMs,
    recommendations,
    timestamp: Date.now(),
  };
}

/**
 * Save load test results to KV for dashboard access.
 */
export async function saveLoadTestReport(
  kv: KVNamespace,
  report: LoadTestReport,
): Promise<void> {
  await kv.put('loadtest:latest', JSON.stringify(report), {
    expirationTtl: 86400,
  });

  // Keep last 24 results
  const historyJson = await kv.get('loadtest:history');
  const history: LoadTestReport[] = historyJson ? JSON.parse(historyJson) : [];
  history.unshift(report);
  if (history.length > 24) history.length = 24;
  await kv.put('loadtest:history', JSON.stringify(history), {
    expirationTtl: 86400 * 7,
  });
}
