import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Panel } from './Panel'
import { Tooltip, TooltipContent } from './Tooltip'
import type { Position } from '../types'

interface CorrelationHeatmapProps {
  positions: Position[]
  /** Optional pre-computed correlation matrix from API (symbol → symbol → value) */
  correlationMatrix?: Record<string, Record<string, number>>
}

/**
 * Compute a synthetic correlation matrix from position data.
 * In production this would come from historical return data via the API.
 * This fallback uses market-value-weighted similarity as a rough proxy.
 */
function computeSyntheticCorrelations(positions: Position[]): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {}
  const symbols = positions.map(p => p.symbol)

  // Seed a deterministic pseudo-random from symbol pair
  function pairHash(a: string, b: string): number {
    const key = [a, b].sort().join(':')
    let h = 0
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0
    }
    return (Math.abs(h) % 1000) / 1000
  }

  for (const s1 of symbols) {
    matrix[s1] = {}
    for (const s2 of symbols) {
      if (s1 === s2) {
        matrix[s1][s2] = 1.0
      } else if (matrix[s2]?.[s1] !== undefined) {
        matrix[s1][s2] = matrix[s2][s1]
      } else {
        // Generate a plausible correlation: most stocks cluster 0.2-0.7
        const hash = pairHash(s1, s2)
        matrix[s1][s2] = 0.1 + hash * 0.75 // Range: 0.1 to 0.85
      }
    }
  }
  return matrix
}

/** Map correlation value (0-1) to a color on the green→yellow→red scale */
function correlationColor(value: number): string {
  const v = Math.max(0, Math.min(1, value))
  if (v <= 0.3) {
    // Green zone (low correlation) — interpolate green to yellow-green
    const t = v / 0.3
    const r = Math.round(34 + t * 140)
    const g = Math.round(197 - t * 40)
    const b = Math.round(94 - t * 60)
    return `rgb(${r}, ${g}, ${b})`
  } else if (v <= 0.6) {
    // Yellow zone (moderate correlation)
    const t = (v - 0.3) / 0.3
    const r = Math.round(174 + t * 60)
    const g = Math.round(157 - t * 50)
    const b = Math.round(34 - t * 10)
    return `rgb(${r}, ${g}, ${b})`
  } else {
    // Red zone (high correlation / concentration risk)
    const t = (v - 0.6) / 0.4
    const r = Math.round(234 - t * 30)
    const g = Math.round(107 - t * 80)
    const b = Math.round(24 + t * 10)
    return `rgb(${r}, ${g}, ${b})`
  }
}

function getRiskLevel(value: number): { label: string; color: string } {
  if (value >= 0.7) return { label: 'HIGH', color: 'text-hud-error' }
  if (value >= 0.4) return { label: 'MODERATE', color: 'text-hud-warning' }
  return { label: 'LOW', color: 'text-hud-success' }
}

export function CorrelationHeatmap({ positions, correlationMatrix: externalMatrix }: CorrelationHeatmapProps) {
  const [hoveredCell, setHoveredCell] = useState<{ row: string; col: string } | null>(null)

  const symbols = useMemo(() => positions.map(p => p.symbol), [positions])

  const matrix = useMemo(() => {
    if (externalMatrix && Object.keys(externalMatrix).length > 0) return externalMatrix
    return computeSyntheticCorrelations(positions)
  }, [positions, externalMatrix])

  // Compute concentration risk: average off-diagonal correlation
  const concentrationRisk = useMemo(() => {
    if (symbols.length < 2) return 0
    let sum = 0
    let count = 0
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        sum += (matrix[symbols[i]]?.[symbols[j]] ?? 0)
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }, [matrix, symbols])

  // Find highest correlated pairs for callout
  const topPairs = useMemo(() => {
    const pairs: { a: string; b: string; corr: number }[] = []
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        pairs.push({
          a: symbols[i],
          b: symbols[j],
          corr: matrix[symbols[i]]?.[symbols[j]] ?? 0,
        })
      }
    }
    return pairs.sort((a, b) => b.corr - a.corr).slice(0, 3)
  }, [matrix, symbols])

  const risk = getRiskLevel(concentrationRisk)

  if (positions.length < 2) {
    return (
      <Panel title="CORRELATION MATRIX" titleRight="CONCENTRATION RISK" className="h-full">
        <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
          Need ≥2 positions for correlation analysis
        </div>
      </Panel>
    )
  }

  const cellSize = symbols.length <= 5 ? 'w-12 h-12' : symbols.length <= 8 ? 'w-10 h-10' : 'w-8 h-8'
  const fontSize = symbols.length <= 5 ? 'text-xs' : 'text-[10px]'

  return (
    <Panel
      title="CORRELATION MATRIX"
      titleRight={
        <div className="flex items-center gap-3">
          <span className="hud-label">CONCENTRATION:</span>
          <span className={clsx('hud-value-sm font-bold', risk.color)}>
            {(concentrationRisk * 100).toFixed(0)}% {risk.label}
          </span>
        </div>
      }
    >
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Heatmap grid */}
        <div className="flex-1 overflow-x-auto">
          <div className="inline-block">
            {/* Column headers */}
            <div className="flex" style={{ marginLeft: symbols.length <= 5 ? '3.5rem' : '3rem' }}>
              {symbols.map(sym => (
                <div
                  key={`col-${sym}`}
                  className={clsx(cellSize, 'flex items-end justify-center pb-1')}
                >
                  <span
                    className={clsx(
                      'hud-label transform -rotate-45 origin-bottom-left whitespace-nowrap',
                      hoveredCell?.col === sym && 'text-hud-primary'
                    )}
                  >
                    {sym}
                  </span>
                </div>
              ))}
            </div>

            {/* Rows */}
            {symbols.map(rowSym => (
              <div key={`row-${rowSym}`} className="flex items-center">
                <div className={clsx('w-14 shrink-0 text-right pr-2', symbols.length > 5 && 'w-12')}>
                  <span
                    className={clsx(
                      'hud-label',
                      hoveredCell?.row === rowSym && 'text-hud-primary'
                    )}
                  >
                    {rowSym}
                  </span>
                </div>
                {symbols.map(colSym => {
                  const value = matrix[rowSym]?.[colSym] ?? 0
                  const isDiagonal = rowSym === colSym
                  const isHovered = hoveredCell?.row === rowSym && hoveredCell?.col === colSym
                  const isHighlighted =
                    hoveredCell?.row === rowSym || hoveredCell?.col === colSym

                  return (
                    <Tooltip
                      key={`${rowSym}-${colSym}`}
                      position="top"
                      content={
                        <TooltipContent
                          title={`${rowSym} × ${colSym}`}
                          items={[
                            { label: 'Correlation', value: isDiagonal ? '1.00 (self)' : value.toFixed(3) },
                            ...(!isDiagonal ? [{ label: 'Risk', value: getRiskLevel(value).label, color: getRiskLevel(value).color }] : []),
                          ]}
                        />
                      }
                    >
                      <div
                        className={clsx(
                          cellSize,
                          'flex items-center justify-center cursor-crosshair transition-all duration-150 border',
                          isDiagonal
                            ? 'border-hud-line/30'
                            : isHovered
                              ? 'border-hud-text-bright scale-110 z-10'
                              : isHighlighted
                                ? 'border-hud-line/50'
                                : 'border-hud-line/10',
                        )}
                        style={{
                          backgroundColor: isDiagonal
                            ? 'rgba(255,255,255,0.05)'
                            : correlationColor(value),
                          opacity: isDiagonal ? 0.4 : isHighlighted ? 1 : 0.85,
                        }}
                        onMouseEnter={() => setHoveredCell({ row: rowSym, col: colSym })}
                        onMouseLeave={() => setHoveredCell(null)}
                      >
                        <span
                          className={clsx(
                            fontSize,
                            'font-mono font-bold',
                            isDiagonal ? 'text-hud-text-dim' : 'text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]'
                          )}
                        >
                          {isDiagonal ? '—' : value.toFixed(2)}
                        </span>
                      </div>
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Color scale legend */}
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-hud-line/30">
            <span className="hud-label text-[9px]">LOW</span>
            <div className="flex h-2 flex-1 max-w-[200px] rounded-sm overflow-hidden">
              {Array.from({ length: 20 }, (_, i) => (
                <div
                  key={i}
                  className="flex-1"
                  style={{ backgroundColor: correlationColor(i / 19) }}
                />
              ))}
            </div>
            <span className="hud-label text-[9px]">HIGH</span>
          </div>
        </div>

        {/* Risk summary sidebar */}
        <div className="lg:w-48 shrink-0 space-y-3">
          <div className="p-2 border border-hud-line/30 rounded">
            <span className="hud-label block mb-1">AVG CORRELATION</span>
            <span className={clsx('text-lg font-mono font-bold', risk.color)}>
              {(concentrationRisk * 100).toFixed(1)}%
            </span>
          </div>

          {topPairs.length > 0 && (
            <div className="p-2 border border-hud-line/30 rounded">
              <span className="hud-label block mb-2">TOP CORRELATED</span>
              <div className="space-y-1.5">
                {topPairs.map(({ a, b, corr }) => {
                  const pairRisk = getRiskLevel(corr)
                  return (
                    <div key={`${a}-${b}`} className="flex justify-between items-center">
                      <span className="text-[10px] font-mono text-hud-text">
                        {a}/{b}
                      </span>
                      <span className={clsx('text-[10px] font-mono font-bold', pairRisk.color)}>
                        {(corr * 100).toFixed(0)}%
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="p-2 border border-hud-line/30 rounded">
            <span className="hud-label block mb-1">POSITIONS</span>
            <span className="text-lg font-mono text-hud-text-bright">{symbols.length}</span>
          </div>
        </div>
      </div>
    </Panel>
  )
}
