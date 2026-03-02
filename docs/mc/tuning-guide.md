# MC Engine Tuning Guide

## Simulator Parameters (`MCSimulationParams`)

| Parameter | Default | Range | Effect | Tips |
|-----------|---------|-------|--------|------|
| `numPaths` | 10,000 | 1,000–100,000 | More paths → narrower CI, longer compute | 10K is the sweet spot for <50ms. 40K gives <1% error vs analytic. Going above 40K has diminishing returns due to VR stack. |
| `impliedVol` | — (required) | 0.01–2.0 | Higher vol → probability moves toward 0.5 (more uncertain) | Source from ATR, Bollinger width, or particle filter's `volEstimate`. Annualized. |
| `horizonMs` | — (required) | 1 min – 1 year | Longer horizon → wider price distribution → probability moves toward 0.5 | Convert to ms: `days * 24 * 3600_000`. |
| `targetPrice` | undefined | Any positive | If omitted, returns fallback probability (0.5) | Always set this for meaningful results. |

### Variance Reduction Behavior

The VR stack (Halton + antithetic + control variate) is automatic — no tuning needed. Empirical VR ratios by moneyness:

| Moneyness | Typical VR Ratio | Notes |
|-----------|-----------------|-------|
| Deep ITM (K << S) | 5–10x | Control variate highly correlated |
| ATM (K ≈ S) | 3–5x | Balanced regime |
| OTM (K > S) | 2–4x | Less correlation, still significant |
| Deep OTM (K >> S) | 1.5–3x | Rare event → harder to reduce variance |
| High vol ATM | 2–4x | Wider distribution dilutes correlation |

## Particle Filter Parameters (`ParticleFilterConfig`)

| Parameter | Default | Range | Effect | Tips |
|-----------|---------|-------|--------|------|
| `numParticles` | 2,000 | 1,000–5,000 | More particles → better approximation, more compute | 2K is good for real-time. 3K+ for backtesting. Clamped to [1000, 5000] internally. |
| `obsNoise` | 0.001 | 0.0001–0.01 | How noisy you believe price observations are | Lower = trust observations more → faster tracking, risk overfitting. Higher = smoother but laggier. 0.001 works for clean exchange data. |
| `volNoise` | 0.05 | 0.01–0.2 | Process noise on volatility state | Higher = vol can change faster. Lower = more stable vol estimates. |
| `driftNoise` | 0.02 | 0.005–0.1 | Process noise on drift state | Higher = drift adapts faster to regime changes. Too high = noisy drift estimates. |
| `essThreshold` | 0.5 | 0.1–0.9 | Fraction of N below which resampling triggers | Lower = resample less often (risk particle degeneracy). Higher = resample more (risk particle impoverishment). 0.5 is standard. |
| `volMeanReversion` | 2.0 | 0.5–10.0 | Speed of vol mean reversion (κ, annualized) | Higher = vol snaps back to long-run faster. Lower = vol can wander more. Typical equity κ ≈ 1–5. |
| `volLongRun` | 0.25 | 0.1–0.8 | Long-run volatility target (σ̄) | Should match the asset class. Equities: 0.15–0.30. Crypto: 0.50–0.80. Penny stocks: 0.40–0.60. |
| `priceNoise` | 0 | — | Not used (derived from particle vol) | Leave at 0. |

### Regime-Specific Presets

#### Low-Vol Equities (SPY, QQQ)
```ts
const config: ParticleFilterConfig = {
  numParticles: 2000,
  obsNoise: 0.0005,
  volNoise: 0.03,
  driftNoise: 0.01,
  volMeanReversion: 3.0,
  volLongRun: 0.18,
};
```

#### High-Vol / Small-Cap
```ts
const config: ParticleFilterConfig = {
  numParticles: 3000,
  obsNoise: 0.002,
  volNoise: 0.08,
  driftNoise: 0.03,
  volMeanReversion: 1.5,
  volLongRun: 0.45,
};
```

#### Crypto
```ts
const config: ParticleFilterConfig = {
  numParticles: 3000,
  obsNoise: 0.003,
  volNoise: 0.10,
  driftNoise: 0.05,
  volMeanReversion: 1.0,
  volLongRun: 0.65,
};
```

## Brier Score Interpretation

| Score | Meaning | Action |
|-------|---------|--------|
| 0.00–0.10 | Excellent calibration | System is well-tuned |
| 0.10–0.20 | Good | Minor tuning may help |
| 0.20–0.25 | Approaching coin-flip | Check vol estimates, horizon assumptions |
| 0.25+ | Worse than random | Something is wrong — vol source, data quality, or model mismatch |

### Diagnosing Poor Calibration

1. **Check per-symbol scores** via `getBrierBySymbol()` — one bad symbol can drag down the average
2. **Vol source**: if using ATR, ensure the lookback period matches the prediction horizon
3. **Horizon mismatch**: very short horizons (<1h) may violate GBM assumptions
4. **Regime change**: after a vol spike, `volLongRun` may need updating
5. **Data quality**: stale prices or wide spreads inflate observation noise

## Performance Budgets

| Operation | Typical Latency | Budget |
|-----------|----------------|--------|
| `runSimulation` (10K paths) | 5–20ms | <50ms |
| `runSimulation` (40K paths) | 20–40ms | <100ms |
| `filterStep` (2K particles) | <1ms | <5ms |
| `filterBatch` (2K particles, 50 obs) | ~20ms | <100ms |
| `initFilter` (2K particles) | <1ms | <5ms |
| `getEstimate` (2K particles) | <1ms | <5ms |
| `evaluateExpiredPredictions` | Depends on pending count | — |
