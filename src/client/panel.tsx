/**
 * Token Lens 主面板 v3（vB「柔和卡片」设计，2026-08-23 用户选定）。
 * 布局：头部条 → 粒度胶囊 → [Hero 卡(大数字+环比+流量细条+命中率环)] → 迷你三格
 *       → 趋势卡(四色堆叠柱) ‖ 模型占比卡 · 24h 卡 · Top 会话卡 → 口径注脚。
 * 数据流不变：localStorage 缓存优先（挂载即渲染旧数据 + 更新中徽标）→ 后台拉新覆盖。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CacheEntry, CacheMap, Granularity, ModelRow, SummaryView } from './util'
import {
  GRANULARITIES,
  fmtAge,
  fmtCompact,
  fmtDateTime,
  fmtDelta,
  fetchModels,
  fetchSummary,
  loadCache,
  prevLabelOf,
  saveCache,
} from './util'
import { HeatStrip, HitRateRing, ModelShare, TrendChart } from './charts'

/** stale 响应（宿主后台仍在重建索引）时的自动重取：间隔与次数上限。
 *  会话多、日志大的机器上冷索引可能几分钟，这里让面板自己等到真数据，而不是永远转圈。 */
const STALE_RETRY_MS = 15000
const MAX_STALE_TRIES = 16

interface Entry extends CacheEntry {}

function totalOf(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** 环比箭头 chip：token 增长=警示色▲、下降=健康色▼ */
function DeltaChip({ pct }: { pct: number | null }): JSX.Element {
  const cls = pct === null || pct === 0 ? 'tl-chip' : pct > 0 ? 'tl-chip up' : 'tl-chip down'
  const arrow = pct === null || pct === 0 ? '' : pct > 0 ? '▲ ' : '▼ '
  return <span className={cls}>{arrow}{fmtDelta(pct)}</span>
}

export function TokenLensPanel(_props: unknown): JSX.Element {
  // ── 缓存优先：挂载即用 localStorage 里上一次的数据渲染 ──
  const cacheRef = useRef<CacheMap>(loadCache())
  /** stale 自动重取的计数与定时器（组件卸载时清掉） */
  const staleTries = useRef(0)
  const staleTimer = useRef<number | null>(null)
  const [g, setG] = useState<Granularity>('day')
  const [entry, setEntry] = useState<Entry | undefined>(() => cacheRef.current['day'])
  const [net, setNet] = useState<'loading' | 'ok' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState<string>('')

  const refresh = useCallback(
    async (gran: Granularity) => {
      setNet('loading')
      setErrMsg('')
      try {
        // 先 summary，再用同一区间拉 models —— 保证两块数据口径一致
        const summary = await fetchSummary(gran)
        const modelsRes = await fetchModels(summary.range.from, summary.range.to)
        const next: CacheMap = { ...cacheRef.current, [gran]: { summary, models: modelsRes.models, at: Date.now() } }
        cacheRef.current = next
        saveCache(next)
        setEntry(next[gran])
        setNet('ok')
        // stale：宿主还在后台重建索引（会话多/日志大时可能几分钟）→ 过一会儿自动再取一次
        if (summary.stale === true && staleTries.current < MAX_STALE_TRIES) {
          staleTries.current += 1
          if (staleTimer.current !== null) clearTimeout(staleTimer.current)
          staleTimer.current = window.setTimeout(() => {
            staleTimer.current = null
            void refresh(gran)
          }, STALE_RETRY_MS)
        } else {
          staleTries.current = 0
        }
      } catch (error) {
        setNet('error')
        setErrMsg(error instanceof Error ? error.message : String(error))
      }
    },
    [],
  )

  useEffect(
    () => () => {
      if (staleTimer.current !== null) clearTimeout(staleTimer.current)
    },
    [],
  )

  useEffect(() => {
    void refresh(g)
  }, [g, refresh])

  const switchGranularity = (next: Granularity): void => {
    if (next === g) return
    setG(next)
    // 缓存优先：先切到该粒度的旧数据（若有），网络结果由 effect 拉取后覆盖
    setEntry(cacheRef.current[next])
  }

  const s: SummaryView | undefined = entry?.summary
  const models: ModelRow[] = entry?.models ?? []
  const buckets = s?.buckets ?? []
  const curBucket = buckets.length > 0 ? buckets[buckets.length - 1] : undefined
  const prevBucket = buckets.length > 1 ? buckets[buckets.length - 2] : undefined

  let periodDeltaPct: number | null = null
  if (curBucket && prevBucket && prevBucket.tokens.total > 0) {
    periodDeltaPct = Math.round(((curBucket.tokens.total - prevBucket.tokens.total) / prevBucket.tokens.total) * 1000) / 10
  }

  const stale = net === 'loading' && entry !== undefined // 正在拉新但还有旧数据可看
  const age = entry ? fmtAge(entry.at) : ''
  const dotCls = net === 'error' ? 'err' : stale ? 'stale' : ''

  // 流量细条比例（母题签名）：当前桶四成分占总量
  const mix = curBucket
    ? [
        ['未缓存输入', (curBucket.tokens.input / Math.max(curBucket.tokens.total, 1)) * 100, 'var(--tl-s-input)'],
        ['缓存读', (curBucket.tokens.cacheRead / Math.max(curBucket.tokens.total, 1)) * 100, 'var(--tl-s-cr)'],
        ['缓存写', (curBucket.tokens.cacheWrite / Math.max(curBucket.tokens.total, 1)) * 100, 'var(--tl-s-cw)'],
        ['输出', (curBucket.tokens.output / Math.max(curBucket.tokens.total, 1)) * 100, 'var(--tl-s-out)'],
      ] as const
    : []

  let peak = curBucket
  for (const b of buckets) { if (peak && totalOf(b) > totalOf(peak)) peak = b }
  const axisIdx = buckets.length > 1 ? [0, Math.floor(buckets.length / 3), Math.floor((buckets.length * 2) / 3), buckets.length - 1] : [0]

  return (
    <div className="tl-root">
      <div className="tl-wrap">
        {/* ── 头部条 ── */}
        <div className="tl-hd">
          <h1>Token Lens</h1>
          <span className="tl-fresh">
            <span className={`tl-dot ${dotCls}`} />
            <span>
              {entry?.summary && net !== 'error'
                ? `数据截止 ${fmtDateTime(entry.summary.cutoff)} · ${age}`
                : net === 'loading'
                  ? '加载中…'
                  : '暂无数据'}
            </span>
          </span>
          <span className="tl-spacer" />
          <button
            type="button"
            className="tl-iconbtn"
            onClick={() => void refresh(g)}
            disabled={net === 'loading'}
            title="重新抓取统计"
          >
            <span className={net === 'loading' ? 'tl-spin' : undefined}>⟳</span>
          </button>
        </div>

        {/* ── 粒度胶囊 ── */}
        <div className="tl-segrow">
          <div className="tl-seg" role="tablist">
            {GRANULARITIES.map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={x.key === g}
                className={x.key === g ? 'on' : ''}
                onClick={() => switchGranularity(x.key)}
              >
                {x.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── 错误横幅（保留旧数据可见）── */}
        {net === 'error' ? (
          <div className="tl-error">
            <span style={{ flex: 1 }}>抓取失败：{errMsg || '未知错误'}</span>
            <button type="button" className="tl-btn" onClick={() => void refresh(g)}>重试</button>
          </div>
        ) : null}

        {/* ── partial 披露（缺失 ≠ 0）── */}
        {s && s.partial.skippedCount > 0 ? (
          <div className="tl-warn">⚠ {s.partial.skippedCount} 个会话读取失败被跳过（{s.partial.reasons.join('/')}），以下统计不含它们。</div>
        ) : null}

        {!s ? (
          /* 首次无缓存：骨架屏 */
          <>
            <div className="tl-card">
              <div className="tl-skel" style={{ width: '38%' }} />
              <div className="tl-skel" style={{ width: '62%', height: 30 }} />
              <div className="tl-skel" style={{ width: '80%' }} />
            </div>
            <div className="tl-mini3">
              {[0, 1, 2].map((i) => (
                <div className="tl-mini" key={i}><div className="tl-skel" style={{ width: '55%' }} /><div className="tl-skel" style={{ width: '40%', marginTop: 6 }} /></div>
              ))}
            </div>
            <div className="tl-card">
              <div className="tl-skel" style={{ width: '30%' }} />
              <div className="tl-skel" style={{ height: 120 }} />
            </div>
          </>
        ) : buckets.length === 0 && s.totals.total === 0 ? (
          <div className="tl-empty">所选区间内没有 token 活动 —— 去别的会话里聊点天再来吧。</div>
        ) : (
          <div className="tl-cols">
            <div className="tl-colv">
              {/* ── Hero 卡 ── */}
              <section className="tl-card">
                <div className="tl-ch2">
                  {g === 'day' ? '今日用量' : '本周期用量'}
                  <span className="r">{curBucket?.label ?? ''}</span>
                </div>
                <div className="tl-hero-top">
                  <span className="tl-hero-num">{fmtCompact(curBucket?.tokens.total ?? 0)}</span>
                  <DeltaChip pct={periodDeltaPct} />
                </div>
                <div className="tl-hero-sub">
                  {prevLabelOf(g)} · 输入 {fmtCompact(curBucket?.tokens.inputTotal ?? 0)} · 输出{' '}
                  {fmtCompact(curBucket?.tokens.output ?? 0)} · 缓存读 {fmtCompact(curBucket?.tokens.cacheRead ?? 0)}
                </div>
                <div className="tl-mixbar">
                  {mix.map(([name, w, c]) => (
                    <i key={name} title={`${name} ${w.toFixed(1)}%`} style={{ width: `${Math.max(w, 0.4)}%`, background: c }} />
                  ))}
                </div>
                <div className="tl-legend">
                  <span><i style={{ background: 'var(--tl-s-input)' }} />未缓存输入</span>
                  <span><i style={{ background: 'var(--tl-s-cr)' }} />缓存读</span>
                  <span><i style={{ background: 'var(--tl-s-cw)' }} />缓存写</span>
                  <span><i style={{ background: 'var(--tl-s-out)' }} />输出</span>
                </div>
                <div className="tl-hero-bottom">
                  <div className="tl-hero-cap">缓存命中意味着大部分上下文被复用而未重复计费——这个数字越高，同样的对话越便宜。</div>
                  <HitRateRing pct={s.stats.cacheHitRate} />
                </div>
              </section>

              {/* ── 迷你三格 ── */}
              <div className="tl-mini3">
                <div className="tl-mini"><b>{fmtCompact(s.sessions)}</b><span>会话</span></div>
                <div className="tl-mini"><b>{fmtCompact(s.requests)}</b><span>请求</span></div>
                <div className="tl-mini"><b>{fmtCompact(s.turns)}</b><span>回合</span></div>
              </div>

              {/* ── 趋势卡 ── */}
              <section className="tl-card">
                <div className="tl-ch2">用量趋势 · 四色堆叠<span className="r">{g === 'day' ? '近 30 天' : prevLabelOf(g).replace('较', '')}</span></div>
                {buckets.length > 0 ? (
                  <>
                    <TrendChart buckets={buckets} />
                    <div className="tl-axis">
                      {axisIdx.map((i) => (
                        <span key={i}>{buckets[i]?.label}</span>
                      ))}
                    </div>
                    <div className="tl-legend">
                      <span><i style={{ background: 'var(--tl-s-input)' }} />输入</span>
                      <span><i style={{ background: 'var(--tl-s-cr)' }} />缓存读</span>
                      <span><i style={{ background: 'var(--tl-s-cw)' }} />缓存写</span>
                      <span><i style={{ background: 'var(--tl-s-out)' }} />输出</span>
                      {peak ? (
                        <span style={{ marginLeft: 'auto', color: 'var(--tl-fg3)' }}>
                          ▲ 峰值 {peak.label} · {fmtCompact(totalOf(peak))}
                        </span>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="tl-empty">该粒度暂无数据</div>
                )}
              </section>

              {/* ── 效率速览（左下配重）── */}
              <section className="tl-card">
                <div className="tl-ch2">效率速览<span className="r">区间统计</span></div>
                <div className="tl-eff">
                  <div>
                    <b>{s.turns > 0 ? fmtCompact(s.totals.total / s.turns) : '—'}</b>
                    <span>均摊每回合 tokens</span>
                  </div>
                  <div>
                    <b>{s.totals.total > 0 ? `${((s.totals.output / s.totals.total) * 100).toFixed(1)}%` : '—'}</b>
                    <span>输出占总用量</span>
                  </div>
                  <div>
                    <b>{buckets.filter((b) => b.tokens.total > 0).length}/{buckets.length}</b>
                    <span>活跃{g === 'day' ? '天' : g === 'week' ? '周' : g === 'month' ? '月' : '年'}数</span>
                  </div>
                  <div>
                    <b>
                      {s.topSessions.length > 0 && s.totals.total > 0
                        ? `${((s.topSessions[0].tokens.total / s.totals.total) * 100).toFixed(1)}%`
                        : '—'}
                    </b>
                    <span>头部会话集中度</span>
                  </div>
                </div>
              </section>

              <p className="tl-note">
                口径：总输入 = 未缓存输入 + 缓存读 + 缓存写；reasoning 含于输出不另加；本地时区分桶。wow {fmtDelta(s.stats.wow.deltaPct)} · mom {fmtDelta(s.stats.mom.deltaPct)}
              </p>
            </div>

            <div className="tl-colv">
              {/* ── 模型占比 ── */}
              <section className="tl-card">
                <div className="tl-ch2">模型占比<span className="r">按区间 tokens</span></div>
                {models.length > 0 ? <ModelShare models={models} /> : <div className="tl-empty">区间内没有模型调用记录</div>}
              </section>

              {/* ── 24 小时分布 ── */}
              <section className="tl-card">
                <div className="tl-ch2">24 小时分布<span className="r">本地时间</span></div>
                <HeatStrip hours={s.stats.heat24} />
              </section>

              {/* ── Top 会话榜 ── */}
              <section className="tl-card">
                <div className="tl-ch2">Top 会话<span className="r">按 tokens 前 8</span></div>
                {s.topSessions.length > 0 ? (
                  <div>
                    {s.topSessions.slice(0, 8).map((t, i) => (
                      <div className={`tl-trow${i === 0 ? ' hl' : ''}`} key={t.id} title={t.cwd ? `${t.title || '(无标题)'}\n${t.cwd}` : t.title || '(无标题)'}>
                        <span className="tl-trank">{i + 1}</span>
                        <span className="tl-ttitle">{t.title || '(无标题)'}</span>
                        <span className="tl-tval">{fmtCompact(t.tokens.total)} · {t.turns} 回合</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="tl-empty">区间内没有会话活动</div>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
