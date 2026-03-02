/**
 * Model Ensemble Calibration
 *
 * Online weight calibration across multiple prediction models using
 * exponentially-weighted Brier scores. Models that predict better
 * get higher weights in the ensemble.
 *
 * Models tracked:
 *   - MC GBM simulator (from simulator.ts)
 *   - Particle filter (from particle-filter.ts)
 *   - Any future models (LLM-based, etc.)
 *
 * Algorithm:
 *   1. Each model produces P(profit) predictions
 *   2. After outcome observed, compute Brier score per model
 *   3. Update exponentially-weighted average Brier score (halflife ~20 predictions)
 *   4. Weights = softmax of negative Brier scores (lower Brier = higher weight)
 *   5. Ensemble prediction = weighted average of model predictions
 *
 * Persistence: D1 table `model_ensemble_state`
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelPrediction {
  modelId: string;
  probability: number;
}

export interface EnsembleConfig {
  /** Exponential decay halflife in number of observations. Default: 20 */
  halflife?: number;
  /** Softmax temperature for weight computation. Default: 1.0 */
  temperature?: number;
  /** Minimum weight floor per model (prevents total exclusion). Default: 0.05 */
  minWeight?: number;
  /** Initial Brier score for new models (prior). Default: 0.25 (coin flip) */
  initialBrier?: number;
}

export interface ModelState {
  modelId: string;
  /** Exponentially-weighted mean Brier score */
  ewmaBrier: number;
  /** Number of observations */
  observationCount: number;
  /** Current ensemble weight [0, 1] */
  weight: number;
  /** Last update timestamp (ms) */
  lastUpdatedAt: number;
}

export interface EnsembleState {
  models: ModelState[];
  config: Required<EnsembleConfig>;
}

export interface EnsemblePrediction {
  /** Weighted ensemble probability */
  probability: number;
  /** Per-model weights used */
  weights: Record<string, number>;
  /** Per-model raw predictions */
  predictions: Record<string, number>;
  /** Number of models in ensemble */
  modelCount: number;
}

// ── Core math ───────────────────────────────────────────────────────────

function brierScore(predicted: number, outcome: 0 | 1): number {
  return (predicted - outcome) ** 2;
}

function ewmaUpdate(
  currentEwma: number,
  newValue: number,
  halflife: number,
): number {
  const alpha = 1 - Math.exp(-Math.LN2 / halflife);
  return alpha * newValue + (1 - alpha) * currentEwma;
}

function softmaxWeights(
  negBriers: number[],
  temperature: number,
  minWeight: number,
): number[] {
  if (negBriers.length === 0) return [];
  if (negBriers.length === 1) return [1];

  // Subtract max for numerical stability
  const maxVal = Math.max(...negBriers);
  const exps = negBriers.map((x) => Math.exp((x - maxVal) / temperature));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  // Normalize, then apply floor
  let weights = exps.map((e) => e / sumExp);

  // Floor enforcement
  const numModels = weights.length;
  const totalFloor = minWeight * numModels;
  if (totalFloor < 1) {
    weights = weights.map((w) => Math.max(minWeight, w));
    const newSum = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((w) => w / newSum);
  }

  return weights;
}

// ── Ensemble operations ─────────────────────────────────────────────────

export function createEnsembleState(config?: EnsembleConfig): EnsembleState {
  return {
    models: [],
    config: {
      halflife: config?.halflife ?? 20,
      temperature: config?.temperature ?? 1.0,
      minWeight: config?.minWeight ?? 0.05,
      initialBrier: config?.initialBrier ?? 0.25,
    },
  };
}

/**
 * Register a model in the ensemble (idempotent).
 */
export function registerModel(state: EnsembleState, modelId: string): EnsembleState {
  if (state.models.some((m) => m.modelId === modelId)) return state;

  state.models.push({
    modelId,
    ewmaBrier: state.config.initialBrier,
    observationCount: 0,
    weight: 1 / (state.models.length + 1),
    lastUpdatedAt: Date.now(),
  });

  // Rebalance weights
  recalcWeights(state);
  return state;
}

/**
 * Update ensemble after observing an outcome.
 *
 * @param predictions Map of modelId → predicted probability
 * @param outcome 1 = target hit, 0 = missed
 */
export function updateEnsemble(
  state: EnsembleState,
  predictions: Record<string, number>,
  outcome: 0 | 1,
): EnsembleState {
  const { halflife } = state.config;

  for (const model of state.models) {
    const pred = predictions[model.modelId];
    if (pred === undefined) continue;

    const bs = brierScore(pred, outcome);
    model.ewmaBrier = ewmaUpdate(model.ewmaBrier, bs, halflife);
    model.observationCount++;
    model.lastUpdatedAt = Date.now();
  }

  recalcWeights(state);
  return state;
}

function recalcWeights(state: EnsembleState): void {
  const { temperature, minWeight } = state.config;
  const negBriers = state.models.map((m) => -m.ewmaBrier);
  const weights = softmaxWeights(negBriers, temperature, minWeight);
  for (let i = 0; i < state.models.length; i++) {
    state.models[i]!.weight = weights[i]!;
  }
}

/**
 * Produce an ensemble prediction from individual model predictions.
 */
export function ensemblePredict(
  state: EnsembleState,
  predictions: ModelPrediction[],
): EnsemblePrediction {
  const weights: Record<string, number> = {};
  const preds: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const pred of predictions) {
    const model = state.models.find((m) => m.modelId === pred.modelId);
    const w = model?.weight ?? (1 / predictions.length);
    weights[pred.modelId] = w;
    preds[pred.modelId] = pred.probability;
    weightedSum += w * pred.probability;
    totalWeight += w;
  }

  const probability = totalWeight > 0
    ? Math.max(0, Math.min(1, weightedSum / totalWeight))
    : predictions.reduce((s, p) => s + p.probability, 0) / predictions.length;

  return {
    probability,
    weights,
    predictions: preds,
    modelCount: predictions.length,
  };
}

// ── D1 persistence ──────────────────────────────────────────────────────

/**
 * Save ensemble state to D1.
 */
export async function saveEnsembleState(
  db: D1Database,
  state: EnsembleState,
): Promise<void> {
  const json = JSON.stringify(state);
  await db
    .prepare(
      `INSERT OR REPLACE INTO model_ensemble_state (id, state_json, updated_at)
       VALUES ('default', ?, unixepoch())`,
    )
    .bind(json)
    .run();
}

/**
 * Load ensemble state from D1.
 */
export async function loadEnsembleState(
  db: D1Database,
  config?: EnsembleConfig,
): Promise<EnsembleState> {
  const row = await db
    .prepare(`SELECT state_json FROM model_ensemble_state WHERE id = 'default'`)
    .first<{ state_json: string }>();

  if (row) {
    try {
      return JSON.parse(row.state_json) as EnsembleState;
    } catch {
      // Corrupted — start fresh
    }
  }

  return createEnsembleState(config);
}

/**
 * Get a summary of model performance for monitoring.
 */
export function getEnsembleSummary(
  state: EnsembleState,
): Array<{
  modelId: string;
  weight: number;
  ewmaBrier: number;
  observations: number;
  rank: number;
}> {
  return state.models
    .map((m) => ({
      modelId: m.modelId,
      weight: m.weight,
      ewmaBrier: m.ewmaBrier,
      observations: m.observationCount,
      rank: 0,
    }))
    .sort((a, b) => a.ewmaBrier - b.ewmaBrier)
    .map((m, i) => ({ ...m, rank: i + 1 }));
}
