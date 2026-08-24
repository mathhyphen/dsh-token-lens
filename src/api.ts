/**
 * HTTP API：前缀 /token-lens/api。
 *
 * 照抄 whale api.js 的惯例：
 * - writeJson：application/json; charset=utf-8 + cache-control: no-store + content-length；
 * - 每个请求过信任门（Host 必须回环地址 + 非 cross-site + Origin 同源）；
 * - 整个 handler 包 try/catch，兜底 400 JSON 错误；
 * - 经 ctx.effect 注册 prefix 路由（server.register 返回的 disposable 交由宿主管理卸载）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LensServices } from './collect.js'
import { buildHealth, buildModels, buildSummary } from './query.js'
import type { Granularity } from './engine.js'
import type { WebServerLike } from './types.js'

export const API_PREFIX = '/token-lens/api'

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 仅本机 + 同源标记（无跨站 Origin / Sec-Fetch-Site）的请求可以通过。 */
export function isTrustedApiRequest(request: { headers: IncomingMessage['headers'] }): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** JSON 响应帮助函数（no-store：统计数据每次都应新鲜）。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const GRANULARITIES: Granularity[] = ['day', 'week', 'month', 'year']

const isGranularity = (value: string | null): value is Granularity =>
  value !== null && (GRANULARITIES as string[]).includes(value)

/**
 * 注册 /token-lens/api 路由。
 *
 * 端点（全部 GET）：
 * - /summary?granularity=day|week|month&limit=N&from&to —— 桶数组 + 总计 + 复杂统计 + Top 会话榜
 * - /models?from&to —— 模型占比明细（默认近 30 天）
 * - /health —— 数据截止时间、会话数、新鲜度参数（不触发采集）
 */
export function registerApiRoutes(
  ctx: { effect(execute: () => unknown, label?: string): unknown },
  server: WebServerLike,
  svc: LensServices,
): void {
  ctx.effect(
    () =>
      server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          // 信任门：仅本机 GUI 可访问（照抄 whale 安全语义）
          if (!isTrustedApiRequest({ headers: req.headers })) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const method = url.pathname.startsWith(`${API_PREFIX}/`) ? url.pathname.slice(API_PREFIX.length + 1) : ''
            if (req.method !== 'GET') {
              writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '仅支持 GET' } })
              return
            }
            if (method === 'summary') {
              const granularity = url.searchParams.get('granularity') ?? 'day'
              if (!isGranularity(granularity)) {
                writeJson(res, 400, { ok: false, error: { code: 'bad-granularity', message: `granularity 仅支持 ${GRANULARITIES.join('/')}` } })
                return
              }
              const limitRaw = url.searchParams.get('limit')
              const summary = await buildSummary(svc, {
                granularity,
                limit: limitRaw === null ? undefined : Number(limitRaw),
                from: url.searchParams.get('from'),
                to: url.searchParams.get('to'),
              })
              writeJson(res, 200, summary)
              return
            }
            if (method === 'models') {
              const models = await buildModels(svc, {
                from: url.searchParams.get('from'),
                to: url.searchParams.get('to'),
              })
              writeJson(res, 200, models)
              return
            }
            if (method === 'health') {
              writeJson(res, 200, await buildHealth(svc))
              return
            }
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知端点：${method || '(空)'}；可用：summary / models / health` } })
          } catch (error) {
            // 兜底：任何异常转 400 JSON（参数非法 / 数据问题都不该炸连接）
            writeJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      }),
    'dsh-token-lens: /token-lens/api routes',
  )
}
