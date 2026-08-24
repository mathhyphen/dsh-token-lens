/**
 * dsh-token-lens 共享数据模型与宿主服务结构类型。
 *
 * 计量口径（对齐 dsh-token-meter 字段契约，修正 whale 的两处瑕疵）：
 * - 四桶互斥：input（未缓存输入）/ output / cacheRead / cacheWrite；
 * - 总输入 inputTotal = input + cacheRead + cacheWrite（whale 漏了 cacheWrite，此处修正）；
 * - 总 tokens total = 四桶之和；reasoning 是 output 的子集，绝不参与加总（whale 加了，此处修正）。
 */

/** 四桶互斥 token 计量。 */
export interface TokenBuckets {
  /** 未缓存输入 tokens */
  input: number
  /** 输出 tokens（含 reasoning，后者是子集不另加） */
  output: number
  /** 缓存读 tokens */
  cacheRead: number
  /** 缓存写 tokens */
  cacheWrite: number
}

/** 单会话单日聚合明细（日键为本地时区）。 */
export interface DayCell {
  /** 四桶 token 累计 */
  tokens: TokenBuckets
  /** LLM 请求次数（assistant/message 携带 usage 的最终样本数） */
  requests: number
  /** 回合数（turn/start 事件数） */
  turns: number
  /** 长度 24 的数组：按本地小时累计的 total tokens（24h 热力图用） */
  hours: number[]
  /** 按模型键（provider/model）拆分的四桶 */
  models: Record<string, TokenBuckets>
}

/** 单会话的持久化索引记录（JSON 状态文件的 sessions 值）。 */
export interface SessionIndexRecord {
  /** 会话 id */
  id: string
  /** 结构版本号：字段变更 +1，旧记录自然失效重建 */
  v: number
  /** 本记录构建时刻（epoch ms），TTL 复用窗口依据 */
  builtAt: number
  /** 会话创建时间（epoch ms） */
  createdAt: number
  /** 会话工作目录 */
  cwd?: string
  /** 会话标题（首个 session/title 事件） */
  title: string
  /** 会话内最后事件时间（epoch ms） */
  lastMs: number
  /** 日键 → 当日明细 */
  days: Record<string, DayCell>
}

/** 数据完整性披露：读取失败被跳过的会话（缺失 ≠ 0，绝不静默吞掉）。 */
export interface PartialInfo {
  skippedCount: number
  /** 会话 id 上限 20 个（有界披露） */
  skippedSessionIds: string[]
  /** 粗分类原因：corrupt-log / read-failed（绝不存错误原文） */
  reasons: string[]
}

/** JSON 状态文件根结构（~/.dsh/storages/token-lens.json）。 */
export interface LensState {
  /** 结构版本 */
  v: number
  /** 数据截止时间戳：最近一次 refresh 完成时刻（epoch ms） */
  builtAt: number
  /** 最近一次落盘时刻 */
  updatedAt: number
  /** 已结束（持久化）会话的分桶索引；live 会话只进内存覆盖层，不落盘 */
  sessions: Record<string, SessionIndexRecord>
  /** 最近一次 refresh 的跳过披露 */
  partial: PartialInfo
}

/** ── 宿主服务结构类型（避免依赖未链接的内部包 dts）── */

/** 单条会话头记录（sessionQuery.listSessions 返回项） */
export interface SessionRecordLike {
  header: {
    id: string
    createdAt: number
    cwd?: string
    delegationDepth?: number
  }
  /** live = 进行中会话（readSession 走内存快照，快但内容持续增长） */
  live: boolean
}

/** 单条会话事件（逻辑日志回放序） */
export interface SessionEventLike {
  seq: number
  time: number
  type: string
  data?: unknown
}

/** readSession 返回的完整日志快照 */
export interface SessionSnapshotLike {
  session: {
    id: string
    createdAt?: number
    cwd?: string
    /** 继承事件边界：seq < seedLength 的事件来自父会话，不计入本会话 */
    seedLength?: number
  }
  events: SessionEventLike[]
}

/** ctx.sessionQuery 服务面（只用到的两个方法） */
export interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readSession(sessionId: string): Promise<SessionSnapshotLike>
}

/** webServer / httpServer 的 prefix 路由注册面 */
export interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): unknown
}
