/**
 * 图表组件 v3（vB「柔和卡片」方向）：全部手写 SVG/CSS，零第三方库。
 * - TrendChart：四系列柔和渐变堆叠柱 + 峰值标注 + 悬浮明细 tooltip
 * - HitRateRing：缓存命中率环形计量（hero 卡签名件）
 * - ModelShare：光谱胶囊条 + 目录式横条榜（含「其他」长尾行）
 * - HeatStrip：24 小时热力条
 */
import { useId, useRef, useState } from 'react'
import type { BucketView, ModelRow } from './util'
import { fmtCompact } from './util'

const SERIES_COLORS = [
  'var(--tl-s-input)',
  'var(--tl-s-cr)',
  'var(--tl-s-cw)',
  'var(--tl-s-out)',
]

function totalOf(b: BucketView): number {
  return b.tokens.input + b.tokens.cacheRead + b.tokens.cacheWrite + b.tokens.output
}

/** 四系列渐变堆叠柱。峰值桶：圆点 + 「日期 · 总量」小标；悬浮列显示四桶明细。 */
export function TrendChart({ buckets }: { buckets: BucketView[] }): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const boxRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ l: number; t: number; html: string } | null>(null)

  const W = 360
  const H = 150
  const PAD_T = 16
  const PAD_B = 4
  const n = buckets.length
  const max = Math.max(...buckets.map(totalOf), 1)
  const step = (W - 8) / n
  const bw = Math.max(4, step * 0.62)
  let peakIdx = 0
  buckets.forEach((b, i) => { if (totalOf(b) > totalOf(buckets[peakIdx])) peakIdx = i })
  const peakTotal = totalOf(buckets[peakIdx])
  /* 标注放圆点侧面（而非上方）：最高柱也不会顶出画布裁切；靠右时翻到左侧 */
  const peakX = 4 + peakIdx * step + (step - bw) / 2 + bw / 2
  const labelSideRight = peakX < W - 118

  return (
    <div className="tl-chartbox" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="token 用量趋势">
        <defs>
          {SERIES_COLORS.map((c, si) => (
            <linearGradient key={si} id={`${uid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={c} />
              <stop offset="1" stopColor={c} stopOpacity=".72" />
            </linearGradient>
          ))}
        </defs>
        {buckets.map((b, i) => {
          const x = 4 + i * step + (step - bw) / 2
          let y = H - PAD_B
          const h = (t: number): number => (t / max) * (H - PAD_T - PAD_B)
          const segs = [b.tokens.input, b.tokens.cacheRead, b.tokens.cacheWrite, b.tokens.output]
          return (
            <g key={b.key}>
              {segs.map((v, si) => {
                if (v <= 0) return null
                const hh = h(v)
                y -= hh
                return (
                  <rect
                    key={si}
                    x={x}
                    y={y}
                    width={bw}
                    height={Math.max(hh - 0.5, 0.8)}
                    rx={Math.min(2.5, bw / 2)}
                    fill={`url(#${uid}-g${si})`}
                  />
                )
              })}
              {i === peakIdx ? (
                <>
                  <circle cx={x + bw / 2} cy={y - 8} r={2.5} fill="var(--tl-accent)" />
                  <text
                    x={labelSideRight ? peakX + 7 : peakX - 7}
                    y={Math.max(y - 5, 12)}
                    textAnchor={labelSideRight ? 'start' : 'end'}
                    fill="var(--tl-fg2)"
                    fontSize="9"
                  >
                    {`${b.label} · ${fmtCompact(peakTotal)}`}
                  </text>
                </>
              ) : null}
              <rect
                x={x - step * 0.19}
                y={0}
                width={step * 1.19}
                height={H}
                fill="transparent"
                onMouseMove={(e): void => {
                  const box = boxRef.current?.getBoundingClientRect()
                  if (!box) return
                  setTip({
                    l: Math.min(e.clientX - box.left + 12, box.width - 155),
                    t: e.clientY - box.top - 58,
                    html: `<b>${b.label}</b> · ${fmtCompact(totalOf(b))}<br>输入 ${fmtCompact(b.tokens.input)} · 缓存读 ${fmtCompact(b.tokens.cacheRead)}<br>缓存写 ${fmtCompact(b.tokens.cacheWrite)} · 输出 ${fmtCompact(b.tokens.output)}`,
                  })
                }}
                onMouseLeave={(): void => setTip(null)}
              />
            </g>
          )
        })}
      </svg>
      {/* eslint-disable-next-line react/no-danger */}
      <div className={`tl-tip${tip ? ' on' : ''}`} style={tip ? { left: tip.l, top: tip.t } : undefined} dangerouslySetInnerHTML={{ __html: tip?.html ?? '' }} />
    </div>
  )
}

/** 命中率环形计量：弧线圆头，中心大数字。pct 为 null 显示空环。 */
export function HitRateRing({ pct }: { pct: number | null }): JSX.Element {
  const R = 31
  const C = 2 * Math.PI * R
  const valid = pct !== null && Number.isFinite(pct)
  const dash = valid ? ((pct as number) / 100) * C : 0
  return (
    <div className="tl-ring-wrap">
      <div className="tl-ring">
        <svg width="74" height="74" viewBox="0 0 74 74">
          <circle cx="37" cy="37" r={R} fill="none" stroke="var(--tl-bg3)" strokeWidth="8" />
          {valid ? (
            <circle
              cx="37"
              cy="37"
              r={R}
              fill="none"
              stroke="var(--tl-s-cr)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${dash.toFixed(1)} ${(C - dash).toFixed(1)}`}
            />
          ) : null}
        </svg>
        <div className="tl-ring-val">
          <b>{valid ? `${Math.round(pct as number)}%` : '—'}</b>
          <span>命中率</span>
        </div>
      </div>
      <div className="tl-ring-cap">缓存替你省下的部分</div>
    </div>
  )
}

const MODEL_COLORS = ['--tl-m1', '--tl-m2', '--tl-m3', '--tl-m4', '--tl-m5', '--tl-m6']
const colorAt = (i: number): string => `var(${MODEL_COLORS[i % MODEL_COLORS.length]})`

/** 模型占比：光谱胶囊条 + 目录式横条榜（前 8 + 其他长尾行）。 */
export function ModelShare({ models }: { models: ModelRow[] }): JSX.Element {
  const shown = models.slice(0, 8)
  const sumShown = shown.reduce((acc, m) => acc + m.share, 0)
  const otherPct = Math.max(0, Math.round((100 - sumShown) * 10) / 10)
  const otherCount = Math.max(0, models.length - shown.length)
  return (
    <>
      <div className="tl-spectrum">
        {shown.map((m, i) => (
          <i key={m.model} style={{ width: `${m.share}%`, background: colorAt(i) }} />
        ))}
        {otherPct > 0.4 ? <i style={{ width: `${otherPct}%`, background: 'var(--tl-bg3)' }} /> : null}
      </div>
      <div>
        {shown.map((m, i) => (
          <div className={`tl-mrow${i === 0 ? ' hl' : ''}`} key={m.model}>
            <div className="tl-mline">
              <span className="tl-mname">
                <i style={{ background: colorAt(i) }} />
                <em title={m.model}>{m.model}</em>
              </span>
              <span className="tl-mpct">{m.share.toFixed(1)}%</span>
              <span className="tl-mtok">{fmtCompact(m.tokens.total)}</span>
            </div>
            <div className="tl-mtrack"><i style={{ width: `${m.share}%`, background: colorAt(i) }} /></div>
          </div>
        ))}
        {otherPct > 0.4 ? (
          <div className="tl-mrow">
            <div className="tl-mline">
              <span className="tl-mname">
                <i style={{ background: 'var(--tl-bg3)', outline: '1px solid var(--tl-bd)' }} />
                <em style={{ color: 'var(--tl-fg3)' }}>{otherCount > 0 ? `其他 ×${otherCount} 个模型` : '其他'}</em>
              </span>
              <span className="tl-mpct">{otherPct.toFixed(1)}%</span>
              <span className="tl-mtok">—</span>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

/** 24 小时热力条：本地时，强度 = tokens 占比。 */
export function HeatStrip({ hours }: { hours: number[] }): JSX.Element {
  const max = Math.max(...hours, 1)
  return (
    <>
      <div className="tl-heat">
        {hours.map((v, i) => (
          <i
            key={i}
            title={`${i}:00–${i + 1}:00 · ${fmtCompact(v)}`}
            style={{ height: `${Math.max((v / max) * 100, 6)}%`, opacity: v === 0 ? 0.08 : 0.18 + (v / max) * 0.82 }}
          />
        ))}
      </div>
      <div className="tl-haxis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
    </>
  )
}
