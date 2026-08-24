/**
 * 聚合引擎 —— 纯函数、零 IO（whale stats.js 的设计原则）。
 *
 * 数据链：readSession 的原始事件 → bucketizeSession 折叠成「本地日 × 模型 × 四桶」
 * 明细（供持久化缓存）；任意时间区间统计 = 对各会话日明细的纯内存归并
 * （scanRange），增量更新时只重读过期会话，其余直接复用缓存明细。
 *
 * 语义照抄 whale（tools.js collectEvents / stats.js bucketizeOwnEvents）：
 * - 只认 assistant/message 携带的 usage（每 turn/step 最终样本）；assistant/chunk
 *   的早期采样绝不加总；
 * - seq < seedLength 的继承事件不计入（fork/resume 防父史重计）；
 * - 排除本插件自身前缀（token-lens/）事件，防统计自激励；
 * - request/header 更新当前模型/provider 归因。
 */
import type { DayCell, SessionEventLike, SessionIndexRecord, TokenBuckets } from './types.js'
import {
  DAY_MS,
  addMonthsMs,
  dayKeyToStartMs,
  isoWeekOf,
  localDayKey,
  localHourOf,
  monthKeyOf,
  monthStartMs,
  weekStartMs,
  yearKeyOf,
  yearStartMs,
} from './time.js'

/** 四桶清零 */
export const emptyTokens = (): TokenBuckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** 四桶求和（就地累加到 target，同时返回 target 便于链式书写） */
export function addTokens(target: TokenBuckets, add: TokenBuckets): TokenBuckets {
  target.input += add.input
  target.output += add.output
  target.cacheRead += add.cacheRead
  target.cacheWrite += add.cacheWrite
  return target
}

/** 四桶总计（total = input + output + cacheRead + cacheWrite；reasoning ⊂ output 不另加） */
export function totalOf(t: TokenBuckets): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** 总输入（未缓存输入 + 缓存读 + 缓存写；whale 口径漏了 cacheWrite，此处修正） */
export function inputTotalOf(t: TokenBuckets): number {
  return t.input + t.cacheRead + t.cacheWrite
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 从 assistant/message 事件的 data 里解析 usage 四桶。
 * 字段契约：inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens。
 */
function usageOf(data: unknown): TokenBuckets | null {
  if (typeof data !== 'object' || data === null) return null
  const usage = (data as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  return {
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
  }
}

/**
 * provider 归一化与别名映射（照抄 whale-report 0.4.0 lib/stats.js L305-351）。
 *
 * 归一化：trim + lowercase（OpenCode-Go / OPENCODE-GO → opencode-go）。
 * 别名：默认不做任何假设；由用户通过环境变量 `WHALE_PROVIDER_ALIASES`
 * （逗号分隔的 provider 列表）显式声明哪些包装 provider 应归一到 opencode-go
 * （订阅流量真实出口）。模块加载时读取一次；测试可用 configureProviderAliases 覆写。
 */
export function normalizeProvider(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

const PROVIDER_ALIASES = new Set<string>(
  (process.env.WHALE_PROVIDER_ALIASES ?? '')
    .split(',')
    .map((s) => normalizeProvider(s))
    .filter(Boolean),
)

/** 测试钩子：覆写别名集（生产代码勿用）。 */
export function configureProviderAliases(list: string[]): void {
  PROVIDER_ALIASES.clear()
  for (const item of list) {
    const normalized = normalizeProvider(item)
    if (normalized !== '') PROVIDER_ALIASES.add(normalized)
  }
}

/** 从 request/header 事件里尽量识别 provider；语义与 whale 0.4.0 providerOf 一致。 */
function providerOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return 'unknown'
  const d = data as Record<string, any>
  const header = (d.header ?? {}) as Record<string, any>
  const config = (header.config ?? {}) as Record<string, any>
  const direct =
    config.upstream ?? config.route ?? config.provider ?? header.route ?? header.provider ?? d.route ?? d.provider ?? d.source
  if (typeof direct === 'string' && direct !== '') {
    const normalized = normalizeProvider(direct)
    // 用户显式声明的包装 provider → opencode-go（实际流量出口）
    if (PROVIDER_ALIASES.has(normalized)) return 'opencode-go'
    return normalized
  }
  const base = config.baseURL ?? config.endpoints?.baseURL ?? header.baseURL
  if (typeof base === 'string') {
    if (/opencode/i.test(base)) return 'opencode-go'
    if (/api\.deepseek\.com/i.test(base) || /deepseek/i.test(base)) return 'deepseek'
  }
  return 'unknown'
}

/** 模型统计键：优先带 provider 前缀，区分官方与第三方订阅出口。 */
function modelKey(provider: string, model: string): string {
  if (provider !== '' && provider !== 'unknown') return `${provider}/${model}`
  return model
}

const SELF_EVENT_PREFIX = 'token-lens/'

export interface BucketizedSession {
  /** 日键 → 当日明细（仅包含本会话自有事件贡献） */
  days: Record<string, DayCell>
  /** 首个 session/title 事件的标题 */
  title: string
  lastSeq: number
  lastMs: number
}

/**
 * 把一个会话的完整逻辑日志折叠成「本地日 × 模型 × 四桶」明细。
 * @param ownStart - seedLength：seq 小于它的继承事件不计入（防 fork/resume 重计父史）
 */
export function bucketizeSession(_sessionId: string, events: SessionEventLike[], ownStart: number): BucketizedSession {
  const days = new Map<string, DayCell>()
  let title = ''
  let currentModel = 'unknown'
  let currentProvider = 'unknown'
  let lastSeq = 0
  let lastMs = 0

  // 就地取某日的明细格（不存在则建）
  const cellOf = (ms: number): DayCell => {
    const key = localDayKey(ms)
    let cell = days.get(key)
    if (cell === undefined) {
      cell = { tokens: emptyTokens(), requests: 0, turns: 0, hours: new Array<number>(24).fill(0), models: {} }
      days.set(key, cell)
    }
    return cell
  }

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    // 继承事件边界：fork/resume 会话不重计父会话历史
    if ((event.seq ?? 0) < ownStart) continue
    // 排除本插件自身写入的事件（防自激励）
    if (event.type.startsWith(SELF_EVENT_PREFIX)) continue
    lastSeq = Math.max(lastSeq, num(event.seq))
    lastMs = Math.max(lastMs, num(event.time))

    switch (event.type) {
      case 'request/header': {
        // 当前请求的模型归因（后续 assistant/message 按 此键 累计）
        const data = event.data as Record<string, any> | undefined
        const config = data?.header?.config
        if (typeof config?.model === 'string' && config.model !== '') {
          currentModel = config.model
          currentProvider = providerOf(data)
        }
        break
      }
      case 'assistant/message': {
        const usage = usageOf(event.data)
        if (usage === null) break
        const cell = cellOf(event.time)
        addTokens(cell.tokens, usage)
        cell.requests += 1
        // 24h 热力图：按本地小时累计 total tokens
        cell.hours[localHourOf(event.time)] += totalOf(usage)
        const mk = modelKey(currentProvider, currentModel)
        const m = cell.models[mk] ?? emptyTokens()
        addTokens(m, usage)
        cell.models[mk] = m
        break
      }
      case 'turn/start': {
        cellOf(event.time).turns += 1
        break
      }
      case 'session/title': {
        const t = (event.data as Record<string, unknown> | undefined)?.title
        if (typeof t === 'string' && t !== '' && title === '') title = t
        break
      }
      default:
        break
    }
  }

  return { days: Object.fromEntries(days), title, lastSeq, lastMs }
}

/** ── 区间扫描（纯内存归并）── */

export interface DayAggregate {
  dayKey: string
  tokens: TokenBuckets
  requests: number
  turns: number
  hours: number[]
  models: Map<string, TokenBuckets>
  sessions: Set<string>
}

export interface RangeScan {
  totals: TokenBuckets
  requests: number
  turns: number
  /** 日键升序的逐日聚合 */
  days: DayAggregate[]
  /** 模型 → 四桶（区间内全量） */
  models: Map<string, TokenBuckets>
  /** 会话 id → 区间内累计（含元信息，Top 榜用） */
  sessions: Map<
    string,
    { tokens: TokenBuckets; requests: number; turns: number; title: string; cwd?: string; createdAt: number; lastMs: number }
  >
}

/**
 * 对一批会话索引记录做区间归并。
 * 裁剪粒度为「整日」（日明细是最小存储单元）：与区间相交的整天全计入，
 * 边界误差 ≤ 各端一天 —— 与 whale 的分桶裁剪近似同级别，换取 O(天数) 的查询成本。
 */
export function scanRange(records: Iterable<SessionIndexRecord>, fromMs: number, toMs: number): RangeScan {
  const scan: RangeScan = {
    totals: emptyTokens(),
    requests: 0,
    turns: 0,
    days: [],
    models: new Map(),
    sessions: new Map(),
  }
  const byDay = new Map<string, DayAggregate>()

  for (const rec of records) {
    for (const [dayKey, cell] of Object.entries(rec.days)) {
      const dayStart = dayKeyToStartMs(dayKey)
      const dayEnd = dayStart + DAY_MS
      // 整日粒度裁剪：完全落在区间外的日跳过
      if (dayEnd <= fromMs || dayStart >= toMs) continue

      let day = byDay.get(dayKey)
      if (day === undefined) {
        day = {
          dayKey,
          tokens: emptyTokens(),
          requests: 0,
          turns: 0,
          hours: new Array<number>(24).fill(0),
          models: new Map(),
          sessions: new Set(),
        }
        byDay.set(dayKey, day)
      }
      addTokens(day.tokens, cell.tokens)
      day.requests += cell.requests ?? 0
      day.turns += cell.turns ?? 0
      const hours = cell.hours ?? []
      for (let h = 0; h < 24; h++) day.hours[h] += hours[h] ?? 0
      for (const [mk, mt] of Object.entries(cell.models ?? {})) {
        const acc = day.models.get(mk) ?? emptyTokens()
        addTokens(acc, mt)
        day.models.set(mk, acc)
      }
      day.sessions.add(rec.id)

      addTokens(scan.totals, cell.tokens)
      scan.requests += cell.requests ?? 0
      scan.turns += cell.turns ?? 0
      for (const [mk, mt] of Object.entries(cell.models ?? {})) {
        const acc = scan.models.get(mk) ?? emptyTokens()
        addTokens(acc, mt)
        scan.models.set(mk, acc)
      }

      // 会话级累计（Top 榜 / 会话数口径：区间内至少有一个活动日的会话）
      let s = scan.sessions.get(rec.id)
      if (s === undefined) {
        s = { tokens: emptyTokens(), requests: 0, turns: 0, title: rec.title ?? '', cwd: rec.cwd, createdAt: rec.createdAt ?? 0, lastMs: rec.lastMs ?? 0 }
        scan.sessions.set(rec.id, s)
      }
      addTokens(s.tokens, cell.tokens)
      s.requests += cell.requests ?? 0
      s.turns += cell.turns ?? 0
    }
  }

  scan.days = [...byDay.values()].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0))
  return scan
}

/** ── 桶化（day/week/month/year 上卷）── */

export type Granularity = 'day' | 'week' | 'month' | 'year'

export interface TimeBucket {
  /**
   * 桶键：periodKey 格式（照抄上游 src/insights.ts L171-192，本地时区版）——
   * day-YYYY-MM-DD / wk-YYYY-Www（ISO 周）/ mo-YYYY-MM / yr-YYYY。
   */
  key: string
  label: string
  start: number
  end: number
  tokens: TokenBuckets & { total: number; inputTotal: number }
  requests: number
  turns: number
  sessions: number
  /** 模型 → 四桶 */
  modelTokens: Record<string, TokenBuckets>
}

/** 把逐日聚合上卷成指定粒度的桶数组（时间升序）。limit 截取最近 N 个桶。 */
export function rollupBuckets(days: DayAggregate[], granularity: Granularity, limit: number): TimeBucket[] {
  const buckets = new Map<string, TimeBucket>()
  // 桶内会话数 = 会话 id 并集大小（跨天活跃的同一会话只计一次）
  const bucketSessions = new Map<string, Set<string>>()
  for (const day of days) {
    const dayStart = dayKeyToStartMs(day.dayKey)
    let key: string
    let start: number
    let end: number
    let label: string
    if (granularity === 'day') {
      key = `day-${day.dayKey}`
      start = dayStart
      end = dayStart + DAY_MS
      label = day.dayKey
    } else if (granularity === 'week') {
      // 本自然周：周一 0:00 起（presetRange weekly 同语义，getDay 归一在 weekStartMs 内完成）
      start = weekStartMs(dayStart)
      const iso = isoWeekOf(dayStart)
      key = `wk-${iso.year}-W${String(iso.week).padStart(2, '0')}`
      end = start + 7 * DAY_MS
      label = `${localDayKey(start)} 周`
    } else if (granularity === 'month') {
      start = monthStartMs(dayStart)
      key = `mo-${monthKeyOf(dayStart)}`
      end = addMonthsMs(dayStart, 1)
      label = monthKeyOf(dayStart)
    } else {
      // 年桶：本自然年 1 月 1 日 0:00（presetRange yearly 边界）
      start = yearStartMs(dayStart)
      key = `yr-${yearKeyOf(dayStart)}`
      end = addMonthsMs(yearStartMs(dayStart), 12)
      label = `${yearKeyOf(dayStart)} 年`
    }
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        key,
        label,
        start,
        end,
        tokens: { ...emptyTokens(), total: 0, inputTotal: 0 },
        requests: 0,
        turns: 0,
        sessions: 0,
        modelTokens: {},
      }
      buckets.set(key, bucket)
    }
    addTokens(bucket.tokens, day.tokens)
    bucket.tokens.total = totalOf(bucket.tokens)
    bucket.tokens.inputTotal = inputTotalOf(bucket.tokens)
    bucket.requests += day.requests
    bucket.turns += day.turns
    let seen = bucketSessions.get(key)
    if (seen === undefined) {
      seen = new Set()
      bucketSessions.set(key, seen)
    }
    for (const id of day.sessions) seen.add(id)
    for (const [mk, mt] of day.models) {
      const acc = bucket.modelTokens[mk] ?? emptyTokens()
      addTokens(acc, mt)
      bucket.modelTokens[mk] = acc
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.start - b.start)
    .map((b) => ({ ...b, sessions: bucketSessions.get(b.key)?.size ?? 0 }))
    .slice(-Math.max(1, limit))
}
