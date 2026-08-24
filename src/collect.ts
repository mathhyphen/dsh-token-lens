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

/** 单会话索引复用窗口：窗口内直接用缓存明细，过期才重读完整日志 */
export const INDEX_TTL_MS = 10 * 60 * 1000
/** API/工具侧的数据新鲜度：距上次 refresh 超过该窗口才重新采集 */
export const FRESH_MS = 60 * 1000
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
}

/** 插件运行期共享服务容器。 */
export interface LensServices {
  sessionQuery: SessionQueryLike
  store: TokenLensStore
  /** 最近一次 refresh 结果（ensureData 新鲜度窗口内直接复用） */
  last: RefreshOutcome | null
  /** 进行中的 refresh promise（单飞锁） */
  refreshing: Promise<RefreshOutcome> | null
  log(message: string): void
}

export function createServices(sessionQuery: SessionQueryLike, store: TokenLensStore): LensServices {
  return {
    sessionQuery,
    store,
    last: null,
    refreshing: null,
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
  if (skippedCount > 0) {
    svc.log(`refresh 完成：${outcome.persisted.length} 持久化 + ${outcome.live.length} live，跳过 ${skippedCount}（${[...reasons].join('/')}）`)
  } else {
    svc.log(`refresh 完成：${outcome.persisted.length} 持久化 + ${outcome.live.length} live，耗时 ${outcome.durationMs}ms`)
  }
  return outcome
}

/**
 * 取当前可用数据：新鲜度窗口内直接复用上次结果；否则触发 refresh（单飞，
 * 并发请求共享同一次采集）。首次调用在预热完成前到达时，会同步等这次采集。
 */
export async function ensureData(svc: LensServices): Promise<RefreshOutcome> {
  const last = svc.last
  if (last !== null && Date.now() - last.at < FRESH_MS) return last
  if (svc.refreshing === null) {
    svc.refreshing = refreshOnce(svc).finally(() => {
      svc.refreshing = null
    })
  }
  return svc.refreshing
}

/** 后台预热：启动后为全部会话建索引（无时间上限；一次性）。 */
export async function warm(svc: LensServices): Promise<void> {
  try {
    await refreshOnce(svc)
  } catch (error) {
    // 预热失败不致命：下次 API/工具调用会按需重试
    svc.log(`warm 失败（将在下次查询时重试）：${error instanceof Error ? error.message : String(error)}`)
  }
}
