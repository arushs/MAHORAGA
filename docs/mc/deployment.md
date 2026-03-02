# MC Engine Deployment

## Platform

MAHORAGA runs on **Cloudflare Workers** with the following bindings (from `src/env.d.ts`):

| Binding | Type | Used By MC |
|---------|------|-----------|
| `DB` | D1Database | `brier.ts` — prediction storage and scoring |
| `CACHE` | KVNamespace | Not directly by MC (used by other modules) |
| `ARTIFACTS` | R2Bucket | Not directly by MC |
| `SESSION` | DurableObjectNamespace | Not directly by MC |

The simulator and particle filter are **pure compute** — no I/O bindings needed. Only `brier.ts` requires the D1 database.

## D1 Setup

### Create the predictions table

```sql
CREATE TABLE IF NOT EXISTS mc_predictions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  predicted_prob REAL NOT NULL,
  strike_price REAL NOT NULL,
  horizon_ms INTEGER NOT NULL,
  current_price_at_prediction REAL NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  outcome INTEGER,
  brier_score REAL,
  evaluated_at INTEGER,
  actual_price_at_evaluation REAL
);

-- Index for finding expired pending predictions
CREATE INDEX IF NOT EXISTS idx_mc_predictions_pending
  ON mc_predictions(outcome, created_at)
  WHERE outcome IS NULL;

-- Index for per-symbol Brier queries
CREATE INDEX IF NOT EXISTS idx_mc_predictions_symbol_eval
  ON mc_predictions(symbol, evaluated_at)
  WHERE outcome IS NOT NULL;
```

Apply via Wrangler:
```bash
npx wrangler d1 execute <DB_NAME> --file=migrations/mc_predictions.sql
```

## Required Secrets

The MC engine itself needs **no secrets**. It's pure math + D1.

However, the broader MAHORAGA system requires these (from `env.d.ts`):

| Secret | Required | Purpose |
|--------|----------|---------|
| `ALPACA_API_KEY` | ✅ | Brokerage API (trading, price data) |
| `ALPACA_API_SECRET` | ✅ | Brokerage API auth |
| `MAHORAGA_API_TOKEN` | ✅ | API authentication |
| `KILL_SWITCH_SECRET` | ✅ | Emergency kill switch |
| `OPENAI_API_KEY` | ❌ | LLM research (optional) |
| `ANTHROPIC_API_KEY` | ❌ | LLM research (optional) |
| `TWITTER_BEARER_TOKEN` | ❌ | Social sentiment (optional) |
| `DISCORD_WEBHOOK_URL` | ❌ | Notifications (optional) |

Set via Wrangler:
```bash
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
# ... etc
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENVIRONMENT` | — | `"development"` or `"production"` |
| `ALPACA_PAPER` | — | Set to use paper trading endpoint |
| `DEFAULT_MAX_POSITION_PCT` | — | Risk limit: max position as % of portfolio |
| `DEFAULT_MAX_NOTIONAL_PER_TRADE` | — | Risk limit: max dollar amount per trade |
| `DEFAULT_MAX_DAILY_LOSS_PCT` | — | Risk limit: max daily loss percentage |
| `DEFAULT_COOLDOWN_MINUTES` | — | Cooldown between trades |
| `DEFAULT_MAX_OPEN_POSITIONS` | — | Max concurrent positions |
| `DEFAULT_APPROVAL_TTL_SECONDS` | — | How long a trade approval stays valid |
| `FEATURE_LLM_RESEARCH` | — | Feature flag for LLM research |
| `FEATURE_OPTIONS` | — | Feature flag for options |

## Paper → Live Path

### 1. Paper Trading (Development)

```bash
# Deploy to dev environment
npx wrangler deploy --env development

# Ensure ALPACA_PAPER is set
npx wrangler secret put ALPACA_PAPER --env development
# Enter: "true"
```

- All trades execute against Alpaca's paper trading API
- Brier scores accumulate against real market prices
- Monitor `getBrierStats()` and `getBrierBySymbol()` to validate calibration
- **Gate**: mean Brier score should be <0.20 over 30+ predictions before going live

### 2. Calibration Validation

Before going live, verify:

```
✅ meanBrierScore < 0.20 (better than naive)
✅ evaluatedCount > 30 (statistically meaningful)
✅ No single symbol with avgBrier > 0.30
✅ recentBrierScore trending down or stable
✅ Particle filter vol estimates align with realized vol (±30%)
```

### 3. Production Deployment

```bash
# Remove paper trading flag
npx wrangler secret delete ALPACA_PAPER --env production

# Deploy
npx wrangler deploy --env production
```

### 4. Post-Launch Monitoring

- Monitor Brier scores daily — degradation signals regime change or data issues
- Check `evaluateExpiredPredictions` is running (needs a scheduled job or cron trigger)
- Watch for particle filter ESS dropping consistently low → may need to increase `numParticles` or adjust `obsNoise`
- Set up Discord webhook alerts for Brier score > 0.25

## Deployment Checklist

- [ ] D1 database created and bound in `wrangler.toml`/`wrangler.json`
- [ ] `mc_predictions` table and indexes created
- [ ] Required secrets set (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `MAHORAGA_API_TOKEN`, `KILL_SWITCH_SECRET`)
- [ ] Paper trading enabled for initial deployment
- [ ] Brier evaluation job scheduled (cron trigger or Durable Object alarm)
- [ ] Monitoring/alerting configured for Brier score degradation
- [ ] Calibration gate passed (Brier < 0.20, 30+ predictions)
- [ ] Paper flag removed for production
