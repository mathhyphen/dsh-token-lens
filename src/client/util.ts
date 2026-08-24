/**
 * client 工具层：API 拉取、localStorage 缓存、数字/时间格式化。
 * 缓存模式参考 pi-fleet：挂载即渲染上次数据 + 数据龄徽标，后台再拉新；
 * 不设自动刷新定时器（刷新只由挂载与手动触发）。
 */

/** 粒度定义（与 host API 的 granularity 参数一致） */
export type Granularity = 'day' | 'week' | 'month' | 'year'

export const GRANULARITIES: Array<{ key: Granularity; label: string }> = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
]

/** 各粒度请求的桶数上限（视觉密度考虑） */
export const LIMITS: Record<Granularity, number> = { day: 60, week: 26, month: 24, year: 5 }

/** ── API 响应结构（与 README 的 API 文档对齐的最小子集）── */

export interface TokensView {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  inputTotal: number
}

export interface BucketView {
  key: string
  label: string
  start: number
  end: number
  tokens: TokensView
  requests: number
  turns: number
  sessions: number
  modelTokens: Record<string, TokensView>
}

export interface CompareBlock {
  current: { tokens: TokensView; requests: number; turns: number; sessions: number }
  previous: { tokens: TokensView; requests: number; turns: number; sessions: number }
  deltaPct: number | null
}

export interface SummaryView {
  ok: true
  generatedAt: number
  cutoff: number
  granularity: Granularity
  range: { from: number; to: number }
  totals: TokensView
  requests: number
  turns: number
  sessions: number
  buckets: BucketView[]
  stats: {
    cacheHitRate: number | null
    avgTokensPerTurn: number | null
    avgOutputPerTurn: number | null
    peakDay: { day: string; total: number } | null
    heat24: number[]
    wow: CompareBlock
    mom: CompareBlock
  }
  topSessions: Array<{
    id: string
    title: string
    cwd?: string
    createdAt: number
    lastMs: number
    tokens: TokensView
    requests: number
    turns: number
  }>
  partial: { skippedCount: number; skippedSessionIds: string[]; reasons: string[] }
}

export interface ModelRow {
  model: string
  tokens: TokensView
  share: number
}

/** 单粒度的缓存条目 */
export interface CacheEntry {
  summary: SummaryView
  models: ModelRow[]
  /** 抓取完成时刻（数据龄徽标依据） */
  at: number
}

export type CacheMap = Partial<Record<Granularity, CacheEntry>>

const CACHE_KEY = 'token-lens.cache.v1'

export function loadCache(): CacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CacheMap
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function saveCache(map: CacheMap): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map))
  } catch {
    /* 存储满/禁用：缓存是优化不是依赖，静默失败 */
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function fetchSummary(g: Granularity): Promise<SummaryView> {
  return getJson<SummaryView>(`/token-lens/api/summary?granularity=${g}&limit=${LIMITS[g]}`)
}

/** 用 summary 返回的同一区间拉模型占比，保证两块数据口径一致。
 * from/to 传标准 ISO（encodeURIComponent 防特殊字符）；服务端亦兼容纯数字 epoch。 */
export function fetchModels(from: number, to: number): Promise<{ models: ModelRow[] }> {
  const iso = (ms: number): string => encodeURIComponent(new Date(ms).toISOString())
  return getJson(`/token-lens/api/models?from=${iso(from)}&to=${iso(to)}`)
}

/** ── 格式化 ── */

const compact = (n: number, digits: number): string => n.toFixed(digits).replace(/\.0+$/, '')

/** token 数紧凑格式：1.2K / 3.45M / 1.1B */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${compact(n / 1e9, 2)}B`
  if (abs >= 1e6) return `${compact(n / 1e6, 2)}M`
  if (abs >= 1e3) return `${compact(n / 1e3, 1)}K`
  return String(Math.round(n))
}

/** 数据龄：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function fmtAge(at: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

export function fmtDateTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 环比百分比文案：+12.3% / -4.0% */
export function fmtDelta(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—'
  return `${pct > 0 ? '+' : ''}${pct}%`
}

/** 粒度对应的相邻周期称呼（本周期卡片的对比说明） */
export function prevLabelOf(g: Granularity): string {
  return g === 'day' ? '较前一日' : g === 'week' ? '较上周' : g === 'month' ? '较上月' : '较上年'
}
