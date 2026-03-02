# MC Engine Architecture

## System Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │              MAHORAGA Core                   │
                    │  (strategy rules, risk engine, monitoring)   │
                    └──────────┬──────────────┬───────────────────┘
                               │              │
                    ┌──────────▼──────┐  ┌────▼──────────────┐
                    │   index.ts      │  │   Env bindings     │
                    │  (public API)   │  │  DB: D1Database    │
                    └──┬─────┬────┬──┘  └────────────────────┘
                       │     │    │
          ┌────────────▼┐ ┌──▼────▼──────────┐ ┌──────────────┐
          │ simulator.ts│ │particle-filter.ts │ │   brier.ts   │
          │             │ │                   │ │              │
          │ GBM paths   │ │ Bootstrap filter  │ │ D1 tracking  │
          │ Halton QRN  │ │ Stochastic vol    │ │ Brier scores │
          │ Antithetic  │ │ Systematic resamp │ │ Per-symbol   │
          │ Control var │ │ Online Bayesian   │ │ Calibration  │
          └──────┬──────┘ └────────┬──────────┘ └──────┬───────┘
                 │                 │                    │
          ┌──────▼──────┐         │             ┌──────▼───────┐
          │  types.ts   │         │             │ D1 Database  │
          │ MCSimulation│         │             │ mc_predictions│
          │ Params/     │         │             │ table        │
          │ Result      │         │             └──────────────┘
          └─────────────┘         │
                                  │
                          Price observations
                          from market data feed
```

## Data Flow

### 1. One-Shot Probability Estimation (Simulator)

```
Strategy requests P(price ≥ target in T ms)
  → runSimulation(MCSimulationParams)
    → Generate Halton quasi-random pairs (bases 2, 3)
    → Box-Muller → standard normals
    → GBM forward: S_T = S_0 · exp((μ − σ²/2)T + σ√T·Z)
    → Antithetic: simulate Z and -Z
    → Control variate: BS call payoff corrects digital estimate
  → MCSimulationResult { probability, confidenceInterval, pathsSimulated, computeTimeMs }
```

### 2. Online State Estimation (Particle Filter)

```
Market data feed delivers price tick
  → filterStep(state, observedPrice, timestampMs, config)
    → Predict: propagate particles forward
      - Log-price: GBM step with particle's own vol/drift
      - Volatility: Ornstein-Uhlenbeck mean reversion
      - Drift: random walk
    → Update: Gaussian likelihood weighting (log-sum-exp stable)
    → Resample: systematic resampling if ESS < threshold
  → New ParticleFilterState

getEstimate(state)
  → Weighted means for price, vol, drift
  → 95% credible interval (weighted percentile walk)
  → probAbove(target, horizon): forward-simulate from particle cloud
```

### 3. Prediction Tracking (Brier)

```
When MC prediction is made:
  → recordPrediction(db, prediction) → INSERT into mc_predictions

Periodic evaluation job:
  → evaluateExpiredPredictions(db, getPrice)
    → SELECT pending predictions where horizon has passed
    → Fetch actual price at evaluation time
    → outcome = actualPrice > strikePrice ? 1 : 0
    → brierScore = (predictedProb - outcome)²
    → UPDATE mc_predictions with outcome, brier_score

Reporting:
  → getBrierStats(db) → { totalPredictions, evaluatedCount, meanBrierScore, recentBrierScore }
  → getBrierBySymbol(db, days) → per-symbol breakdown sorted by calibration quality
```

## Module Dependencies

| Module | Depends On | Used By |
|--------|-----------|---------|
| `types.ts` | — | `simulator.ts` |
| `simulator.ts` | `types.ts` | `index.ts`, strategy layer |
| `particle-filter.ts` | — (self-contained) | `index.ts`, strategy layer |
| `brier.ts` | D1 (Cloudflare) | `index.ts`, evaluation jobs |
| `index.ts` | all above | everything external |

## Key Design Decisions

- **Zero drift assumption** in simulator (`μ = 0`): conservative — doesn't assume the market trends in your favor.
- **Stochastic volatility** in particle filter: vol is a latent state that mean-reverts, not a fixed input. More realistic than constant-vol GBM.
- **Halton + antithetic + control variate** stack: achieves >3x variance reduction vs crude MC, verified in tests.
- **Systematic resampling**: O(N), low-variance alternative to multinomial resampling. Only triggers when ESS drops below threshold.
- **Brier scoring**: the standard proper scoring rule for binary probabilistic predictions. 0 = perfect, 0.25 = coin flip, 1 = always wrong.
