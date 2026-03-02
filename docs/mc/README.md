# Monte Carlo Engine — Documentation

The `src/mc/` module is MAHORAGA's probability engine. It estimates the likelihood of price targets being hit using Monte Carlo simulation, maintains a sequential Bayesian filter for online state estimation, and tracks prediction accuracy via Brier scores.

## Contents

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System diagram, data flow, module relationships |
| [Module Reference](./module-reference.md) | Every file in `src/mc/` with types, exports, and behavior |
| [Tuning Guide](./tuning-guide.md) | Parameter tables with defaults, ranges, and tips |
| [Deployment](./deployment.md) | Setup, secrets, D1/KV, paper → live path |

## Quick Overview

The MC engine has three subsystems:

1. **GBM Path Simulator** (`simulator.ts`) — Estimates P(S_T ≥ K) using variance-reduced Monte Carlo with Halton sequences, antithetic variates, and control variates.
2. **Particle Filter** (`particle-filter.ts`) — Bootstrap filter for online Bayesian estimation of latent market state (price, volatility, drift) from streaming price observations.
3. **Brier Score Tracker** (`brier.ts`) — Records predictions to D1, evaluates them against realized prices, and reports calibration statistics.

All public API is re-exported through `index.ts`.
