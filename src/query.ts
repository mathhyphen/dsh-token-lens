/**
 * 查询门面：把「采集快照 + 区间扫描 + 统计推导」组装成 API/工具共用的响应结构。
 * API（api.ts）与 agent 工具（tool.ts）都走这里，保证两条消费路径口径完全一致。
 */
import type { PartialInfo, SessionIndexRecord, TokenBuckets } from './types.js'
import type { RefreshOutcome } from './collect.js'
import { ensureData, FRESH_MS, INDEX_TTL_MS, type LensServices } from './collect.js'
import {
  addMonthsMs,
  DAY_MS,
  localDayKey,
  parseTimeParam,
  startOfDayMs,
  weekStartMs,
  monthStartMs,
} from './time.js'
import {
  inputTotalOf,
  rollupBuckets,
  scanRange,
  totalOf,
  type Granularity,
  type RangeScan,
  type TimeBucket,
} from './engine.js'

export const PLUGIN_VERSION = '0.3.1'

const round1 = (n: number): number => Math.round(n * 10) / 10

/** 四桶 + 总计 + 总输入 的响应形态 */
export interface TokensPayload extends TokenBuckets {
  total: number
  inputTotal: number
}

function tokensPayload(t: TokenBuckets): TokensPayload {
  return { ...t, total: totalOf(t), inputTotal: inputTotalOf(t) }
}

/** 环比对比块（本周 vs 上周 / 本月 vs 上月） */
interface PeriodCompareBlock {
  current: { tokens: TokensPayload; requests: number; turns: number; sessions: number }
  previous: { tokens: TokensPayload; requests: number; turns: number; sessions: number }
  /** 总量变化百分比（上一期为 0 时为 null） */
  deltaPct: number | null
}

function comparePeriods(scanCurrent: RangeScan, scanPrevious: RangeScan): PeriodCompareBlock {
  const block = (scan: RangeScan) => ({
    tokens: tokensPayload(scan.totals),
    requests: scan.requests,
    turns: scan.turns,
    sessions: scan.sessions.size,
  })
  const cur = block(scanCurrent)
  const prev = block(scanPrevious)
  const deltaPct = prev.tokens.total > 0 ? round1(((cur.tokens.total - prev.tokens.total) / prev.tokens.total) * 100) : null
  return { current: cur, previous: prev, deltaPct }
}

/** 环比窗口：自然周期锚定在 now（当前周/月为进行中的部分区间，上期为完整周期）。 */
function periodWindows(now: number): { weekCur: [number, number]; weekPrev: [number, number]; monthCur: [number, number]; monthPrev: [number, number] } {
  const ws = weekStartMs(now)
  const ms = monthStartMs(now)
  return {
    weekCur: [ws, now],
    weekPrev: [ws - 7 * DAY_MS, ws],
    monthCur: [ms, now],
    monthPrev: [addMonthsMs(now, -1), ms],
  }
}

/** GET /summary 的完整响应体。 */
export interface SummaryPayload {
  ok: true
  generatedAt: number
  /** 数据截止时间戳（epoch ms） */
  cutoff: number
  granularity: Granularity
  range: { from: number; to: number }
  totals: TokensPayload
  requests: number
  turns: number
  /** 区间内至少有一个活动日的会话数 */
  sessions: number
  buckets: TimeBucket[]
  stats: {
    /** 缓存命中率：cacheRead / (input+cacheRead+cacheWrite)，无输入时 null */
    cacheHitRate: number | null
    /** 平均每回合总 tokens */
    avgTokensPerTurn: number | null
    /** 平均每回合输出 tokens */
    avgOutputPerTurn: number | null
    peakDay: { day: string; total: number } | null
    /** 长度 24：按本地小时的 total tokens 热力分布 */
    heat24: number[]
    wow: PeriodCompareBlock
    mom: PeriodCompareBlock
  }
  topSessions: Array<{
    id: string
    title: string
    cwd?: string
    createdAt: number
    lastMs: number
    tokens: TokensPayload
    requests: number
    turns: number
  }>
  partial: PartialInfo
  /** true = 本次是「已落盘索引」的即时视图（宿主后台仍在重建索引） */
  stale: boolean
  refresh: { durationMs: number; freshWindowMs: number; indexTtlMs: number }
}

export interface SummaryParams {
  granularity: Granularity
  limit?: number
  from?: string | null
  to?: string | null
}

/** 各粒度的默认桶数与回看窗口 */
const GRANULARITY_DEFAULTS: Record<Granularity, { defaultLimit: number; maxLimit: number }> = {
  day: { defaultLimit: 30, maxLimit: 400 },
  week: { defaultLimit: 12, maxLimit: 260 },
  month: { defaultLimit: 12, maxLimit: 120 },
  year: { defaultLimit: 3, maxLimit: 30 },
}

/**
 * 组装 summary 响应。
 * 未显式给 from/to 时，按粒度取默认窗口（day=最近 N 天、week=最近 N 周、month=最近 N 月、
 * year=最近 N 年，均以自然周期边界起算、含进行中的当期 —— presetRange 同语义）；
 * limit 只裁剪返回的桶数组，totals/topSessions/stats 始终覆盖全区间。
 */
export async function buildSummary(svc: LensServices, params: SummaryParams): Promise<SummaryPayload> {
  const outcome = await ensureData(svc)
  const now = Date.now()
  const g = params.granularity
  const defaults = GRANULARITY_DEFAULTS[g]
  const limit = clampInt(params.limit, 1, defaults.maxLimit, defaults.defaultLimit)

  // 默认窗口：以本地零点/周一/月初/年初为界的最近 limit 个自然周期
  let defaultFrom: number
  if (g === 'day') defaultFrom = startOfDayMs(now) - (limit - 1) * DAY_MS
  else if (g === 'week') defaultFrom = weekStartMs(now) - (limit - 1) * 7 * DAY_MS
  else if (g === 'month') defaultFrom = addMonthsMs(now, -(limit - 1))
  else defaultFrom = addMonthsMs(now, -(limit - 1) * 12)
  const from = parseTimeParam(params.from ?? null, defaultFrom)
  const to = parseTimeParam(params.to ?? null, now)
  if (to <= from) throw new Error('时间区间无效：to 必须晚于 from')

  const records = usableRecords(outcome)
  const scan = scanRange(records, from, to)
  const buckets = rollupBuckets(scan.days, g, limit)

  // 复杂统计
  const inputTotal = inputTotalOf(scan.totals)
  const totalTokens = totalOf(scan.totals)
  const cacheHitRate = inputTotal > 0 ? round1((scan.totals.cacheRead / inputTotal) * 100) : null
  const avgTokensPerTurn = scan.turns > 0 ? Math.round(totalTokens / scan.turns) : null
  const avgOutputPerTurn = scan.turns > 0 ? Math.round(scan.totals.output / scan.turns) : null

  // 峰值日（区间内 total 最大的一天）
  let peakDay: { day: string; total: number } | null = null
  for (const day of scan.days) {
    const t = totalOf(day.tokens)
    if (peakDay === null || t > peakDay.total) peakDay = { day: day.dayKey, total: t }
  }

  // 24h 热力分布（本地小时口径）
  const heat24 = new Array<number>(24).fill(0)
  for (const day of scan.days) for (let h = 0; h < 24; h++) heat24[h] += day.hours[h]

  // 环比（本周 vs 上周、本月 vs 上月），锚定 now 的自然周期
  const w = periodWindows(now)
  const wow = comparePeriods(scanRange(records, w.weekCur[0], w.weekCur[1]), scanRange(records, w.weekPrev[0], w.weekPrev[1]))
  const mom = comparePeriods(scanRange(records, w.monthCur[0], w.monthCur[1]), scanRange(records, w.monthPrev[0], w.monthPrev[1]))

  // Top 会话榜（区间内按 total 排序前 10）
  const topSessions = [...scan.sessions.entries()]
    .map(([id, s]) => ({ id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, lastMs: s.lastMs, tokens: tokensPayload(s.tokens), requests: s.requests, turns: s.turns }))
    .sort((a, b) => b.tokens.total - a.tokens.total)
    .slice(0, 10)

  return {
    ok: true,
    generatedAt: now,
    cutoff: outcome.at,
    granularity: g,
    range: { from, to },
    totals: tokensPayload(scan.totals),
    requests: scan.requests,
    turns: scan.turns,
    sessions: scan.sessions.size,
    buckets,
    stats: {
      cacheHitRate,
      avgTokensPerTurn,
      avgOutputPerTurn,
      peakDay,
      heat24,
      wow,
      mom,
    },
    topSessions,
    partial: outcome.partial,
    /** true = 这是「已落盘索引」的即时视图，后台仍在重建（计数可能不是最新） */
    stale: outcome.stale === true,
    refresh: { durationMs: outcome.durationMs, freshWindowMs: FRESH_MS, indexTtlMs: INDEX_TTL_MS },
  }
}

/** GET /models 的响应体。 */
export interface ModelsPayload {
  ok: true
  cutoff: number
  range: { from: number; to: number }
  totals: TokensPayload
  models: Array<{ model: string; tokens: TokensPayload; share: number }>
}

/** 组装模型占比明细（默认近 30 天；share 为占总 tokens 百分比，降序）。 */
export async function buildModels(svc: LensServices, params: { from?: string | null; to?: string | null }): Promise<ModelsPayload> {
  const outcome = await ensureData(svc)
  const now = Date.now()
  const from = parseTimeParam(params.from ?? null, startOfDayMs(now) - 29 * DAY_MS)
  const to = parseTimeParam(params.to ?? null, now)
  if (to <= from) throw new Error('时间区间无效：to 必须晚于 from')

  const scan = scanRange(usableRecords(outcome), from, to)
  const allTotal = totalOf(scan.totals)
  const models = [...scan.models.entries()]
    .map(([model, t]) => ({
      model,
      tokens: tokensPayload(t),
      share: allTotal > 0 ? round1((totalOf(t) / allTotal) * 100) : 0,
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total)

  return { ok: true, cutoff: outcome.at, range: { from, to }, totals: tokensPayload(scan.totals), models }
}

/** GET /health 的响应体。 */
export interface HealthPayload {
  ok: true
  name: string
  version: string
  schemaVersion: number
  /** 数据截止时间戳（epoch ms）；0 表示尚未完成过任何采集 */
  cutoff: number
  updatedAt: number
  sessions: { indexed: number; live: number; skipped: number; listed: number }
  lastRefreshDurationMs: number
  freshness: { apiFreshWindowMs: number; sessionIndexTtlMs: number }
}

export async function buildHealth(svc: LensServices): Promise<HealthPayload> {
  // health 不触发采集：只报告现状（避免健康检查引发重 IO）
  const outcome: RefreshOutcome | null = svc.last
  const state = svc.store.state
  return {
    ok: true,
    name: 'dsh-token-lens',
    version: PLUGIN_VERSION,
    schemaVersion: state.v,
    cutoff: outcome?.at ?? state.builtAt,
    updatedAt: state.updatedAt,
    sessions: {
      indexed: outcome?.persisted.length ?? Object.keys(state.sessions).length,
      live: outcome?.live.length ?? 0,
      skipped: outcome?.partial.skippedCount ?? state.partial.skippedCount,
      listed: outcome?.listedCount ?? 0,
    },
    lastRefreshDurationMs: outcome?.durationMs ?? 0,
    freshness: { apiFreshWindowMs: FRESH_MS, sessionIndexTtlMs: INDEX_TTL_MS },
  }
}

/** 当前可参与聚合的记录 = 可用持久化会话 ∪ live 内存覆盖层。 */
function usableRecords(outcome: RefreshOutcome): SessionIndexRecord[] {
  return [...outcome.persisted, ...outcome.live]
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** ── 工具侧：紧凑 markdown 报告 ── */

const fmtK = (n: number): string => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 把 summary 结果渲染成给模型/用户看的紧凑 markdown 报告（纯本地确定性代码，0 token）。 */
export function renderSummaryMarkdown(summary: SummaryPayload): string {
  const lines: string[] = []
  const { stats } = summary
  lines.push(`## Token 用量报告（${granularityLabel(summary.granularity)}）`)
  lines.push('')
  lines.push(
    // 区间标签用本地时区日键（toISOString().slice 是 UTC 日，与整体口径不一致）
    `- 区间：${localDayKey(summary.range.from)} ~ ${localDayKey(summary.range.to)}` +
      `（数据截止 ${new Date(summary.cutoff).toLocaleString()}）`,
  )
  lines.push(
    `- 总 tokens：**${fmtK(summary.totals.total)}**（未缓存输入 ${fmtK(summary.totals.input)} / 输出 ${fmtK(summary.totals.output)} / 缓存读 ${fmtK(summary.totals.cacheRead)} / 缓存写 ${fmtK(summary.totals.cacheWrite)}）`,
  )
  lines.push(`- 活动：${summary.requests} 次请求 · ${summary.turns} 回合 · ${summary.sessions} 个会话`)
  if (stats.cacheHitRate !== null) lines.push(`- 缓存命中率：${stats.cacheHitRate}%`)
  if (stats.avgTokensPerTurn !== null) lines.push(`- 平均每回合：${fmtK(stats.avgTokensPerTurn)} tokens（输出 ${fmtK(stats.avgOutputPerTurn ?? 0)}）`)
  if (stats.peakDay !== null && stats.peakDay.total > 0) lines.push(`- 峰值日：${stats.peakDay.day}（${fmtK(stats.peakDay.total)} tokens）`)

  lines.push('')
  lines.push('### 趋势')
  lines.push('| 桶 | tokens | 输入 | 输出 | 请求 | 回合 | 会话 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const b of summary.buckets) {
    lines.push(`| ${b.label} | ${fmtK(b.tokens.total)} | ${fmtK(b.tokens.inputTotal)} | ${fmtK(b.tokens.output)} | ${b.requests} | ${b.turns} | ${b.sessions} |`)
  }

  lines.push('')
  lines.push('### 环比')
  lines.push(`- 本周 vs 上周：${fmtK(stats.wow.current.tokens.total)} vs ${fmtK(stats.wow.previous.tokens.total)}${stats.wow.deltaPct === null ? '' : `（${signPct(stats.wow.deltaPct)}）`}`)
  lines.push(`- 本月 vs 上月：${fmtK(stats.mom.current.tokens.total)} vs ${fmtK(stats.mom.previous.tokens.total)}${stats.mom.deltaPct === null ? '' : `（${signPct(stats.mom.deltaPct)}）`}`)

  // 模型占比（从桶内 modelTokens 汇总；分母用区间 tokens 总量而非 top-N 子集和，
  // 否则百分比会 >100% 失真；子集外的长尾折算成「其他」一行）
  const modelTotals = new Map<string, number>()
  for (const b of summary.buckets) {
    for (const [mk, mt] of Object.entries(b.modelTokens)) {
      modelTotals.set(mk, (modelTotals.get(mk) ?? 0) + totalOf(mt))
    }
  }
  if (modelTotals.size > 0) {
    lines.push('')
    lines.push('### 模型占比（桶内汇总）')
    const grand = Math.max(1, summary.totals.total) // 区间总量作分母
    const all = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])
    const top = all.slice(0, 8)
    for (const [mk, v] of top) {
      lines.push(`- ${mk}: ${fmtK(v)}（${round1((v / grand) * 100)}%）`)
    }
    const rest = all.slice(top.length)
    if (rest.length > 0) {
      const restTotal = rest.reduce((acc, [, v]) => acc + v, 0)
      lines.push(`- 其他 ×${rest.length} 个模型合计 ${round1((restTotal / grand) * 100)}%`)
    }
  }

  if (summary.topSessions.length > 0) {
    lines.push('')
    lines.push('### Top 会话')
    for (const s of summary.topSessions.slice(0, 5)) {
      lines.push(`- ${s.title || '(无标题)'} — ${fmtK(s.tokens.total)} tokens · ${s.turns} 回合`)
    }
  }

  if (summary.partial.skippedCount > 0) {
    lines.push('')
    lines.push(`> ⚠️ ${summary.partial.skippedCount} 个会话读取失败被跳过（${summary.partial.reasons.join('/')}），统计不含它们。`)
  }
  return lines.join('\n')
}

function granularityLabel(g: Granularity): string {
  return g === 'day' ? '按日' : g === 'week' ? '按周' : g === 'month' ? '按月' : '按年'
}

function signPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct}%`
}
