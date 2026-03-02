/**
 * Student-t Copula Simulator
 *
 * Generates joint return scenarios for 2-8 positions using a Student-t copula.
 * The t-copula captures tail dependence (joint crashes) that Gaussian copulas miss.
 *
 * Algorithm:
 *   1. Cholesky decompose the correlation matrix R
 *   2. For each scenario:
 *      a. Draw Z ~ N(0, I_d) via Box-Muller
 *      b. Draw S ~ chi-squared(v) / v
 *      c. X = L*Z / sqrt(S) gives multivariate t(v, 0, R)
 *      d. Apply t-CDF to get uniform marginals U
 *      e. Map U through marginal distributions (normal inverse) for returns
 *
 * Input: correlation matrix from correlation.ts
 * Output: matrix of joint return scenarios for portfolio VaR
 */

import type { CorrelationMatrix } from "./correlation";

// ── Types ───────────────────────────────────────────────────────────────

export interface CopulaConfig {
  /** Degrees of freedom for t-copula (4-8, lower = heavier tails). Default: 5 */
  degreesOfFreedom?: number;
  /** Number of joint scenarios to simulate. Default: 10_000 */
  numScenarios?: number;
  /** Per-asset annualized volatilities (same order as correlation matrix symbols) */
  vols: number[];
  /** Per-asset expected daily returns (same order). Default: 0 for all */
  expectedReturns?: number[];
}

export interface CopulaResult {
  /** symbols[i] labels column i */
  symbols: string[];
  /** scenarios[i][j] = daily return of asset j in scenario i */
  scenarios: number[][];
  /** Degrees of freedom used */
  degreesOfFreedom: number;
  /** Wall-clock computation time (ms) */
  computeTimeMs: number;
}

// ── PRNG (xoshiro128**) ─────────────────────────────────────────────────

class Xoshiro128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let z = seed >>> 0;
    const vals: number[] = [];
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      vals.push(t >>> 0);
    }
    this.s0 = vals[0]!;
    this.s1 = vals[1]!;
    this.s2 = vals[2]!;
    this.s3 = vals[3]!;
  }

  next(): number {
    const result = Math.imul(this.s1 * 5, 7) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return (result >>> 0) / 4294967296;
  }

  normalPair(): [number, number] {
    const u1 = Math.max(1e-10, this.next());
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return [r * Math.cos(theta), r * Math.sin(theta)];
  }

  gamma(shape: number): number {
    if (shape < 1) {
      return this.gamma(shape + 1) * Math.pow(this.next(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normalPair()[0];
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  chiSquared(df: number): number {
    return 2 * this.gamma(df / 2);
  }
}

// ── Cholesky decomposition ──────────────────────────────────────────────

export function cholesky(matrix: number[], n: number): number[] {
  const L = new Array<number>(n * n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i * n + k]! * L[j * n + k]!;
      }
      if (i === j) {
        const diag = matrix[i * n + i]! - sum;
        if (diag <= 0) {
          return choleskyRegularized(matrix, n);
        }
        L[i * n + j] = Math.sqrt(diag);
      } else {
        L[i * n + j] = (matrix[i * n + j]! - sum) / L[j * n + j]!;
      }
    }
  }
  return L;
}

function choleskyRegularized(matrix: number[], n: number): number[] {
  const reg = matrix.slice();
  for (let eps = 1e-6; eps < 1; eps *= 10) {
    for (let i = 0; i < n; i++) {
      reg[i * n + i] = matrix[i * n + i]! + eps;
    }
    try {
      return choleskyStrict(reg, n);
    } catch {
      continue;
    }
  }
  const I = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  return I;
}

function choleskyStrict(matrix: number[], n: number): number[] {
  const L = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * n + k]! * L[j * n + k]!;
      if (i === j) {
        const diag = matrix[i * n + i]! - sum;
        if (diag <= 0) throw new Error("Not PD");
        L[i * n + j] = Math.sqrt(diag);
      } else {
        L[i * n + j] = (matrix[i * n + j]! - sum) / L[j * n + j]!;
      }
    }
  }
  return L;
}

// ── Student-t CDF ───────────────────────────────────────────────────────

function studentTCdf(x: number, nu: number): number {
  if (nu <= 0) return 0.5;
  const t2 = x * x;
  const beta = regularizedBeta(nu / 2, 0.5, nu / (nu + t2));
  return x >= 0 ? 1 - 0.5 * beta : 0.5 * beta;
}

function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(b, a, 1 - x);
  }

  const lnPrefix =
    a * Math.log(x) + b * Math.log(1 - x) - Math.log(a) - lnBeta(a, b);
  const prefix = Math.exp(lnPrefix);

  let f = 1;
  let C = 1;
  let D = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(D) < 1e-30) D = 1e-30;
  D = 1 / D;
  f = D;

  for (let m = 1; m <= 200; m++) {
    let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    D = 1 + num * D;
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D;
    C = 1 + num / C;
    if (Math.abs(C) < 1e-30) C = 1e-30;
    f *= D * C;

    num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    D = 1 + num * D;
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D;
    C = 1 + num / C;
    if (Math.abs(C) < 1e-30) C = 1e-30;
    const delta = D * C;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return prefix * f * a;
}

function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

function lnGamma(x: number): number {
  if (x <= 0) return 0;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const xx = x - 1;
  let acc = c[0]!;
  for (let i = 1; i < g + 2; i++) {
    acc += c[i]! / (xx + i);
  }
  const t = xx + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(acc);
}

// ── Inverse normal CDF ─────────────────────────────────────────────────

function normalInvCdf(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (Math.abs(p - 0.5) < 1e-15) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const cc = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((cc[0]! * q + cc[1]!) * q + cc[2]!) * q + cc[3]!) * q + cc[4]!) * q + cc[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((cc[0]! * q + cc[1]!) * q + cc[2]!) * q + cc[3]!) * q + cc[4]!) * q + cc[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  );
}

// ── Main copula simulator ───────────────────────────────────────────────

export function simulateCopula(
  corrMatrix: CorrelationMatrix,
  config: CopulaConfig,
  seed?: number
): CopulaResult {
  const start = Date.now();
  const nu = Math.max(4, Math.min(8, config.degreesOfFreedom ?? 5));
  const numScenarios = config.numScenarios ?? 10_000;
  const dim = corrMatrix.symbols.length;

  if (dim < 2 || dim > 8) {
    throw new Error(`Copula supports 2-8 assets, got ${dim}`);
  }
  if (config.vols.length !== dim) {
    throw new Error(`vols length ${config.vols.length} doesn't match ${dim} assets`);
  }

  const expectedReturns = config.expectedReturns ?? new Array<number>(dim).fill(0);
  const rng = new Xoshiro128(seed ?? (Date.now() ^ 0xdeadbeef));

  const L = cholesky(corrMatrix.values, dim);

  const dailyVols = config.vols.map((v) => v / Math.sqrt(252));
  const dailyMu = expectedReturns.map((r) => r / 252);

  const scenarios: number[][] = [];

  for (let s = 0; s < numScenarios; s++) {
    const Z = new Array<number>(dim);
    for (let i = 0; i < dim; i += 2) {
      const [z1, z2] = rng.normalPair();
      Z[i] = z1;
      if (i + 1 < dim) Z[i + 1] = z2;
    }

    const Y = new Array<number>(dim);
    for (let i = 0; i < dim; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) {
        sum += L[i * dim + j]! * Z[j]!;
      }
      Y[i] = sum;
    }

    const S = rng.chiSquared(nu) / nu;
    const sqrtS = Math.sqrt(S);

    const returns = new Array<number>(dim);
    for (let i = 0; i < dim; i++) {
      const tVal = Y[i]! / sqrtS;
      const u = studentTCdf(tVal, nu);
      const z = normalInvCdf(u);
      returns[i] = dailyMu[i]! + dailyVols[i]! * z;
    }

    scenarios.push(returns);
  }

  return {
    symbols: corrMatrix.symbols,
    scenarios,
    degreesOfFreedom: nu,
    computeTimeMs: Date.now() - start,
  };
}

export function simulateCopulaFlat(
  symbols: string[],
  vols: number[],
  flatCorrelation: number,
  config?: Partial<CopulaConfig>,
  seed?: number
): CopulaResult {
  const n = symbols.length;
  const values = new Array<number>(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      values[i * n + j] = i === j ? 1 : flatCorrelation;
    }
  }

  const matrix: CorrelationMatrix = {
    symbols,
    values,
    observationCount: 20,
    updatedAt: Date.now(),
  };

  return simulateCopula(matrix, { vols, ...config }, seed);
}
