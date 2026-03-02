/**
 * Agent-Based Market Simulator (ABM)
 *
 * Simulates order book dynamics with three agent types:
 *   - Informed traders: trade on signals (momentum/mean-reversion), market orders
 *   - Noise traders: random walk, provide liquidity and noise
 *   - Market makers: quote bid/ask around fair value, manage inventory risk
 *
 * Purpose: estimate realistic slippage and market impact for a given order size,
 * feeding into execution optimizer and Kelly position sizing.
 *
 * Design constraints:
 *   - Must run in <500ms on CF Workers for 1000-step simulations
 *   - No external dependencies — pure math
 *   - Deterministic with seed for reproducibility
 */

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

  /** Normal(0,1) via Box-Muller */
  normal(): number {
    const u1 = Math.max(1e-10, this.next());
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: number;
  spread: number;
}

export interface ABMConfig {
  /** Number of simulation time steps. Default: 500 */
  numSteps?: number;
  /** Number of informed agents. Default: 5 */
  numInformed?: number;
  /** Number of noise agents. Default: 20 */
  numNoise?: number;
  /** Number of market makers. Default: 3 */
  numMarketMakers?: number;
  /** Initial mid-price. Required. */
  initialPrice: number;
  /** Initial bid-ask spread as fraction of price. Default: 0.001 (10bps) */
  spreadFraction?: number;
  /** Daily volume in shares (used to scale order sizes). Default: 1_000_000 */
  dailyVolume?: number;
  /** Annualized volatility (for noise calibration). Default: 0.3 */
  annualizedVol?: number;
  /** Number of order book levels per side. Default: 5 */
  bookDepth?: number;
  /** PRNG seed for reproducibility */
  seed?: number;
}

export interface SlippageEstimate {
  /** Expected slippage in bps for the given order size */
  expectedSlippageBps: number;
  /** Slippage standard deviation in bps */
  slippageStdBps: number;
  /** 95th percentile slippage (worst-case planning) */
  slippage95Bps: number;
  /** Temporary market impact (bps, reverts after execution) */
  temporaryImpactBps: number;
  /** Permanent market impact (bps, information leakage) */
  permanentImpactBps: number;
  /** Average fill price */
  avgFillPrice: number;
  /** Effective spread paid */
  effectiveSpreadBps: number;
}

export interface ABMResult {
  /** Slippage estimates for the queried order size */
  slippage: SlippageEstimate;
  /** Final order book state */
  finalBook: OrderBook;
  /** Price path (mid-prices at each step) */
  pricePath: number[];
  /** Realized volatility over the simulation */
  realizedVol: number;
  /** Wall-clock computation time (ms) */
  computeTimeMs: number;
}

// ── Order Book Engine ───────────────────────────────────────────────────

function createOrderBook(
  midPrice: number,
  spreadFrac: number,
  depth: number,
  tickSize: number,
  baseSize: number,
  rng: Xoshiro128,
): OrderBook {
  const halfSpread = midPrice * spreadFrac / 2;
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];

  for (let i = 0; i < depth; i++) {
    const offset = halfSpread + i * tickSize;
    // Size increases with distance from mid (more liquidity away from touch)
    const sizeMult = 1 + i * 0.5 + rng.next() * 0.3;
    bids.push({
      price: Math.round((midPrice - offset) * 100) / 100,
      size: Math.round(baseSize * sizeMult),
    });
    asks.push({
      price: Math.round((midPrice + offset) * 100) / 100,
      size: Math.round(baseSize * sizeMult),
    });
  }

  return {
    bids,
    asks,
    midPrice,
    spread: asks[0]!.price - bids[0]!.price,
  };
}

function walkBook(
  levels: OrderBookLevel[],
  orderSize: number,
): { filledSize: number; totalCost: number; levelsConsumed: number } {
  let remaining = orderSize;
  let totalCost = 0;
  let levelsConsumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const fill = Math.min(remaining, level.size);
    totalCost += fill * level.price;
    remaining -= fill;
    levelsConsumed++;
  }

  return { filledSize: orderSize - remaining, totalCost, levelsConsumed };
}

// ── Agent Behaviors ─────────────────────────────────────────────────────

interface Agent {
  type: 'informed' | 'noise' | 'market_maker';
  inventory: number;
  cash: number;
}

function informedAgentAct(
  _agent: Agent,
  _book: OrderBook,
  signal: number,
  rng: Xoshiro128,
  avgOrderSize: number,
): { side: 'buy' | 'sell'; size: number } | null {
  // Trade probability proportional to signal strength
  const absSignal = Math.abs(signal);
  if (rng.next() > absSignal * 2) return null; // skip if signal weak

  const side = signal > 0 ? 'buy' as const : 'sell' as const;
  const size = Math.max(1, Math.round(avgOrderSize * (0.5 + rng.next() * absSignal * 3)));
  return { side, size };
}

function noiseAgentAct(
  _agent: Agent,
  _book: OrderBook,
  rng: Xoshiro128,
  avgOrderSize: number,
): { side: 'buy' | 'sell'; size: number } | null {
  // 30% chance of trading each step
  if (rng.next() > 0.3) return null;

  const side = rng.next() > 0.5 ? 'buy' as const : 'sell' as const;
  const size = Math.max(1, Math.round(avgOrderSize * (0.2 + rng.next() * 0.6)));
  return { side, size };
}

function marketMakerRefresh(
  agent: Agent,
  book: OrderBook,
  rng: Xoshiro128,
  baseSize: number,
  spreadFrac: number,
): void {
  // MM adjusts quotes based on inventory — skew to reduce risk
  const inventorySkew = -agent.inventory * 0.0001; // push price against inventory
  const halfSpread = book.midPrice * spreadFrac / 2;

  // Refresh top of book
  if (book.bids.length > 0) {
    const topBid = book.bids[0]!;
    topBid.price = Math.round((book.midPrice - halfSpread + inventorySkew) * 100) / 100;
    topBid.size = Math.max(topBid.size, Math.round(baseSize * (0.8 + rng.next() * 0.4)));
  }
  if (book.asks.length > 0) {
    const topAsk = book.asks[0]!;
    topAsk.price = Math.round((book.midPrice + halfSpread + inventorySkew) * 100) / 100;
    topAsk.size = Math.max(topAsk.size, Math.round(baseSize * (0.8 + rng.next() * 0.4)));
  }
}

// ── Execute market order against book ───────────────────────────────────

function executeMarketOrder(
  book: OrderBook,
  side: 'buy' | 'sell',
  size: number,
): { avgPrice: number; filled: number } {
  const levels = side === 'buy' ? book.asks : book.bids;
  const { filledSize, totalCost } = walkBook(levels, size);

  if (filledSize === 0) return { avgPrice: book.midPrice, filled: 0 };

  // Remove consumed liquidity
  let remaining = size;
  let i = 0;
  while (remaining > 0 && i < levels.length) {
    const level = levels[i]!;
    if (level.size <= remaining) {
      remaining -= level.size;
      level.size = 0;
      i++;
    } else {
      level.size -= remaining;
      remaining = 0;
    }
  }

  // Update mid-price based on execution
  const bestBid = book.bids.find((l) => l.size > 0)?.price ?? book.midPrice * 0.999;
  const bestAsk = book.asks.find((l) => l.size > 0)?.price ?? book.midPrice * 1.001;
  book.midPrice = (bestBid + bestAsk) / 2;
  book.spread = bestAsk - bestBid;

  return { avgPrice: totalCost / filledSize, filled: filledSize };
}

// ── Main ABM Simulator ──────────────────────────────────────────────────

/**
 * Run ABM simulation and estimate slippage for a given order size.
 *
 * @param config ABM configuration
 * @param queryOrderSize Size of the order to estimate slippage for (in shares)
 * @param querySide 'buy' or 'sell'
 * @param numTrials Number of slippage estimation trials. Default: 50
 */
export function runABM(
  config: ABMConfig,
  queryOrderSize: number,
  querySide: 'buy' | 'sell' = 'buy',
  numTrials: number = 50,
): ABMResult {
  const t0 = performance.now();

  const {
    numSteps = 500,
    numInformed = 5,
    numNoise = 20,
    numMarketMakers = 3,
    initialPrice,
    spreadFraction = 0.001,
    dailyVolume = 1_000_000,
    annualizedVol = 0.3,
    bookDepth = 5,
    seed = Date.now() ^ 0xbeef,
  } = config;

  const rng = new Xoshiro128(seed);

  // Calibrate order sizes: daily volume / steps / total agents ≈ avg order
  const totalAgents = numInformed + numNoise + numMarketMakers;
  const avgOrderSize = Math.max(1, Math.round(dailyVolume / numSteps / totalAgents * 2));
  const tickSize = initialPrice * 0.0001; // 1bps tick
  const baseBookSize = Math.round(dailyVolume / numSteps * 0.5);

  // Daily vol from annualized
  const dailyVol = annualizedVol / Math.sqrt(252);
  const stepVol = dailyVol / Math.sqrt(numSteps);

  // Initialize agents
  const agents: Agent[] = [];
  for (let i = 0; i < numInformed; i++) {
    agents.push({ type: 'informed', inventory: 0, cash: 0 });
  }
  for (let i = 0; i < numNoise; i++) {
    agents.push({ type: 'noise', inventory: 0, cash: 0 });
  }
  for (let i = 0; i < numMarketMakers; i++) {
    agents.push({ type: 'market_maker', inventory: 0, cash: 0 });
  }

  // Initialize book
  let book = createOrderBook(initialPrice, spreadFraction, bookDepth, tickSize, baseBookSize, rng);
  const pricePath: number[] = [initialPrice];

  // Latent signal (mean-reverting around 0)
  let signal = 0;

  // ── Simulation loop ───────────────────────────────────────────────
  for (let step = 0; step < numSteps; step++) {
    // Update signal (Ornstein-Uhlenbeck)
    signal = signal * 0.95 + stepVol * rng.normal() * 0.5;

    // Each agent acts
    for (const agent of agents) {
      let order: { side: 'buy' | 'sell'; size: number } | null = null;

      if (agent.type === 'informed') {
        order = informedAgentAct(agent, book, signal, rng, avgOrderSize);
      } else if (agent.type === 'noise') {
        order = noiseAgentAct(agent, book, rng, avgOrderSize);
      } else {
        // Market makers refresh quotes
        marketMakerRefresh(agent, book, rng, baseBookSize, spreadFraction);
        continue;
      }

      if (order) {
        const result = executeMarketOrder(book, order.side, order.size);
        const cashDelta = order.side === 'buy' ? -result.avgPrice * result.filled : result.avgPrice * result.filled;
        const invDelta = order.side === 'buy' ? result.filled : -result.filled;
        agent.cash += cashDelta;
        agent.inventory += invDelta;
      }
    }

    // Refresh book liquidity (replenish consumed levels) — add noise to mid
    if (step % 10 === 0) {
      const noisyMid = book.midPrice * (1 + stepVol * rng.normal() * 0.3);
      book = createOrderBook(noisyMid, spreadFraction, bookDepth, tickSize, baseBookSize, rng);
    }

    pricePath.push(book.midPrice);
  }

  // ── Slippage estimation (multiple trials on final book state) ──────
  const slippageSamples: number[] = [];
  const prePrices: number[] = [];
  const postPrices: number[] = [];

  for (let trial = 0; trial < numTrials; trial++) {
    // Fresh book for each trial (avoid depleted book bias)
    const trialBook = createOrderBook(
      book.midPrice, spreadFraction, bookDepth, tickSize, baseBookSize, rng,
    );
    const preMid = trialBook.midPrice;

    const { avgPrice, filled } = executeMarketOrder(trialBook, querySide, queryOrderSize);

    if (filled > 0) {
      const slippageBps = querySide === 'buy'
        ? ((avgPrice - preMid) / preMid) * 10_000
        : ((preMid - avgPrice) / preMid) * 10_000;
      slippageSamples.push(slippageBps);
      prePrices.push(preMid);
      postPrices.push(trialBook.midPrice);
    }
  }

  // Compute slippage statistics
  const n = slippageSamples.length;
  const meanSlippage = n > 0 ? slippageSamples.reduce((a, b) => a + b, 0) / n : 0;
  const varSlippage = n > 1
    ? slippageSamples.reduce((s, x) => s + (x - meanSlippage) ** 2, 0) / (n - 1)
    : 0;
  const stdSlippage = Math.sqrt(varSlippage);

  // Sort for percentile
  const sorted = slippageSamples.slice().sort((a, b) => a - b);
  const p95Idx = Math.min(n - 1, Math.floor(n * 0.95));
  const slippage95 = n > 0 ? sorted[p95Idx]! : 0;

  // Impact decomposition
  const avgPreMid = prePrices.length > 0 ? prePrices.reduce((a, b) => a + b, 0) / prePrices.length : book.midPrice;
  const avgPostMid = postPrices.length > 0 ? postPrices.reduce((a, b) => a + b, 0) / postPrices.length : book.midPrice;
  const tempImpactBps = Math.abs((avgPostMid - avgPreMid) / avgPreMid) * 10_000;
  // Permanent impact ~ fraction of temporary (Kyle's lambda model approximation)
  const permImpactBps = tempImpactBps * 0.3;

  const avgFillPrice = n > 0
    ? book.midPrice * (1 + (querySide === 'buy' ? 1 : -1) * meanSlippage / 10_000)
    : book.midPrice;

  // Realized vol
  const logReturns: number[] = [];
  for (let i = 1; i < pricePath.length; i++) {
    const prev = pricePath[i - 1]!;
    const curr = pricePath[i]!;
    if (prev > 0 && curr > 0) {
      logReturns.push(Math.log(curr / prev));
    }
  }
  const rvMean = logReturns.length > 0 ? logReturns.reduce((a, b) => a + b, 0) / logReturns.length : 0;
  const rvVar = logReturns.length > 1
    ? logReturns.reduce((s, x) => s + (x - rvMean) ** 2, 0) / (logReturns.length - 1)
    : 0;
  const realizedVol = Math.sqrt(rvVar * numSteps) * Math.sqrt(252); // annualize

  return {
    slippage: {
      expectedSlippageBps: Math.max(0, meanSlippage),
      slippageStdBps: stdSlippage,
      slippage95Bps: Math.max(0, slippage95),
      temporaryImpactBps: tempImpactBps,
      permanentImpactBps: permImpactBps,
      avgFillPrice,
      effectiveSpreadBps: spreadFraction * 10_000,
    },
    finalBook: book,
    pricePath,
    realizedVol,
    computeTimeMs: performance.now() - t0,
  };
}

/**
 * Estimate slippage for a dollar-notional order.
 * Convenience wrapper that converts notional → shares.
 */
export function estimateSlippage(
  currentPrice: number,
  notionalUsd: number,
  side: 'buy' | 'sell',
  dailyVolume: number,
  annualizedVol: number,
  seed?: number,
): SlippageEstimate {
  const shares = Math.max(1, Math.round(notionalUsd / currentPrice));
  const result = runABM(
    {
      initialPrice: currentPrice,
      dailyVolume,
      annualizedVol,
      seed,
    },
    shares,
    side,
  );
  return result.slippage;
}
