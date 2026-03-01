# Variance Reduction Stack — Expectations & Methodology

## Techniques Applied

1. **Halton quasi-random sequences** (bases 2 & 3) — replace pseudorandom uniform draws with low-discrepancy sequences for better space coverage
2. **Antithetic variates** — pair each normal Z with -Z, halving independent draws and inducing negative correlation
3. **Control variates** — use the BS call payoff E[max(S_T-K, 0)] (analytically known) to correct the digital payoff estimate

## Realistic VR Expectations by Moneyness

Results below are for 10K paths, 1-week horizon, vol = 0.30 unless noted.

| Moneyness | Example (S/K) | BS Prob | CI half-width | Crude CI half-width | VR Ratio |
|-----------|--------------|---------|---------------|---------------------|----------|
| Deep ITM  | 100/90       | 99.4%   | ±0.15%        | ±0.15%              | ~1.0x    |
| ATM       | 100/100      | 49.2%   | ±0.72%        | ±0.98%              | ~1.4x    |
| OTM       | 100/105      | 11.6%   | ±0.43%        | ±0.63%              | ~1.5x    |
| Deep OTM  | 100/115      | 0.04%   | ±0.02%        | ±0.04%              | ~2.3x    |
| High vol ATM (σ=0.6) | 100/100 | 48.3% | ±0.72% | ±0.98%              | ~1.4x    |

### Why the VR ratio varies

- **Deep ITM:** Nearly all paths hit → variance is already tiny → little room for VR improvement
- **ATM:** Control variate correlation with digital payoff is moderate. Halton + antithetic provide the main gains
- **OTM/Deep OTM:** Control variate correlation improves (call payoff ↔ digital payoff more correlated near the boundary), but absolute CI is already small
- **The 32-35x headline number** comes from comparing deterministic (Halton-based) vs stochastic (pseudorandom) simulators across multiple trial runs. The Halton sequence is deterministic — running it twice gives the same answer — so its "variance across trials" is near zero. This overstates the effective VR ratio for a single estimate's confidence interval.

### Honest assessment

The per-run CI-based VR ratio is **1.0–2.3x**, not 50–100x. The 35x number reflects deterministic reproducibility, not narrower confidence intervals.

For practical accuracy improvement at fixed path count, the stack delivers:
- **<0.02% absolute error** vs BS analytic at 40K paths (all tested scenarios)
- **Sub-1% CI widths** across all moneyness levels at 10K paths
- **Deterministic results** — same inputs always produce same output (no seed sensitivity)

The determinism alone is arguably more valuable than raw VR for a production system: it eliminates simulation noise from decision-making.

## Paths to Higher VR (Future Work)

- **Importance sampling** — shift the sampling distribution toward the strike, especially for deep OTM. Can deliver 10-100x for tail probabilities.
- **Stratified sampling on the payoff dimension** — force a fixed fraction of paths to land above/below strike.
- **Quasi-random + scrambling** — randomized Halton (Owen scrambling) preserves error rates while enabling honest CI estimation.
