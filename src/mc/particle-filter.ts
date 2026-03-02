/**
 * Particle Filter Engine (Bootstrap Filter)
 *
 * Sequential Monte Carlo for online Bayesian estimation of latent market states.
 * Uses systematic resampling to combat particle degeneracy.
 *
 * State model: [log-price, volatility, drift]
 * Observation: noisy price observations
 *
 * Configurable 1K–5K particles. Default: 2000.
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface Particle {
  /** Log-price */
  logPrice: number;
  /** Annualized volatility (stochastic vol) */
  vol: number;
  /** Annualized drift */
  drift: number;
  /** Normalized weight */
  weight: number;
}

export interface ParticleFilterConfig {
  /** Number of particles (1000–5000, default 2000) */
  numParticles?: number;
  /** Process noise for log-price (default: derived from vol) */
  priceNoise?: number;
  /** Process noise for volatility (default: 0.05) */
  volNoise?: number;
  /** Process noise for drift (default: 0.02) */
  driftNoise?: number;
  /** Observation noise std dev (default: 0.001) */
  obsNoise?: number;
  /** Effective sample size threshold for resampling (fraction, default: 0.5) */
  essThreshold?: number;
  /** Vol mean-reversion speed (default: 2.0, annualized) */
  volMeanReversion?: number;
  /** Long-run vol target (default: 0.25) */
  volLongRun?: number;
}

export interface ParticleFilterState {
  particles: Particle[];
  /** Timestamp of last update (ms) */
  lastUpdateMs: number;
  /** Number of observations processed */
  stepCount: number;
}

export interface FilterEstimate {
  /** Weighted mean price */
  priceEstimate: number;
  /** Weighted mean volatility */
  volEstimate: number;
  /** Weighted mean drift */
  driftEstimate: number;
  /** Effective sample size */
  ess: number;
  /** 95% credible interval for price */
  priceCI95: [number, number];
  /** Probability price exceeds target */
  probAbove: (target: number, horizonMs: number) => number;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULTS: Required<ParticleFilterConfig> = {
  numParticles: 2000,
  priceNoise: 0, // derived from particle vol
  volNoise: 0.05,
  driftNoise: 0.02,
  obsNoise: 0.001,
  essThreshold: 0.5,
  volMeanReversion: 2.0,
  volLongRun: 0.25,
};

// ── Random number generation ────────────────────────────────────────────

/** Box-Muller transform for standard normal samples */
function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(1e-15, u1))) * Math.cos(2 * Math.PI * u2);
}

// ── Core functions ──────────────────────────────────────────────────────

/**
 * Initialize particle filter with prior distribution centered on observed price.
 */
export function initFilter(
  initialPrice: number,
  timestampMs: number,
  config?: ParticleFilterConfig,
): ParticleFilterState {
  const cfg = { ...DEFAULTS, ...config };
  const N = Math.max(1000, Math.min(5000, cfg.numParticles));
  const logP0 = Math.log(initialPrice);
  const w = 1 / N;

  const particles: Particle[] = [];
  for (let i = 0; i < N; i++) {
    particles.push({
      logPrice: logP0 + cfg.obsNoise * randn(),
      vol: cfg.volLongRun + cfg.volNoise * randn(),
      drift: cfg.driftNoise * randn(),
      weight: w,
    });
  }

  // Clamp vol to positive
  for (const p of particles) {
    p.vol = Math.max(0.01, p.vol);
  }

  return { particles, lastUpdateMs: timestampMs, stepCount: 0 };
}

/**
 * Predict step: propagate particles forward by dt using stochastic vol model.
 *
 * log-price: X_t = X_{t-1} + (drift - vol²/2)·dt + vol·√dt·Z₁
 * vol:       σ_t = σ_{t-1} + κ(σ̄ - σ_{t-1})·dt + η·√dt·Z₂
 * drift:     μ_t = μ_{t-1} + ξ·√dt·Z₃
 */
function predict(
  particles: Particle[],
  dtYears: number,
  cfg: Required<ParticleFilterConfig>,
): void {
  const sqrtDt = Math.sqrt(dtYears);

  for (const p of particles) {
    // Volatility evolves with mean reversion (Ornstein-Uhlenbeck)
    const volInnovation = cfg.volNoise * sqrtDt * randn();
    p.vol += cfg.volMeanReversion * (cfg.volLongRun - p.vol) * dtYears + volInnovation;
    p.vol = Math.max(0.01, p.vol); // floor

    // Drift random walk
    p.drift += cfg.driftNoise * sqrtDt * randn();

    // Log-price GBM step
    const priceInnovation = p.vol * sqrtDt * randn();
    p.logPrice += (p.drift - 0.5 * p.vol * p.vol) * dtYears + priceInnovation;
  }
}

/**
 * Update weights using Gaussian likelihood of observed price.
 */
function updateWeights(
  particles: Particle[],
  observedLogPrice: number,
  obsNoise: number,
): void {
  const invVar = 1 / (obsNoise * obsNoise);
  let maxLogW = -Infinity;

  // Compute log-weights first for numerical stability
  const logWeights: number[] = new Array(particles.length);
  for (let i = 0; i < particles.length; i++) {
    const diff = particles[i]!.logPrice - observedLogPrice;
    logWeights[i] = Math.log(Math.max(1e-300, particles[i]!.weight)) - 0.5 * invVar * diff * diff;
    if (logWeights[i]! > maxLogW) maxLogW = logWeights[i]!;
  }

  // Exponentiate with log-sum-exp trick
  let sumW = 0;
  for (let i = 0; i < particles.length; i++) {
    particles[i]!.weight = Math.exp(logWeights[i]! - maxLogW);
    sumW += particles[i]!.weight;
  }

  // Normalize
  if (sumW > 0) {
    for (const p of particles) {
      p.weight /= sumW;
    }
  }
}

/**
 * Compute effective sample size: ESS = 1 / Σ(w²)
 */
function computeESS(particles: Particle[]): number {
  let sumW2 = 0;
  for (const p of particles) {
    sumW2 += p.weight * p.weight;
  }
  return sumW2 > 0 ? 1 / sumW2 : 0;
}

/**
 * Systematic resampling — O(N), low variance.
 *
 * Draw one uniform u ~ [0, 1/N), then deterministically select particles
 * at u, u + 1/N, u + 2/N, ... This minimizes resampling variance.
 */
function systematicResample(particles: Particle[]): Particle[] {
  const N = particles.length;
  const w = 1 / N;

  // Build CDF
  const cdf: number[] = new Array(N);
  cdf[0] = particles[0]!.weight;
  for (let i = 1; i < N; i++) {
    cdf[i] = cdf[i - 1]! + particles[i]!.weight;
  }

  const u0 = Math.random() * w;
  const resampled: Particle[] = new Array(N);
  let j = 0;

  for (let i = 0; i < N; i++) {
    const target = u0 + i * w;
    while (j < N - 1 && cdf[j]! < target) j++;
    resampled[i] = {
      logPrice: particles[j]!.logPrice,
      vol: particles[j]!.vol,
      drift: particles[j]!.drift,
      weight: w,
    };
  }

  return resampled;
}

/**
 * Process a new price observation — the main filter step.
 *
 * Performs: predict → update weights → (conditionally) resample.
 */
export function filterStep(
  state: ParticleFilterState,
  observedPrice: number,
  timestampMs: number,
  config?: ParticleFilterConfig,
): ParticleFilterState {
  const cfg = { ...DEFAULTS, ...config };

  const dtMs = timestampMs - state.lastUpdateMs;
  if (dtMs <= 0) return state; // no time elapsed

  const dtYears = dtMs / (365.25 * 24 * 3600_000);
  const observedLogPrice = Math.log(observedPrice);

  // 1. Predict
  predict(state.particles, dtYears, cfg);

  // 2. Update weights
  updateWeights(state.particles, observedLogPrice, cfg.obsNoise);

  // 3. Resample if ESS drops below threshold
  const ess = computeESS(state.particles);
  let particles = state.particles;
  if (ess < cfg.essThreshold * cfg.numParticles) {
    particles = systematicResample(particles);
  }

  return {
    particles,
    lastUpdateMs: timestampMs,
    stepCount: state.stepCount + 1,
  };
}

/**
 * Extract weighted estimates from current particle cloud.
 */
export function getEstimate(state: ParticleFilterState): FilterEstimate {
  const { particles } = state;
  let meanLogP = 0, meanVol = 0, meanDrift = 0;

  for (const p of particles) {
    meanLogP += p.weight * p.logPrice;
    meanVol += p.weight * p.vol;
    meanDrift += p.weight * p.drift;
  }

  // Weighted percentiles for CI (sort by logPrice, walk CDF)
  const sorted = [...particles].sort((a, b) => a.logPrice - b.logPrice);
  let cumW = 0;
  let lo = sorted[0]!.logPrice;
  let hi = sorted[sorted.length - 1]!.logPrice;
  let foundLo = false, foundHi = false;

  for (const p of sorted) {
    cumW += p.weight;
    if (!foundLo && cumW >= 0.025) {
      lo = p.logPrice;
      foundLo = true;
    }
    if (!foundHi && cumW >= 0.975) {
      hi = p.logPrice;
      foundHi = true;
    }
  }

  const ess = computeESS(particles);

  return {
    priceEstimate: Math.exp(meanLogP),
    volEstimate: meanVol,
    driftEstimate: meanDrift,
    ess,
    priceCI95: [Math.exp(lo), Math.exp(hi)],
    probAbove: (target: number, horizonMs: number) => {
      return computeProbAbove(particles, target, horizonMs);
    },
  };
}

/**
 * Forward-simulate each particle to estimate P(S_T ≥ target).
 * Uses current particle states as starting conditions.
 */
function computeProbAbove(
  particles: Particle[],
  target: number,
  horizonMs: number,
): number {
  const logTarget = Math.log(target);
  const T = horizonMs / (365.25 * 24 * 3600_000);
  const sqrtT = Math.sqrt(T);
  let probSum = 0;

  for (const p of particles) {
    // Forward GBM from particle state
    const futureLogP = p.logPrice + (p.drift - 0.5 * p.vol * p.vol) * T + p.vol * sqrtT * randn();
    if (futureLogP >= logTarget) {
      probSum += p.weight;
    }
  }

  return probSum;
}

// ── Batch processing ────────────────────────────────────────────────────

/**
 * Process a sequence of price observations through the filter.
 * Useful for backtesting or catching up on historical data.
 */
export function filterBatch(
  initialPrice: number,
  observations: Array<{ price: number; timestampMs: number }>,
  config?: ParticleFilterConfig,
): { state: ParticleFilterState; estimate: FilterEstimate } {
  if (observations.length === 0) {
    const state = initFilter(initialPrice, Date.now(), config);
    return { state, estimate: getEstimate(state) };
  }

  let state = initFilter(initialPrice, observations[0]!.timestampMs - 1, config);

  for (const obs of observations) {
    state = filterStep(state, obs.price, obs.timestampMs, config);
  }

  return { state, estimate: getEstimate(state) };
}
