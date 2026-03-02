import { describe, it, expect } from 'vitest';
import { runABM, estimateSlippage } from './abm';

describe('ABM Market Simulator', () => {
  it('runs without errors and returns valid slippage', () => {
    const result = runABM(
      { initialPrice: 150, dailyVolume: 1_000_000, seed: 42 },
      100,
      'buy',
    );

    expect(result.slippage.expectedSlippageBps).toBeGreaterThanOrEqual(0);
    expect(result.slippage.slippage95Bps).toBeGreaterThanOrEqual(0);
    expect(result.slippage.effectiveSpreadBps).toBeCloseTo(10, 0); // 0.001 * 10000
    expect(result.pricePath.length).toBe(501); // 500 steps + initial
    expect(result.computeTimeMs).toBeLessThan(5000);
  });

  it('larger orders have more slippage', () => {
    const small = runABM({ initialPrice: 150, seed: 42 }, 10, 'buy');
    const large = runABM({ initialPrice: 150, seed: 42 }, 10000, 'buy');

    expect(large.slippage.expectedSlippageBps).toBeGreaterThanOrEqual(
      small.slippage.expectedSlippageBps,
    );
  });

  it('is deterministic with same seed', () => {
    const a = runABM({ initialPrice: 100, seed: 123 }, 50, 'buy');
    const b = runABM({ initialPrice: 100, seed: 123 }, 50, 'buy');

    expect(a.slippage.expectedSlippageBps).toBe(b.slippage.expectedSlippageBps);
    expect(a.pricePath).toEqual(b.pricePath);
  });

  it('estimateSlippage convenience works', () => {
    const slip = estimateSlippage(150, 5000, 'buy', 1_000_000, 0.3, 42);
    expect(slip.expectedSlippageBps).toBeGreaterThanOrEqual(0);
    expect(slip.avgFillPrice).toBeGreaterThan(0);
  });

  it('produces reasonable realized volatility', () => {
    const result = runABM(
      { initialPrice: 100, annualizedVol: 0.3, numSteps: 1000, seed: 99 },
      50,
      'buy',
    );
    // Realized vol should be in a reasonable range (not 0, not 10x input)
    expect(result.realizedVol).toBeGreaterThan(0);
    expect(result.realizedVol).toBeLessThan(2);
  });
});
