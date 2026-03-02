import { motion } from 'motion/react'
import { Panel } from './Panel'
import { Tooltip, TooltipContent } from './Tooltip'
import type { ParticleFilterEstimate } from '../types'

interface Props {
  estimates: Record<string, ParticleFilterEstimate>
}

function formatPrice(n: number): string {
  return n.toFixed(2)
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function essQuality(ess: number, numParticles = 2000): 'good' | 'warn' | 'poor' {
  const ratio = ess / numParticles
  if (ratio > 0.5) return 'good'
  if (ratio > 0.2) return 'warn'
  return 'poor'
}

const essColors = {
  good: 'text-hud-success',
  warn: 'text-hud-warning',
  poor: 'text-hud-error',
}

export function ParticleFilterPanel({ estimates }: Props) {
  const symbols = Object.keys(estimates).sort()

  if (symbols.length === 0) {
    return (
      <Panel title="🎯 PARTICLE FILTER">
        <p className="text-hud-text-dim text-sm">No active positions with particle filter data.</p>
      </Panel>
    )
  }

  return (
    <Panel title="🎯 PARTICLE FILTER" titleRight="LIVE PROBABILITY">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {symbols.map((symbol) => {
          const est = estimates[symbol]!
          const quality = essQuality(est.ess)
          const ciWidth90 = est.priceCI90[1] - est.priceCI90[0]
          const ciWidthPct = (ciWidth90 / est.priceEstimate) * 100
          const timeSinceUpdate = Math.round((Date.now() - est.lastUpdateMs) / 1000)

          return (
            <motion.div
              key={symbol}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-hud-surface/50 rounded-lg p-3 border border-hud-border/30"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono font-bold text-hud-text">{symbol}</span>
                <div className="flex items-center gap-2 text-xs">
                  <Tooltip content={<TooltipContent description={`Effective sample size — ${quality === 'good' ? 'healthy' : quality === 'warn' ? 'degrading' : 'poor, needs resampling'}`} />}>
                    <span className={`${essColors[quality]} font-mono`}>
                      ESS {Math.round(est.ess)}
                    </span>
                  </Tooltip>
                  <span className="text-hud-text-dim">
                    {est.stepCount} steps · {timeSinceUpdate}s ago
                  </span>
                </div>
              </div>

              {/* Price estimate */}
              <div className="mb-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-mono text-hud-cyan">${formatPrice(est.priceEstimate)}</span>
                  <span className="text-xs text-hud-text-dim">estimated</span>
                </div>

                {/* 90% Credible Interval bar */}
                <div className="mt-1.5">
                  <div className="flex justify-between text-xs text-hud-text-dim mb-0.5">
                    <span>${formatPrice(est.priceCI90[0])}</span>
                    <span className="text-hud-purple">90% CI (±{ciWidthPct.toFixed(1)}%)</span>
                    <span>${formatPrice(est.priceCI90[1])}</span>
                  </div>
                  <div className="h-2 bg-hud-bg rounded-full overflow-hidden relative">
                    {/* 95% CI background */}
                    <div className="absolute h-full bg-hud-purple/15 rounded-full w-full" />
                    {/* 90% CI */}
                    <div
                      className="absolute h-full bg-hud-purple/40 rounded-full"
                      style={{
                        left: `${Math.max(0, ((est.priceCI90[0] - est.priceCI95[0]) / (est.priceCI95[1] - est.priceCI95[0])) * 100)}%`,
                        width: `${Math.min(100, ((est.priceCI90[1] - est.priceCI90[0]) / (est.priceCI95[1] - est.priceCI95[0])) * 100)}%`,
                      }}
                    />
                    {/* Point estimate marker */}
                    <div
                      className="absolute h-full w-0.5 bg-hud-cyan"
                      style={{
                        left: `${Math.max(0, Math.min(100, ((est.priceEstimate - est.priceCI95[0]) / (est.priceCI95[1] - est.priceCI95[0])) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Tooltip content={<TooltipContent description="Annualized volatility estimate" />}>
                  <div>
                    <span className="text-hud-text-dim">Vol </span>
                    <span className="font-mono text-hud-warning">{formatPct(est.volEstimate)}</span>
                  </div>
                </Tooltip>
                <Tooltip content={<TooltipContent description="Annualized drift estimate (expected return)" />}>
                  <div>
                    <span className="text-hud-text-dim">Drift </span>
                    <span className={`font-mono ${est.driftEstimate >= 0 ? 'text-hud-success' : 'text-hud-error'}`}>
                      {est.driftEstimate >= 0 ? '+' : ''}{formatPct(est.driftEstimate)}
                    </span>
                  </div>
                </Tooltip>
                <Tooltip content={<TooltipContent description="95% credible interval for price" />}>
                  <div>
                    <span className="text-hud-text-dim">95% </span>
                    <span className="font-mono text-hud-text">${formatPrice(est.priceCI95[0])}–{formatPrice(est.priceCI95[1])}</span>
                  </div>
                </Tooltip>
              </div>
            </motion.div>
          )
        })}
      </div>
    </Panel>
  )
}
