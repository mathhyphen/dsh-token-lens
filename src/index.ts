/**
 * @dsh-external/dsh-token-lens — host 入口（hybrid 形态的 host 半边）。
 *
 * 职责：
 * - 数据链：ctx.sessionQuery（listSessions → readSession）→ 本地日×模型×四桶聚合
 *   → JSON 状态文件增量缓存（~/.dsh/storages/token-lens.json，带数据截止时间戳）；
 * - HTTP API：/token-lens/api/{summary,models,health}（信任门 + no-store JSON）；
 * - agent 工具：token_usage（任意时间范围的聚合查询，本地渲染 0 token 成本）；
 * - 启动 +3s 后台预热一次（不阻塞注入），之后按需采集（单飞 + 新鲜度窗口）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionQueryLike, WebServerLike } from './types.js'
import { createStore } from './store.js'
import { createServices, warm, type LensServices } from './collect.js'
import { registerApiRoutes } from './api.js'
import { tokenUsageTool } from './tool.js'

export const name = '@dsh-external/dsh-token-lens'

/**
 * 服务声明：sessionQuery 是主数据源；tools 用于注册 agent 工具。
 * webServer/httpServer 不在此声明 —— cordis 注入上下文是 Proxy，访问不存在的
 * 服务属性会直接抛异常，所以沿用 whale 的 `in` 探测 + 两个历史服务名各注入一次。
 */
export const inject = ['sessionQuery', 'tools']

/** 宿主上下文（结构化最小面：cordis Context + 用到的服务）。 */
type LensContext = Context & {
  sessionQuery: SessionQueryLike
  tools: { register(tool: ToolDefinition): void }
}

export function apply(ctx: LensContext): void {
  const sessionQuery: SessionQueryLike = ctx.sessionQuery
  const store = createStore()
  store.load()
  const svc: LensServices = createServices(sessionQuery, store)

  // agent 工具注册（whale registerReportTools 同款）
  try {
    ctx.tools.register(tokenUsageTool(svc))
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-token-lens] 工具注册失败（不影响 API）：${error instanceof Error ? error.message : String(error)}`)
  }

  // 启动后台预热：冷会话 readSession 是 zstd 解压重放（全史可达 60s+），
  // 提前建索引让首次面板打开接近秒回（whale 同款时序：+3s、不阻塞启动）
  setTimeout(() => {
    void warm(svc)
  }, 3000)

  // HTTP API：两个历史服务名都试一次，只注册一遍（`in` 探测防 Proxy 抛异常）
  let registered = false
  const tryRegister = (serverCtx: unknown): void => {
    if (registered) return
    const candidate = serverCtx as Partial<Record<'httpServer' | 'webServer', WebServerLike>>
    const has = (key: 'httpServer' | 'webServer'): boolean =>
      typeof serverCtx === 'object' && serverCtx !== null && key in serverCtx
    const server = has('httpServer') ? candidate.httpServer : has('webServer') ? candidate.webServer : undefined
    if (server === undefined) return
    registered = true
    registerApiRoutes(ctx, server, svc)
  }
  ctx.inject(['webServer'], (c: unknown) => tryRegister(c))
  ctx.inject(['httpServer'], (c: unknown) => tryRegister(c))

  ctx.logger?.info?.('[dsh-token-lens] 已装配：/token-lens/api + token_usage 工具')
}
