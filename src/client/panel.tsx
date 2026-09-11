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

/** stale 响应（宿主后台仍在重建索引）时的自动重取：退避间隔与次数上限。
 *  会话多、日志大的机器上冷索引可能几分钟；退避 + 静默（不把面板打回"加载中"），
 *  且面板不可见时不轮询 —— 不给观感添"一直在刷新"的错觉。 */
const STALE_BACKOFF_MS = [5000, 10000, 20000, 40000, 60000]
const MAX_STALE_TRIES = 8

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
  /** stale 自动重取的计数 / 定时器 / 是否还在等后台重建（组件卸载时清掉） */
  const staleTries = useRef(0)
  const staleTimer = useRef<number | null>(null)
  const stalePending = useRef(false)
  /** 面板是否位于视口内：不可见就不重取（切走/收起侧栏=零请求） */
  const visibleRef = useRef(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [g, setG] = useState<Granularity>('day')
  const [entry, setEntry] = useState<Entry | undefined>(() => cacheRef.current['day'])
  const [net, setNet] = useState<'loading' | 'ok' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState<string>('')
  /** true = 宿主正在重建索引（本次刷新还没跑完）→ 头部显示「更新中…」+ 琥珀点 */
  const [updating, setUpdating] = useState(false)
  /** 首次挂载标志：挂载那次强制刷新，之后切粒度走被动读（同一份索引，无需重建） */
  const firstLoad = useRef(true)

  const refresh = useCallback(
    async (gran: Granularity, opts: { quiet?: boolean; force?: boolean } = {}) => {
      const quiet = opts.quiet === true
      // 静默重取：保留当前画面（不闪"加载中"），只在拿到新数据时替换
      if (!quiet) setNet('loading')
      setErrMsg('')
      try {
        // 先 summary，再用同一区间拉 models —— 保证两块数据口径一致
        const summary = await fetchSummary(gran, opts.force === true)
        const modelsRes = await fetchModels(summary.range.from, summary.range.to, opts.force === true)
        const next: CacheMap = { ...cacheRef.current, [gran]: { summary, models: modelsRes.models, at: Date.now() } }
        cacheRef.current = next
        saveCache(next)
        setEntry(next[gran])
        setNet('ok')
        // 两种情况都要继续退避重取：
        //  - stale：本次是「已落盘索引」的即时视图（重建在跑）
        //  - refresh.inFlight：按了 ⟳ 之后重建还没跑完（此时被动读会返回窗口内的旧数据，
        //    只看 stale 会误判为"已完成"→ 用户永远看不到新数字）
        const pendingRebuild = summary.stale === true || summary.refresh?.inFlight === true
        stalePending.current = pendingRebuild
        setUpdating(pendingRebuild)
        if (!pendingRebuild) {
          staleTries.current = 0
          return
        }
        if (staleTries.current >= MAX_STALE_TRIES) {
          console.warn('[token-lens] 索引重建仍在进行，停止自动重取（可手动点 ⟳）')
          return
        }
        const delay = STALE_BACKOFF_MS[Math.min(staleTries.current, STALE_BACKOFF_MS.length - 1)]
        staleTries.current += 1
        if (staleTimer.current !== null) clearTimeout(staleTimer.current)
        staleTimer.current = window.setTimeout(() => {
          staleTimer.current = null
          if (!visibleRef.current) return // 面板不可见：不打扰，等重新可见时补一次
          void refresh(gran, { quiet: true })
        }, delay)
      } catch (error) {
        if (quiet) {
          // 静默重取失败：保留现有数据，不把面板打成错误态
          console.warn('[token-lens] 后台重取失败：', error)
          return
        }
        setNet('error')
        setErrMsg(error instanceof Error ? error.message : String(error))
      }
    },
    [],
  )

  // 可见性观察：切走/收起时停止重取；重新可见且仍在等索引时补一次静默重取
  useEffect(() => {
    const el = rootRef.current
    if (el === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      visibleRef.current = last !== undefined && last.isIntersecting
      if (!visibleRef.current) return
      if (staleTimer.current !== null) {
        clearTimeout(staleTimer.current)
        staleTimer.current = null
      }
      if (stalePending.current) void refresh(g, { quiet: true })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [g, refresh])

  useEffect(
    () => () => {
      if (staleTimer.current !== null) clearTimeout(staleTimer.current)
    },
    [],
  )

  // 取数时机（刻意做到"只在需要时干活"）：
  //  - 打开面板：强制刷新一次（force，受宿主 20s 最小重建间隔保护）
  //  - 切粒度：被动读（同一份索引，换个聚合口径而已，不必重建）
  //  - 手动 ⟳ / 重试：force
  //  - 其余时间零请求（重建没跑完时由退避重取等待，见 refresh）
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false
      void refresh(g, { force: true })
      return
    }
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

  const stale = (net === 'loading' && entry !== undefined) || updating // 有旧数据可看 + 新数据在路上
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
    <div className="tl-root" ref={rootRef}>
      <div className="tl-wrap">
        {/* ── 头部条 ── */}
        <div className="tl-hd">
          <h1>Token Lens</h1>
          <span className="tl-fresh">
            <span className={`tl-dot ${dotCls}`} />
            <span>
              {entry?.summary && net !== 'error'
                ? `数据截止 ${fmtDateTime(entry.summary.cutoff)} · ${age}${updating ? ' · 更新中…' : ''}`
                : net === 'loading'
                  ? '加载中…'
                  : '暂无数据'}
            </span>
          </span>
          <span className="tl-spacer" />
          <button
            type="button"
            className="tl-iconbtn"
            onClick={() => {
              staleTries.current = 0
              void refresh(g, { force: true })
            }}
            disabled={net === 'loading'}
            title="重新抓取统计（立即重建索引）"
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
