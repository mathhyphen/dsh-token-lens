/**
 * 采集编排：listSessions → 有限并发 readSession → 增量更新聚合缓存。
 *
 * whale 教训的照抄与适配：
 * - live 会话每次全量重读（内存快照快），只进内存覆盖层参与统计、**绝不落盘**
 *   （内容持续增长，落盘会立刻过期）；
 * - 持久化会话优先复用新鲜索引（TTL 10min），过期才重读完整日志（zstd 解压重放，
 *   全史可达 60s+），成功后回写状态文件；
 * - 单会话读取失败 → 跳过并记入 partial（id 上限 20 + 粗分类原因，绝不存错误原文），
 *   当前聚合视图不含它（缺失 ≠ 0）；但旧缓存记录保留在状态文件里，后续刷新成功即恢复；
 * - 启动 +3s 后台预热一次（不阻塞注入），之后 API/工具按需触发（单飞防并发雪崩）。
 */
import type {
  PartialInfo,
  SessionIndexRecord,
  SessionQueryLike,
  SessionRecordLike,
  SessionSnapshotLike,
} from './types.js'
import { SCHEMA_VERSION, type TokenLensStore } from './store.js'
import { bucketizeSession } from './engine.js'

/**
 * 单会话索引复用窗口：窗口内直接用缓存明细，过期才重读完整日志。
 *
 * 2026-09-11：10min → 30 分钟。它必须**明显长于** FRESH_MS，否则每次重建都会发现
 * 上一次重建留下的索引刚好过期 → 退化成"每次都全量重读"（这正是重建要跑 50~110s
 * 的主因）。30min = 覆盖最近 2~3 轮重建，只有更老的会话才重读。
 */
export const INDEX_TTL_MS = 30 * 60 * 1000
/**
 * 被动读取的新鲜度窗口：窗口内直接复用上次结果。
 *
 * 2026-09-11：60s → 10 分钟。原值 60s 意味着**任何一次读接口**（面板打开、客户端
 * 重取、token_usage 工具）在 60 秒后就触发一次全量重建索引；而一次重建在会话多、
 * 日志大的机器上要跑 50~110 秒 → 实际表现是"一直在重建索引"。统计面板不是实时监控，
 * 10 分钟窗口足够；要即时数据按 ⟳（走 force）。
 */
export const FRESH_MS = 10 * 60 * 1000
/** 两次重建之间的最小间隔：即使 force 也不得更密（防连点 ⟳ 反复触发全量）。 */
export const REINDEX_FLOOR_MS = 20 * 1000
/** 并发读取上限（whale 实测值：12 是吞吐与 IO 压力的平衡点） */
const READ_CONCURRENCY = 12
/** partial 披露的 id 上限（有界披露原则） */
const SKIP_IDS_CAP = 20

/** 读取失败原因粗分类：只产出有界、稳定、非敏感的类别。 */
export function classifyReadError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (/corrupt|torn|zstd|zstandard|jsonl/i.test(msg)) return 'corrupt-log'
  return 'read-failed'
}

/** 有限并发映射（照抄 whale tools.js mapWithConcurrency）。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** 由 readSession 快照构建单会话索引记录。 */
function buildRecord(snapshot: SessionSnapshotLike, builtAt: number, fallback: SessionRecordLike): SessionIndexRecord {
  const built = bucketizeSession(snapshot.session.id, snapshot.events, snapshot.session.seedLength ?? 0)
  return {
    id: snapshot.session.id,
    v: SCHEMA_VERSION,
    builtAt,
    createdAt: snapshot.session.createdAt ?? fallback.header.createdAt ?? 0,
    cwd: snapshot.session.cwd ?? fallback.header.cwd,
    title: built.title,
    lastMs: built.lastMs,
    days: built.days,
  }
}

/** 一次 refresh 的产出（API 层消费的可用视图）。 */
export interface RefreshOutcome {
  /** 完成时刻（= 数据截止时间戳） */
  at: number
  /** refresh 耗时 ms */
  durationMs: number
  /** 当前可参与聚合的持久化会话记录（读取失败的除外） */
  persisted: SessionIndexRecord[]
  /** live 会话内存覆盖层（每次 refresh 全量重建） */
  live: SessionIndexRecord[]
  /** 数据完整性披露 */
  partial: PartialInfo
  /** listSessions 列出的总会话数 */
  listedCount: number
  /** true = 本次响应用的是已落盘索引（后台仍在重建），数据可能不是最新 */
  stale?: boolean
}

/** 插件运行期共享服务容器。 */
export interface LensServices {
  sessionQuery: SessionQueryLike
  store: TokenLensStore
  /** 最近一次 refresh 结果（ensureData 新鲜度窗口内直接复用） */
  last: RefreshOutcome | null
  /** 进行中的 refresh promise（单飞锁） */
  refreshing: Promise<RefreshOutcome> | null
  /** 最近一次 refresh 的失败原因（成功即清空）——静默吞错会让"⟳ 点了没用"无法诊断 */
  lastError: string | null
  log(message: string): void
}

export function createServices(sessionQuery: SessionQueryLike, store: TokenLensStore): LensServices {
  return {
    sessionQuery,
    store,
    last: null,
    refreshing: null,
    lastError: null,
    log(message: string) {
      try {
        console.log(`[dsh-token-lens] ${message}`)
      } catch {
        /* 日志失败静默 */
      }
    },
  }
}

/**
 * 执行一次全量采集（增量更新各会话明细后整体落盘）。
 * 幂等；调用方应通过 ensureData 走单飞锁。
 */
async function refreshOnce(svc: LensServices): Promise<RefreshOutcome> {
  const startedAt = Date.now()
  const records = await svc.sessionQuery.listSessions()
  const now = Date.now()
  // 候选过滤（照抄 whale）：创建时间早于 now 的会话才纳入（时钟回拨防护）
  const candidates = records.filter((r) => (r.header.createdAt ?? 0) < now)

  const persistedNext: Record<string, SessionIndexRecord> = {}
  const usablePersisted: SessionIndexRecord[] = []
  const liveOverlay: Record<string, SessionIndexRecord> = {}
  const skippedIds: string[] = []
  const skippedIdSet = new Set<string>()
  const reasons = new Set<string>()
  let skippedCount = 0

  await mapWithConcurrency(candidates, READ_CONCURRENCY, async (record: SessionRecordLike) => {
    const id = record.header.id
    const cached = svc.store.state.sessions[id]
    try {
      if (record.live) {
        // live 会话：每次全量重读，只进内存覆盖层，不落盘 —— 照抄 whale 语义
        const snapshot = await svc.sessionQuery.readSession(id)
        liveOverlay[id] = buildRecord(snapshot, now, record)
        return
      }
      // 持久化会话：新鲜索引直接复用（增量更新的核心路径）
      if (cached !== undefined && cached.v === SCHEMA_VERSION && now - cached.builtAt < INDEX_TTL_MS) {
        persistedNext[id] = cached
        usablePersisted.push(cached)
        return
      }
      // 未命中：重读完整日志并重建明细，回写状态
      const snapshot = await svc.sessionQuery.readSession(id)
      const rec = buildRecord(snapshot, now, record)
      persistedNext[id] = rec
      usablePersisted.push(rec)
    } catch (error) {
      // 故障隔离：单会话失败不影响其余；当前视图不含它，partial 披露。
      // 与 whale 不同点：JSON 状态保留旧缓存记录（若曾有过），后续刷新成功即恢复。
      skippedCount += 1
      skippedIdSet.add(id)
      if (skippedIds.length < SKIP_IDS_CAP) skippedIds.push(id)
      reasons.add(classifyReadError(error))
      if (!record.live && cached !== undefined && cached.v === SCHEMA_VERSION) {
        persistedNext[id] = cached
      }
    }
  })

  // 状态收敛：persistedNext 只含本轮仍在 listSessions 里的会话 → 被删除的会话自然剪除
  svc.store.state.sessions = persistedNext
  svc.store.state.partial = {
    skippedCount,
    skippedSessionIds: skippedIds,
    reasons: [...reasons].sort(),
  }
  svc.store.state.builtAt = Date.now()
  svc.store.save()

  const outcome: RefreshOutcome = {
    at: Date.now(),
    durationMs: Date.now() - startedAt,
    persisted: usablePersisted,
    live: Object.values(liveOverlay),
    partial: svc.store.state.partial,
    listedCount: records.length,
  }
  svc.last = outcome
  svc.lastError = null
  if (skippedCount > 0) {
    svc.log(`refresh 完成：${outcome.persisted.length} 持久化 + ${outcome.live.length} live，跳过 ${skippedCount}（${[...reasons].join('/')}）`)
  } else {
    svc.log(`refresh 完成：${outcome.persisted.length} 持久化 + ${outcome.live.length} live，耗时 ${outcome.durationMs}ms`)
  }
  return outcome
}

/**
 * 用「已落盘索引」拼一个可用视图 —— 纯内存操作，毫秒级。
 *
 * 为什么需要它：冷启动（或索引过期）时 refreshOnce 要重读几百个会话日志，
 * 在有大量会话/损坏日志的机器上会跑好几分钟；此时若让 API 阻塞等待，面板就会
 * 一直停在「加载中…」（用户视角＝功能坏了）。所以先拿旧索引秒回，刷新在后台继续，
 * 下次请求自然拿到新数据。
 */
function indexSnapshot(svc: LensServices): RefreshOutcome | null {
  const sessions = svc.store?.state?.sessions
  if (sessions === undefined || sessions === null) return null
  const persisted = Object.values(sessions).filter((r) => r !== undefined && r !== null)
  if (persisted.length === 0) return null
  return {
    at: svc.store.state.builtAt ?? 0,
    durationMs: 0,
    persisted,
    live: [],
    partial: svc.store.state.partial ?? { skippedCount: 0, skippedSessionIds: [], reasons: [] },
    listedCount: persisted.length,
    stale: true,
  }
}

/** 等待 refresh 落地的宽限：窗口内完成就用新数据，否则先回旧索引。 */
const ENSURE_GRACE_MS = 1500

/**
 * 取当前可用数据：
 *  1. 新鲜度窗口（FRESH_MS）内直接复用上次结果 —— 被动读不再每次触发重索引；
 *  2. 否则触发 refresh（单飞，并发请求共享同一次采集）；
 *  3. 已有落盘索引时最多等 ENSURE_GRACE_MS —— 超时即用旧索引返回（stale:true），
 *     重建继续在后台跑，绝不把请求挂死；
 *  4. 完全没有索引（真·首次）才同步等待这次采集。
 *
 * @param options.force 用户显式要求（面板 ⟳）：忽略 FRESH_MS，但仍受 REINDEX_FLOOR_MS 限制。
 */
export async function ensureData(svc: LensServices, options: { force?: boolean } = {}): Promise<RefreshOutcome> {
  const last = svc.last
  const age = last === null ? Number.POSITIVE_INFINITY : Date.now() - last.at
  if (age < FRESH_MS && options.force !== true) return last as RefreshOutcome
  // 刚重建过：即使 force 也不重复跑（防连点 ⟳ / 多客户端同时强制）
  if (age < REINDEX_FLOOR_MS) return last as RefreshOutcome
  if (svc.refreshing === null) {
    svc.refreshing = startRefresh(svc)
  }
  const pending = svc.refreshing
  const snapshot = indexSnapshot(svc)
  if (snapshot === null) return pending // 真·冷启动：没有旧索引可显，只能等
  const settled = await Promise.race([
    pending.then(
      () => 'ok' as const,
      (error: unknown) => {
        // 关键：把失败显式记下来（旧实现把"失败"也当成"完成"→ 静默返回旧数据，
        // 表现就是"⟳ 点了没反应"）
        svc.lastError = error instanceof Error ? error.message : String(error)
        svc.log(`refresh 失败：${svc.lastError}`)
        return 'failed' as const
      },
    ),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ENSURE_GRACE_MS)),
  ])
  if (settled === 'ok' && svc.last !== null) return svc.last
  if (settled === 'failed' && svc.last === null) {
    // 一点数据都没有又失败了：把原因抛给调用方（API 转 400 带 message），不假装成功
    throw new Error(`索引重建失败：${svc.lastError ?? '未知原因'}`)
  }
  if (settled === 'timeout') {
    svc.log(`索引仍在后台重建（${snapshot.persisted.length} 条旧索引可用），本次先返回既有索引`)
  }
  return snapshot
}

/** 启动一次 refresh 并挂上单飞锁（warm 与 ensureData 共用，避免并发跑两遍全量）。 */
function startRefresh(svc: LensServices): Promise<RefreshOutcome> {
  const run = refreshOnce(svc).finally(() => {
    svc.refreshing = null
  })
  svc.refreshing = run
  return run
}

/** 后台预热：启动后为全部会话建索引（无时间上限；一次性）。走同一把单飞锁。 */
export async function warm(svc: LensServices): Promise<void> {
  try {
    await (svc.refreshing ?? startRefresh(svc))
  } catch (error) {
    // 预热失败不致命：下次 API/工具调用会按需重试
    svc.log(`warm 失败（将在下次查询时重试）：${error instanceof Error ? error.message : String(error)}`)
  }
}
