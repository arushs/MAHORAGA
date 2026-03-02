/**
 * Full Monitoring Suite
 *
 * P&L attribution, model drift detection, and recalibration alerts.
 *
 * Components:
 *   1. P&L Attribution — decomposes P&L into alpha, market, and execution components
 *   2. Model Drift Detection — KL divergence between predicted and realized distributions
 *   3. Recalibration Alerts — triggers when drift exceeds thresholds
 *
 * All metrics are stored in D1 for time-series analysis.
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface PnLAttribution {
  /** Total realized P&L */
  totalPnL: number;
  /** P&L from market movement (beta) */
  marketPnL: number;
  /** P&L from alpha (selection/timing) */
  alphaPnL: number;
  /** P&L lost to execution costs (slippage + commissions) */
  executionCost: number;
  /** Residual (unexplained) */
  residual: number;
  /** Period start timestamp */
  periodStart: number;
  /** Period end timestamp */
  periodEnd: number;
}

export interface PnLInput {
  /** Position symbol */
  symbol: string;
  /** Entry price */
  entryPrice: number;
  /** Exit price (or current price) */
  exitPrice: number;
  /** Number of shares */
  shares: number;
  /** Market benchmark return over same period (e.g., SPY return) */
  benchmarkReturn: number;
  /** Position beta to benchmark */
  beta: number;
  /** Execution slippage paid (dollars) */
  slippageCost: number;
  /** Commission cost (dollars) */
  commissionCost: number;
}

export interface DriftMetrics {
  /** KL divergence: D_KL(realized || predicted) */
  klDivergence: number;
  /** Number of bins used */
  numBins: number;
  /** Number of observations */
  observationCount: number;
  /** Chi-squared test statistic */
  chiSquared: number;
  /** Whether drift is significant (KL > threshold) */
  driftDetected: boolean;
  /** Timestamp of computation */
  computedAt: number;
}

export interface DriftConfig {
  /** KL divergence threshold for alert. Default: 0.1 */
  klThreshold?: number;
  /** Minimum observations before checking drift. Default: 30 */
  minObservations?: number;
  /** Number of histogram bins. Default: 10 */
  numBins?: number;
}

export interface CalibrationAlert {
  type: 'drift' | 'bias' | 'overconfidence' | 'underconfidence';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metrics: Record<string, number>;
  timestamp: number;
}

export interface MonitoringSnapshot {
  pnlAttribution: PnLAttribution | null;
  driftMetrics: DriftMetrics | null;
  alerts: CalibrationAlert[];
  timestamp: number;
}

// ── P&L Attribution ─────────────────────────────────────────────────────

/**
 * Decompose P&L into market (beta), alpha, and execution components.
 *
 * total = market + alpha + execution_cost + residual
 * market = shares * entryPrice * beta * benchmarkReturn
 * alpha  = total - market - execution_cost
 */
export function attributePnL(inputs: PnLInput[]): PnLAttribution {
  let totalPnL = 0;
  let marketPnL = 0;
  let executionCost = 0;

  for (const pos of inputs) {
    const positionPnL = (pos.exitPrice - pos.entryPrice) * pos.shares;
    totalPnL += positionPnL;

    // Market component: what we'd have made just from beta exposure
    const mktPnl = pos.shares * pos.entryPrice * pos.beta * pos.benchmarkReturn;
    marketPnL += mktPnl;

    executionCost += pos.slippageCost + pos.commissionCost;
  }

  const alphaPnL = totalPnL - marketPnL - executionCost;
  const residual = totalPnL - marketPnL - alphaPnL - executionCost;

  return {
    totalPnL,
    marketPnL,
    alphaPnL,
    executionCost,
    residual,
    periodStart: Date.now(),
    periodEnd: Date.now(),
  };
}

// ── Drift Detection ─────────────────────────────────────────────────────

/**
 * Compute KL divergence between predicted probability distribution
 * and realized outcome distribution.
 *
 * We bin predictions into buckets, compute:
 *   - predicted frequency per bin (average predicted prob)
 *   - realized frequency per bin (actual hit rate)
 *
 * KL(realized || predicted) = Σ r_i * log(r_i / p_i)
 */
export function computeDrift(
  predictions: Array<{ predicted: number; outcome: 0 | 1 }>,
  config?: DriftConfig,
): DriftMetrics {
  const numBins = config?.numBins ?? 10;
  const klThreshold = config?.klThreshold ?? 0.1;
  const minObs = config?.minObservations ?? 30;

  const n = predictions.length;

  if (n < minObs) {
    return {
      klDivergence: 0,
      numBins,
      observationCount: n,
      chiSquared: 0,
      driftDetected: false,
      computedAt: Date.now(),
    };
  }

  // Bin predictions by predicted probability
  const binCounts = new Array<number>(numBins).fill(0);
  const binHits = new Array<number>(numBins).fill(0);
  const binPredSum = new Array<number>(numBins).fill(0);

  for (const { predicted, outcome } of predictions) {
    const binIdx = Math.min(numBins - 1, Math.floor(predicted * numBins));
    binCounts[binIdx]!++;
    binHits[binIdx]! += outcome;
    binPredSum[binIdx]! += predicted;
  }

  let klDiv = 0;
  let chiSq = 0;
  const eps = 1e-10; // smoothing

  for (let i = 0; i < numBins; i++) {
    const count = binCounts[i]!;
    if (count === 0) continue;

    const realizedRate = (binHits[i]! + eps) / (count + 2 * eps);
    const predictedRate = (binPredSum[i]! / count + eps);
    const clampedPred = Math.max(eps, Math.min(1 - eps, predictedRate));
    const clampedReal = Math.max(eps, Math.min(1 - eps, realizedRate));

    // KL contribution
    klDiv += clampedReal * Math.log(clampedReal / clampedPred);
    klDiv += (1 - clampedReal) * Math.log((1 - clampedReal) / (1 - clampedPred));

    // Chi-squared contribution
    const expected = count * clampedPred;
    const observed = binHits[i]!;
    if (expected > 0) {
      chiSq += (observed - expected) ** 2 / expected;
    }
  }

  return {
    klDivergence: Math.max(0, klDiv),
    numBins,
    observationCount: n,
    chiSquared: chiSq,
    driftDetected: klDiv > klThreshold,
    computedAt: Date.now(),
  };
}

// ── Calibration Alerts ──────────────────────────────────────────────────

/**
 * Generate calibration alerts from prediction history.
 */
export function checkCalibration(
  predictions: Array<{ predicted: number; outcome: 0 | 1 }>,
  config?: DriftConfig,
): CalibrationAlert[] {
  const alerts: CalibrationAlert[] = [];
  const n = predictions.length;
  if (n < 20) return alerts;

  // Overall bias check
  const meanPredicted = predictions.reduce((s, p) => s + p.predicted, 0) / n;
  const meanOutcome = predictions.reduce((s, p) => s + p.outcome, 0) / n;
  const bias = meanPredicted - meanOutcome;

  if (Math.abs(bias) > 0.1) {
    alerts.push({
      type: 'bias',
      severity: Math.abs(bias) > 0.2 ? 'critical' : 'warning',
      message: `Prediction bias: ${bias > 0 ? 'over' : 'under'}predicting by ${(Math.abs(bias) * 100).toFixed(1)}%`,
      metrics: { bias, meanPredicted, meanOutcome },
      timestamp: Date.now(),
    });
  }

  // Overconfidence check: high predictions that don't hit
  const highConf = predictions.filter((p) => p.predicted > 0.7);
  if (highConf.length >= 10) {
    const hitRate = highConf.reduce((s, p) => s + p.outcome, 0) / highConf.length;
    const avgPred = highConf.reduce((s, p) => s + p.predicted, 0) / highConf.length;
    if (hitRate < avgPred - 0.15) {
      alerts.push({
        type: 'overconfidence',
        severity: hitRate < avgPred - 0.25 ? 'critical' : 'warning',
        message: `Overconfident: ${(avgPred * 100).toFixed(0)}% avg prediction, ${(hitRate * 100).toFixed(0)}% hit rate (n=${highConf.length})`,
        metrics: { avgPred, hitRate, count: highConf.length },
        timestamp: Date.now(),
      });
    }
  }

  // Underconfidence check: low predictions that actually hit
  const lowConf = predictions.filter((p) => p.predicted < 0.4);
  if (lowConf.length >= 10) {
    const hitRate = lowConf.reduce((s, p) => s + p.outcome, 0) / lowConf.length;
    const avgPred = lowConf.reduce((s, p) => s + p.predicted, 0) / lowConf.length;
    if (hitRate > avgPred + 0.15) {
      alerts.push({
        type: 'underconfidence',
        severity: hitRate > avgPred + 0.25 ? 'critical' : 'warning',
        message: `Underconfident: ${(avgPred * 100).toFixed(0)}% avg prediction, ${(hitRate * 100).toFixed(0)}% hit rate (n=${lowConf.length})`,
        metrics: { avgPred, hitRate, count: lowConf.length },
        timestamp: Date.now(),
      });
    }
  }

  // Drift check
  const drift = computeDrift(predictions, config);
  if (drift.driftDetected) {
    alerts.push({
      type: 'drift',
      severity: drift.klDivergence > 0.3 ? 'critical' : 'warning',
      message: `Model drift detected: KL divergence = ${drift.klDivergence.toFixed(4)}`,
      metrics: {
        klDivergence: drift.klDivergence,
        chiSquared: drift.chiSquared,
        observations: drift.observationCount,
      },
      timestamp: Date.now(),
    });
  }

  return alerts;
}

// ── D1 Persistence ──────────────────────────────────────────────────────

export async function saveMonitoringSnapshot(
  db: D1Database,
  snapshot: MonitoringSnapshot,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitoring_snapshots (snapshot_json, created_at)
       VALUES (?, unixepoch())`,
    )
    .bind(JSON.stringify(snapshot))
    .run();
}

export async function getRecentSnapshots(
  db: D1Database,
  limit: number = 24,
): Promise<MonitoringSnapshot[]> {
  const rows = await db
    .prepare(
      `SELECT snapshot_json FROM monitoring_snapshots
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ snapshot_json: string }>();

  return (rows.results ?? []).map((r) => JSON.parse(r.snapshot_json) as MonitoringSnapshot);
}

/**
 * Load prediction history from D1 for drift analysis.
 */
export async function loadPredictionHistory(
  db: D1Database,
  days: number = 30,
): Promise<Array<{ predicted: number; outcome: 0 | 1 }>> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const rows = await db
    .prepare(
      `SELECT predicted_prob, outcome FROM mc_predictions
       WHERE outcome IS NOT NULL AND evaluated_at >= ?
       ORDER BY evaluated_at DESC`,
    )
    .bind(since)
    .all<{ predicted_prob: number; outcome: number }>();

  return (rows.results ?? []).map((r) => ({
    predicted: r.predicted_prob,
    outcome: (r.outcome > 0 ? 1 : 0) as 0 | 1,
  }));
}
