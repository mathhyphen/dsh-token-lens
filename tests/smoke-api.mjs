/**
 * API 层冒烟：mock webServer 捕获 prefix 路由，用假 req/res 走完整请求链
 * （信任门 → 参数解析 → ensureData 采集 → scanRange/rollup → JSON 响应）。
 * 不启动任何服务器。运行：node tests/smoke-api.mjs
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:')
process.chdir(root)
process.env.DSH_HOME = join(root, 'tests', '.tmp-dsh-home-api')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const collect = await import('../lib/collect.js')
const api = await import('../lib/api.js')

// ── mock 会话源：3 个会话、跨两天、两个模型 ──
const T0 = new Date(2026, 7, 20, 9, 0).getTime() // 本地 2026-08-20 09:00
const T1 = T0 + 26 * 3600_000 // 次日 11:00
const ev = (seq, time, type, data) => ({ seq, time, type, data })
const snapshots = {
  alpha: {
    session: { id: 'alpha', createdAt: T0, seedLength: 0 },
    events: [
      ev(1, T0, 'session/title', { title: '调 token' }),
      ev(2, T0, 'request/header', { header: { config: { model: 'deepseek-chat' } } }),
      ev(3, T0, 'turn/start'),
      ev(4, T0, 'assistant/message', { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 } }),
      ev(5, T1, 'request/header', { header: { config: { model: 'deepseek-reasoner' } } }),
      ev(6, T1, 'assistant/message', { usage: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 1200 } }),
    ],
  },
  beta: {
    session: { id: 'beta', createdAt: T0, seedLength: 4 }, // 前 4 条继承自父会话
    events: [
      ev(1, T0, 'assistant/message', { usage: { inputTokens: 999999 } }), // 继承事件，应被排除
      ev(5, T1, 'turn/start'),
      ev(6, T1, 'assistant/message', { usage: { inputTokens: 50, outputTokens: 25 } }),
    ],
  },
}
const svc = collect.createServices(
  {
    listSessions: async () => [
      { header: { id: 'alpha', createdAt: T0 }, live: false },
      { header: { id: 'beta', createdAt: T0 }, live: false },
    ],
    readSession: async (id) => snapshots[id],
  },
  (await import('../lib/store.js')).createStore(),
)

// ── 捕获式 mock server + 假 req/res ──
let handler
const ctx = { effect(execute) { return execute() } }
api.registerApiRoutes(ctx, { register(route) { handler = route.handler } }, svc)

function makeReqRes(url) {
  const res = { statusCode: 0, headers: null, body: null }
  return {
    req: { method: 'GET', url, headers: { host: '127.0.0.1:3080' } },
    async run() {
      await handler(this.req, {
        writeHead(status, headers) { res.statusCode = status; res.headers = headers },
        end(payload) { res.body = payload },
      })
      return { status: res.statusCode, json: res.body === null ? null : JSON.parse(res.body) }
    },
  }
}

const get = async (path) => makeReqRes(path).run()

// ── 用例 ──
const summary = await get('/token-lens/api/summary?granularity=day&limit=7&from=2026-08-19&to=2026-08-22')
assert.equal(summary.status, 200)
assert.equal(summary.json.ok, true)
assert.equal(summary.json.totals.total, (1000 + 500 + 2000 + 100) + (800 + 300 + 1200) + (50 + 25))
assert.equal(summary.json.sessions, 2, 'beta 的继承事件不计，但自有事件使其计入')
assert.equal(summary.json.buckets.length, 2, '两天各一桶（8-20 与 8-21）')
const day1 = summary.json.buckets[0]
assert.ok(day1.modelTokens['deepseek-chat'], '无 provider 时归因为裸模型名 deepseek-chat')
assert.ok(summary.json.buckets[1].modelTokens['deepseek-reasoner'], '次日应归因 deepseek-reasoner')
console.log('  ok - summary 总量/会话数/分桶')

const models = await get('/token-lens/api/models?from=2026-08-01')
assert.equal(models.status, 200)
const modelNames = models.json.models.map((m) => m.model)
assert.deepEqual(modelNames.slice(0, 2), ['deepseek-chat', 'deepseek-reasoner']) // 3600 > 2300，降序
assert.ok(models.json.models.every((m) => m.share >= 0))
console.log('  ok - models 占比排序')

const health = await get('/token-lens/api/health')
assert.equal(health.status, 200)
assert.equal(health.json.sessions.indexed, 2)
assert.ok(health.json.cutoff > 0, '数据截止时间戳已写入')
console.log('  ok - health 截止时间与会话数')

const badGran = await get('/token-lens/api/summary?granularity=hour')
assert.equal(badGran.status, 400)
assert.equal(badGran.json.ok, false)
const badRange = await get('/token-lens/api/models?from=2026-09-01&to=2026-08-01')
assert.equal(badRange.status, 400)
const unknown = await get('/token-lens/api/nope')
assert.equal(unknown.status, 404)
console.log('  ok - 错误兜底（非法粒度/区间→400，未知端点→404）')

// 信任门：非回环 Host 应 403
const untrusted = makeReqRes('/token-lens/api/health')
untrusted.req.headers.host = 'evil.example.com'
const r403 = await untrusted.run()
assert.equal(r403.status, 403)
console.log('  ok - 信任门拒绝非回环请求')

console.log('\nAPI 冒烟全部通过 ✅')
