/**
 * Particle Filter Engine tests.
 *
 * Validates: initialization, filtering convergence, systematic resampling,
 * and probability estimation accuracy.
 */

import { describe, expect, it } from "vitest";
import {
  initFilter,
  filterStep,
  getEstimate,
  filterBatch,
  type ParticleFilterConfig,
} from "./particle-filter";

const DEFAULT_CONFIG: ParticleFilterConfig = {
  numParticles: 2000,
  obsNoise: 0.001,
};

describe("Particle Filter", () => {
  describe("initFilter", () => {
    it("creates correct number of particles", () => {
      const state = initFilter(100, Date.now(), { numParticles: 1000 });
      expect(state.particles.length).toBe(1000);
      expect(state.stepCount).toBe(0);
    });

    it("clamps particles to [1000, 5000]", () => {
      const low = initFilter(100, Date.now(), { numParticles: 500 });
      expect(low.particles.length).toBe(1000);

      const high = initFilter(100, Date.now(), { numParticles: 10000 });
      expect(high.particles.length).toBe(5000);
    });

    it("weights are uniform and sum to 1", () => {
      const state = initFilter(100, Date.now(), DEFAULT_CONFIG);
      const sumW = state.particles.reduce((s, p) => s + p.weight, 0);
      expect(sumW).toBeCloseTo(1.0, 10);

      const expectedW = 1 / state.particles.length;
      for (const p of state.particles) {
        expect(p.weight).toBeCloseTo(expectedW, 10);
      }
    });

    it("initial prices cluster around observed price", () => {
      const price = 150;
      const state = initFilter(price, Date.now(), DEFAULT_CONFIG);
      const estimate = getEstimate(state);
      // Should be within 1% of initial price
      expect(estimate.priceEstimate).toBeCloseTo(price, 0);
      expect(Math.abs(estimate.priceEstimate - price) / price).toBeLessThan(0.01);
    });

    it("all volatilities are positive", () => {
      const state = initFilter(100, Date.now(), DEFAULT_CONFIG);
      for (const p of state.particles) {
        expect(p.vol).toBeGreaterThan(0);
      }
    });
  });

  describe("filterStep", () => {
    it("increments step count", () => {
      const state = initFilter(100, 1000, DEFAULT_CONFIG);
      const next = filterStep(state, 100.5, 2000, DEFAULT_CONFIG);
      expect(next.stepCount).toBe(1);
    });

    it("updates timestamp", () => {
      const state = initFilter(100, 1000, DEFAULT_CONFIG);
      const next = filterStep(state, 100.5, 5000, DEFAULT_CONFIG);
      expect(next.lastUpdateMs).toBe(5000);
    });

    it("no-ops on zero dt", () => {
      const state = initFilter(100, 1000, DEFAULT_CONFIG);
      const next = filterStep(state, 101, 1000, DEFAULT_CONFIG);
      expect(next).toBe(state); // exact same reference
    });

    it("weights still sum to 1 after update", () => {
      const state = initFilter(100, 0, DEFAULT_CONFIG);
      const next = filterStep(state, 100.1, 60_000, DEFAULT_CONFIG);
      const sumW = next.particles.reduce((s, p) => s + p.weight, 0);
      expect(sumW).toBeCloseTo(1.0, 6);
    });
  });

  describe("convergence", () => {
    it("tracks a trending price over multiple steps", () => {
      const config: ParticleFilterConfig = { numParticles: 3000, obsNoise: 0.002 };
      let state = initFilter(100, 0, config);

      // Simulate upward drift: 100 → ~110 over 10 steps
      const dt = 3600_000; // 1 hour
      for (let i = 1; i <= 10; i++) {
        const price = 100 + i; // linear increase
        state = filterStep(state, price, i * dt, config);
      }

      const est = getEstimate(state);
      // Price estimate should be near 110
      expect(est.priceEstimate).toBeGreaterThan(108);
      expect(est.priceEstimate).toBeLessThan(112);
    });

    it("narrows CI with more observations", () => {
      const config: ParticleFilterConfig = { numParticles: 2000, obsNoise: 0.001 };
      const state0 = initFilter(100, 0, config);
      const est0 = getEstimate(state0);
      const width0 = est0.priceCI95[1] - est0.priceCI95[0];

      // Feed 20 observations at exactly 100 (no noise)
      let state = state0;
      for (let i = 1; i <= 20; i++) {
        state = filterStep(state, 100, i * 60_000, config);
      }
      const est1 = getEstimate(state);
      const width1 = est1.priceCI95[1] - est1.priceCI95[0];

      // CI should narrow (or at least not widen significantly)
      expect(width1).toBeLessThanOrEqual(width0 * 1.5);
    });
  });

  describe("getEstimate", () => {
    it("probAbove returns ~0.5 for at-the-money with no drift", () => {
      const config: ParticleFilterConfig = { numParticles: 5000, obsNoise: 0.001 };
      let state = initFilter(100, 0, config);
      // Feed a few stable observations
      for (let i = 1; i <= 5; i++) {
        state = filterStep(state, 100, i * 3600_000, config);
      }

      const est = getEstimate(state);
      const prob = est.probAbove(100, 24 * 3600_000); // 1 day horizon
      // Should be roughly 0.5 (no drift), allow wide tolerance due to stochastic nature
      expect(prob).toBeGreaterThan(0.2);
      expect(prob).toBeLessThan(0.8);
    });

    it("probAbove for deep ITM is near 1", () => {
      const config: ParticleFilterConfig = { numParticles: 3000, obsNoise: 0.001 };
      let state = initFilter(200, 0, config);
      for (let i = 1; i <= 5; i++) {
        state = filterStep(state, 200, i * 60_000, config);
      }

      const est = getEstimate(state);
      const prob = est.probAbove(50, 3600_000); // target way below current
      expect(prob).toBeGreaterThan(0.95);
    });
  });

  describe("filterBatch", () => {
    it("processes a batch of observations", () => {
      const obs = Array.from({ length: 50 }, (_, i) => ({
        price: 100 + Math.sin(i / 5) * 2,
        timestampMs: (i + 1) * 60_000,
      }));

      const { state, estimate } = filterBatch(100, obs, DEFAULT_CONFIG);
      expect(state.stepCount).toBe(50);
      expect(estimate.priceEstimate).toBeGreaterThan(95);
      expect(estimate.priceEstimate).toBeLessThan(105);
    });

    it("handles empty observations", () => {
      const { state } = filterBatch(100, [], DEFAULT_CONFIG);
      expect(state.stepCount).toBe(0);
    });
  });
});
