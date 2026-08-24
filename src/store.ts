/**
 * JSON 状态文件持久化（~/.dsh/storages/token-lens.json）。
 *
 * 聚合结果以「会话 → 本地日 → 模型 × 四桶」明细粒度落盘，带数据截止时间戳；
 * 重复请求只重读过期/新增会话，其余直接复用缓存明细 —— 增量更新而非全量重算。
 * 目录与 whale 的 storage-domain 后端同款惯例（storages/*.json）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { LensState, PartialInfo } from './types.js'

/** 结构版本：字段语义变更 +1，旧文件自然失效重建 */
export const SCHEMA_VERSION = 1

const emptyPartial = (): PartialInfo => ({ skippedCount: 0, skippedSessionIds: [], reasons: [] })

export function emptyState(): LensState {
  return {
    v: SCHEMA_VERSION,
    builtAt: 0,
    updatedAt: 0,
    sessions: {},
    partial: emptyPartial(),
  }
}

/** 状态文件路径：DSH_HOME 优先（web 进程 homedir 可能与 DSH_HOME 不一致），缺省 ~/.dsh */
export function stateFilePath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'token-lens.json')
}

export interface TokenLensStore {
  /** 内存态（读写都走这里；save() 负责落盘） */
  state: LensState
  /** 从磁盘加载；损坏 / 版本不符 → 空状态（绝不因缓存问题拖垮插件） */
  load(): void
  /** 原子化落盘：tmp + rename，rename 失败回退直写 */
  save(): void
}

export function createStore(): TokenLensStore {
  const path = stateFilePath()
  const store: TokenLensStore = {
    state: emptyState(),
    load() {
      try {
        const raw = readFileSync(path, 'utf8')
        const parsed = JSON.parse(raw) as LensState
        if (parsed && typeof parsed === 'object' && parsed.v === SCHEMA_VERSION && typeof parsed.sessions === 'object') {
          // 只接受结构版本匹配的状态；其余一律当空（重建成本可接受）
          store.state = {
            v: SCHEMA_VERSION,
            builtAt: parsed.builtAt ?? 0,
            updatedAt: parsed.updatedAt ?? 0,
            sessions: parsed.sessions ?? {},
            partial: parsed.partial ?? emptyPartial(),
          }
        }
      } catch {
        /* 首次运行无文件 / JSON 损坏 → 空状态 */
      }
    },
    save() {
      try {
        store.state.updatedAt = Date.now()
        mkdirSync(dirname(path), { recursive: true })
        const payload = JSON.stringify(store.state)
        const tmp = `${path}.tmp`
        writeFileSync(tmp, payload, 'utf8')
        try {
          renameSync(tmp, path)
        } catch {
          // Windows 上个别场景 rename 可能被占用；回退直写（最坏情况半写，下次加载按损坏处理）
          writeFileSync(path, payload, 'utf8')
        }
      } catch {
        /* 落盘失败不致命：内存态仍在，下次 refresh 再试 */
      }
    },
  }
  return store
}
