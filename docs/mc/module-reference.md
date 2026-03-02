# MC Module Reference

Complete documentation of every file in `src/mc/`.

---

## `types.ts`

Shared type definitions for the MC simulation interface.

### Types

#### `MCSimulationParams`

Input parameters for a simulation run.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `currentPrice` | `number` | ✅ | Current asset price |
| `impliedVol` | `number` | ✅ | Annualized volatility estimate (e.g., from ATR or Bollinger width) |
| `horizonMs` | `number` | ✅ | Simulation time horizon in milliseconds |
| `targetPrice` | `number` | ❌ | Target price for binary outcome (profit if price ≥ target) |
| `numPaths` | `number` | ❌ | Number of simulation paths (default: 10,000) |

#### `MCSimulationResult`

Output of a simulation run.

| Field | Type | Description |
|-------|------|-------------|
| `probability` | `number` | Estimated probability of profitable outcome [0, 1] |
| `confidenceInterval` | `[number, number]` | 95% CI for the probability estimate |
| `pathsSimulated` | `number` | Actual paths simulated (may differ from requested due to antithetic doubling) |
| `computeTimeMs` | `number` | Wall-clock simulation time in ms |

---

## `simulator.ts`

GBM path simulator with a three-layer variance reduction stack.

### Model

Geometric Brownian Motion:
```
S_T = S_0 · exp((μ − σ²/2)T + σ√T · Z)
```
- Drift `μ = 0` (conservative, no directional assumption)
- Estimand: P(S_T ≥ K) — probability of reaching target price

### Variance Reduction Stack

1. **Halton quasi-random sequences** (bases 2 and 3) — low-discrepancy sampling replaces pseudo-random uniform draws, providing more uniform coverage of the probability space.
2. **Antithetic variates** — each normal Z is paired with -Z, doubling paths per Halton point (4 paths total: z1, z2, -z1, -z2).
3. **Control variates** — BS call payoff `max(S_T - K, 0)` serves as a control. Its analytic expectation is known (Black-Scholes formula). Regression coefficient β is computed from sample covariance to correct the digital payoff estimate.

Empirically achieves >3x variance reduction vs crude MC at 10K paths.

### Exports

#### `runSimulation(params: MCSimulationParams, fallbackConfidence?: number): MCSimulationResult`

Main entry point. Runs the full VR simulation pipeline.

- Returns fallback result (probability = `fallbackConfidence` or 0.5) for degenerate inputs: missing `targetPrice`, zero vol, or zero horizon.
- Each Halton point generates 4 paths (Box-Muller pair × antithetic).
- Actual `pathsSimulated` = `ceil(numPaths / 4) * 4`.
- CI uses control-variate-adjusted variance estimate.
- Performance: <50ms for 10K paths (verified in tests).

#### `bsDigitalProb(S, K, vol, T, mu?): number`

Black-Scholes digital call probability: P(S_T ≥ K) = N(d₂). Used internally and exported for testing.

#### `bsCallExpected(S, K, vol, T, mu?): number`

BS call expected value: E[max(S_T - K, 0)]. Used as the control variate's analytic expectation.

#### `normalCDF(x): number`

Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation. |ε| < 1.5e-7.

### Internal Functions

| Function | Purpose |
|----------|---------|
| `halton(n, base)` | Halton sequence value at index n in given base, returns (0, 1) |
| `boxMuller(u1, u2)` | Transforms two uniforms into two standard normals |

---

## `particle-filter.ts`

Bootstrap particle filter (Sequential Monte Carlo) for online Bayesian state estimation.

### State Model

Three-dimensional latent state:
- **Log-price**: GBM step with particle-specific vol and drift
- **Volatility**: Ornstein-Uhlenbeck mean reversion toward `volLongRun`
- **Drift**: Random walk

Observation model: noisy price observations with Gaussian likelihood.

### Types

#### `Particle`

| Field | Type | Description |
|-------|------|-------------|
| `logPrice` | `number` | Log of estimated price |
| `vol` | `number` | Annualized volatility (stochastic) |
| `drift` | `number` | Annualized drift |
| `weight` | `number` | Normalized importance weight |

#### `ParticleFilterConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `numParticles` | `number` | 2000 | Number of particles (clamped to [1000, 5000]) |
| `priceNoise` | `number` | 0 (derived from vol) | Process noise for log-price |
| `volNoise` | `number` | 0.05 | Process noise for volatility |
| `driftNoise` | `number` | 0.02 | Process noise for drift |
| `obsNoise` | `number` | 0.001 | Observation noise std dev |
| `essThreshold` | `number` | 0.5 | ESS fraction triggering resampling |
| `volMeanReversion` | `number` | 2.0 | Vol mean-reversion speed (annualized, κ) |
| `volLongRun` | `number` | 0.25 | Long-run volatility target (σ̄) |

#### `ParticleFilterState`

| Field | Type | Description |
|-------|------|-------------|
| `particles` | `Particle[]` | Current particle cloud |
| `lastUpdateMs` | `number` | Timestamp of last update (ms) |
| `stepCount` | `number` | Number of observations processed |

#### `FilterEstimate`

| Field | Type | Description |
|-------|------|-------------|
| `priceEstimate` | `number` | Weighted mean price |
| `volEstimate` | `number` | Weighted mean volatility |
| `driftEstimate` | `number` | Weighted mean drift |
| `ess` | `number` | Effective sample size |
| `priceCI95` | `[number, number]` | 95% credible interval for price |
| `probAbove` | `(target, horizonMs) => number` | Forward-simulate probability of exceeding target |

### Exports

#### `initFilter(initialPrice, timestampMs, config?): ParticleFilterState`

Initialize filter with prior centered on observed price. Volatilities drawn around `volLongRun`, clamped to ≥0.01. Weights are uniform.

#### `filterStep(state, observedPrice, timestampMs, config?): ParticleFilterState`

Process one price observation. Pipeline:
1. **Predict**: propagate particles forward by `dt` (time since last update, converted to years)
2. **Update weights**: Gaussian likelihood with log-sum-exp numerical stability
3. **Resample**: systematic resampling if ESS < `essThreshold × numParticles`

Returns same state reference (no-op) if `dt ≤ 0`.

#### `getEstimate(state): FilterEstimate`

Extract weighted statistics from particle cloud. The `probAbove` method forward-simulates each particle using GBM to estimate P(S_T ≥ target).

#### `filterBatch(initialPrice, observations, config?): { state, estimate }`

Batch-process a sequence of `{ price, timestampMs }` observations. Useful for backtesting or catching up on historical data.

### Internal Functions

| Function | Purpose |
|----------|---------|
| `randn()` | Box-Muller standard normal sample |
| `predict(particles, dtYears, cfg)` | In-place particle propagation (GBM + OU vol + RW drift) |
| `updateWeights(particles, observedLogPrice, obsNoise)` | Gaussian likelihood weighting with log-sum-exp |
| `computeESS(particles)` | Effective sample size: 1 / Σ(w²) |
| `systematicResample(particles)` | O(N) low-variance resampling via CDF walk |
| `computeProbAbove(particles, target, horizonMs)` | Forward GBM from each particle to estimate exceedance probability |

---

## `brier.ts`

Prediction tracking and calibration scoring using Brier scores against a D1 database.

### Types

#### `MCPrediction`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique prediction ID |
| `symbol` | `string` | Ticker symbol |
| `predictedProb` | `number` | MC-estimated probability [0, 1] |
| `strikePrice` | `number` | Target price |
| `horizonMs` | `number` | Prediction horizon in ms |
| `currentPriceAtPrediction` | `number` | Price when prediction was made |

#### `BrierStats`

| Field | Type | Description |
|-------|------|-------------|
| `totalPredictions` | `number` | All-time prediction count |
| `evaluatedCount` | `number` | Predictions with resolved outcomes |
| `pendingCount` | `number` | Awaiting expiry |
| `meanBrierScore` | `number \| null` | All-time average Brier score |
| `recentBrierScore` | `number \| null` | Last 30 days average |

### Exports

#### `recordPrediction(db: D1Database, prediction: MCPrediction): Promise<void>`

Insert a new prediction into the `mc_predictions` table.

#### `evaluateExpiredPredictions(db: D1Database, getPrice): Promise<number>`

Evaluate all pending predictions whose horizon has passed. For each:
- Fetch actual price at `created_at + horizon_ms`
- Compute `outcome = actualPrice > strikePrice ? 1 : 0`
- Compute `brierScore = (predictedProb - outcome)²`
- Update row with outcome, score, evaluation timestamp, and actual price

Returns count of newly evaluated predictions. Skips predictions where `getPrice` returns `null`.

#### `getBrierStats(db: D1Database): Promise<BrierStats>`

Aggregate statistics across all predictions.

#### `getBrierBySymbol(db: D1Database, days?: number): Promise<Array<{ symbol, count, avgBrier }>>`

Per-symbol Brier scores for the last N days (default: 30). Sorted ascending by `avgBrier` (best-calibrated symbols first).

### D1 Schema

The `mc_predictions` table (implied from queries):

```sql
CREATE TABLE mc_predictions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  predicted_prob REAL NOT NULL,
  strike_price REAL NOT NULL,
  horizon_ms INTEGER NOT NULL,
  current_price_at_prediction REAL NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  outcome INTEGER,          -- NULL until evaluated; 0 or 1
  brier_score REAL,         -- NULL until evaluated
  evaluated_at INTEGER,     -- Unix timestamp of evaluation
  actual_price_at_evaluation REAL
);
```

---

## `index.ts`

Public barrel export. Re-exports all public functions and types from the three modules.

### Re-exported from `simulator.ts`
- `runSimulation`

### Re-exported from `particle-filter.ts`
- `initFilter`, `filterStep`, `getEstimate`, `filterBatch`
- Types: `Particle`, `ParticleFilterConfig`, `ParticleFilterState`, `FilterEstimate`

### Re-exported from `brier.ts`
- `recordPrediction`, `evaluateExpiredPredictions`, `getBrierStats`, `getBrierBySymbol`
- Types: `MCPrediction`, `BrierStats`

---

## Test Files

### `particle-filter.test.ts`

Vitest suite covering:
- Initialization (particle count, clamping, uniform weights, price clustering, positive vol)
- Filter step mechanics (step count, timestamp update, no-op on zero dt, weight normalization)
- Convergence (tracks trending price, CI narrows with observations)
- Estimate quality (`probAbove` ~0.5 ATM, ~1.0 deep ITM)
- Batch processing

### `simulator.test.ts`

Vitest suite covering:
- Accuracy vs BS analytic (<1% absolute error at 40K paths)
- Empirical variance reduction ratio (>2x vs crude MC)
- Degenerate input handling (missing target, zero vol, zero horizon)
- Performance (<50ms for 10K paths)
- CI narrowing with more paths
- VR diagnostics across moneyness levels
