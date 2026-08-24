/**
 * 冒烟自检：不依赖宿主，直接驱动 lib 里的纯逻辑模块。
 * 覆盖：时间分桶（本地时区）、事件折叠口径（四桶/防重计/排除自身）、区间扫描与
 * 桶上卷（会话并集去重）、状态文件往返与损坏兜底、refresh 的 live/失败隔离语义。
 * 运行：node tests/smoke.mjs （需先 npm run build）
 */
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:')
process.chdir(root)

// 状态文件路径指向临时目录，避免污染真实 ~/.dsh/storages
process.env.DSH_HOME = join(root, 'tests', '.tmp-dsh-home')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })

const time = await import('../lib/time.js')
const engine = await import('../lib/engine.js')
const storeMod = await import('../lib/store.js')
const collect = await import('../lib/collect.js')

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok - ${name}`)
  } catch (error) {
    console.error(`  FAIL - ${name}`)
    throw error
  }
}

// ── 时间分桶：本地时区口径 ──
console.log('# time')
test('localDayKey 与 dayKeyToStartMs 往返一致', () => {
  const ms = new Date(2026, 7, 22, 15, 30).getTime() // 本地 2026-08-22 15:30
  const key = time.localDayKey(ms)
  assert.equal(key, '2026-08-22')
  assert.equal(time.dayKeyToStartMs(key), new Date(2026, 7, 22).getTime())
})
test('weekStartMs 锚定周一零点', () => {
  // 2026-08-22 是周六；本周一应为 2026-08-17
  const saturday = new Date(2026, 7, 22, 12).getTime()
  assert.equal(time.weekKeyOf(saturday), '2026-08-17')
  assert.equal(new Date(time.weekStartMs(saturday)).getDay(), 1)
})
test('monthKeyOf / addMonthsMs 跨年正确', () => {
  const dec = new Date(2026, 11, 5).getTime()
  assert.equal(time.monthKeyOf(dec), '2026-12')
  assert.equal(time.monthKeyOf(time.addMonthsMs(dec, 1)), '2027-01')
})
test('isoWeekOf 跨年归属（ISO 周周四定年）', () => {
  // 2026-08-22 周六 → ISO 2026-W34
  const saturday = new Date(2026, 7, 22, 12).getTime()
  assert.deepEqual(time.isoWeekOf(saturday), { year: 2026, week: 34 })
  // 2027-01-01 周五 → 属于上一年的 W53（本周周四是 2026-12-31）
  assert.deepEqual(time.isoWeekOf(new Date(2027, 0, 1).getTime()), { year: 2026, week: 53 })
})
test('parseTimeParam 兼容纯数字 epoch（面板 400 事故回归）', () => {
  const ms = new Date(2026, 7, 22, 15, 0).getTime()
  assert.equal(time.parseTimeParam(String(ms), 0), ms)          // 毫秒时间戳
  assert.equal(time.parseTimeParam(String(Math.floor(ms / 1000)), 0), ms) // 秒级时间戳
  assert.equal(time.parseTimeParam('2026-08-22', 0), new Date(2026, 7, 22).getTime()) // ISO 日
  assert.equal(time.parseTimeParam('', 12345), 12345)            // 空值走 fallback
})
test('yearStartMs / yearKeyOf 年边界', () => {
  const midYear = new Date(2026, 5, 15).getTime()
  assert.equal(time.yearStartMs(midYear), new Date(2026, 0, 1).getTime())
  assert.equal(time.yearKeyOf(midYear), '2026')
})

// ── 引擎：事件折叠 ──
console.log('# engine.bucketizeSession')
const T0 = new Date(2026, 7, 20, 10, 0).getTime()
const mkEvent = (seq, type, data, offsetMs = 0) => ({ seq, time: T0 + offsetMs, type, data })

test('assistant/message usage 四桶累计 + 模型归因 + 小时热力', () => {
  const events = [
    mkEvent(1, 'request/header', { header: { config: { model: 'deepseek-chat', provider: 'deepseek' } } }),
    mkEvent(2, 'turn/start'),
    mkEvent(3, 'assistant/message', { model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 25 } }),
  ]
  const built = engine.bucketizeSession('s1', events, 0)
  const cell = Object.values(built.days)[0]
  assert.deepEqual(cell.tokens, { input: 100, output: 50, cacheRead: 200, cacheWrite: 25 })
  assert.equal(cell.requests, 1)
  assert.equal(cell.turns, 1)
  const hour = new Date(T0).getHours()
  assert.equal(cell.hours[hour], 375) // 四桶之和进热力图
  const m = cell.models['deepseek/deepseek-chat']
  assert.equal(engine.totalOf(m), 375)
})
test('seedLength 继承事件不计入（fork/resume 防重）', () => {
  const events = [mkEvent(1, 'turn/start'), mkEvent(2, 'assistant/message', { usage: { inputTokens: 9, outputTokens: 9 } }), mkEvent(5, 'turn/start')]
  const built = engine.bucketizeSession('s2', events, 3)
  const cells = Object.values(built.days)
  assert.equal(cells.length, 1)
  assert.equal(cells[0].turns, 1) // 只有 seq=5 那个 turn
  assert.equal(cells[0].requests, 0)
})
test('token-lens/ 前缀自身事件被排除', () => {
  const events = [mkEvent(1, 'token-lens/self-check', { any: true }), mkEvent(2, 'turn/start')]
  const built = engine.bucketizeSession('s3', events, 0)
  assert.equal(Object.values(built.days)[0].turns, 1)
})
test('P3-a provider 别名归一：包装 provider 折算到 opencode-go（whale 0.4.0 语义）', () => {
  engine.configureProviderAliases(['deepseek-modlens'])
  try {
    // 别名命中：config.provider 大小写混合也应归一
    const aliased = [
      mkEvent(1, 'request/header', { header: { config: { model: 'deepseek-chat', provider: 'DeepSeek-ModLens' } } }),
      mkEvent(2, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }),
    ]
    const cell = Object.values(engine.bucketizeSession('p1', aliased, 0).days)[0]
    assert.ok(cell.models['opencode-go/deepseek-chat'], `应归一为 opencode-go/deepseek-chat，实际 ${Object.keys(cell.models).join(',')}`)
    // 原生命名不受影响
    const native = [
      mkEvent(1, 'request/header', { header: { config: { model: 'deepseek-chat', provider: 'deepseek' } } }),
      mkEvent(2, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }),
    ]
    const cell2 = Object.values(engine.bucketizeSession('p2', native, 0).days)[0]
    assert.ok(cell2.models['deepseek/deepseek-chat'])
  } finally {
    engine.configureProviderAliases([])
  }
})
test('P3-a baseURL 兜底识别（opencode/deepseek）', () => {
  const oc = [
    mkEvent(1, 'request/header', { header: { config: { model: 'm', baseURL: 'https://opencode-go.example/v1' } } }),
    mkEvent(2, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }),
  ]
  const c1 = Object.values(engine.bucketizeSession('p3', oc, 0).days)[0]
  assert.ok(c1.models['opencode-go/m'], 'baseURL 含 opencode → opencode-go')
  const ds = [
    mkEvent(1, 'request/header', { header: { config: { model: 'm', baseURL: 'https://api.deepseek.com/v1' } } }),
    mkEvent(2, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }),
  ]
  const c2 = Object.values(engine.bucketizeSession('p4', ds, 0).days)[0]
  assert.ok(c2.models['deepseek/m'])
})
test('session/title 捕获标题', () => {
  const built = engine.bucketizeSession('s4', [mkEvent(1, 'session/title', { title: '调研 token 用量' })], 0)
  assert.equal(built.title, '调研 token 用量')
})

// ── 引擎：区间扫描 + 桶上卷 ──
console.log('# engine.scanRange / rollupBuckets')
const rec = (id, days) => ({ id, v: 1, builtAt: 0, createdAt: 0, title: `t-${id}`, lastMs: 0, days })
const dayCell = (input, requests = 1, turns = 1) => ({
  tokens: { input, output: input, cacheRead: input, cacheWrite: input },
  requests,
  turns,
  hours: new Array(24).fill(input * 4),
  models: { 'p/m': { input, output: input, cacheRead: input, cacheWrite: input } },
})
const dayA = '2026-08-10' // 周一
const dayB = '2026-08-11'
const dayC = '2026-09-01'
test('区间裁剪：区间外的整日不计入', () => {
  const from = time.dayKeyToStartMs(dayA)
  const to = from + time.DAY_MS * 2
  const scan = engine.scanRange([rec('a', { [dayA]: dayCell(10) }), rec('b', { [dayC]: dayCell(99) })], from, to)
  assert.equal(scan.days.length, 1)
  assert.equal(scan.sessions.size, 1)
})
test('rollupBuckets 会话并集去重（同一会话跨两天只计一次）', () => {
  const from = time.dayKeyToStartMs(dayA)
  const to = from + time.DAY_MS * 2
  const scan = engine.scanRange([rec('a', { [dayA]: dayCell(10), [dayB]: dayCell(20) })], from, to)
  const buckets = engine.rollupBuckets(scan.days, 'week', 8)
  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].sessions, 1) // 并集大小而非逐日求和（=2 是错的）
  assert.equal(buckets[0].tokens.total, 10 * 4 + 20 * 4)
})
test('月桶 periodKey 格式（mo- 前缀）；limit 截取最近 N 个桶', () => {
  const from = time.dayKeyToStartMs('2026-07-01')
  const to = time.dayKeyToStartMs('2026-09-02')
  const scan = engine.scanRange([rec('a', { '2026-07-05': dayCell(1), '2026-08-05': dayCell(2), [dayC]: dayCell(3) })], from, to)
  const buckets = engine.rollupBuckets(scan.days, 'month', 2)
  assert.deepEqual(buckets.map((b) => b.key), ['mo-2026-08', 'mo-2026-09'])
})
test('日/周/年桶的 periodKey 格式（day-/wk-/yr-）', () => {
  const from = time.dayKeyToStartMs('2026-07-01')
  const to = time.dayKeyToStartMs('2027-06-02')
  const scan = engine.scanRange([rec('a', { [dayA]: dayCell(1), '2026-12-31': dayCell(2), '2027-01-02': dayCell(4) })], from, to)
  assert.equal(engine.rollupBuckets(scan.days, 'day', 99)[0].key, `day-${dayA}`)
  // 2026-08-10 是周一 → ISO 2026-W33
  assert.equal(engine.rollupBuckets(scan.days, 'week', 99)[0].key, 'wk-2026-W33')
  // 2026-12-31（周四）与 2027-01-02（周六）同属 ISO 2026-W53
  const yearBuckets = engine.rollupBuckets(scan.days, 'year', 99)
  assert.deepEqual(yearBuckets.map((b) => b.key), ['yr-2026', 'yr-2027'])
  assert.equal(engine.rollupBuckets(scan.days, 'week', 99).length, 2)
})
test('cacheHitRate 口径：cacheRead / (input+cacheRead+cacheWrite)', () => {
  const t = { input: 100, output: 50, cacheRead: 200, cacheWrite: 25 }
  assert.equal(engine.inputTotalOf(t), 325)
  assert.equal(engine.totalOf(t), 375)
})

// ── 状态文件：往返与损坏兜底 ──
console.log('# store')
test('save → load 往返保留会话明细', () => {
  const s1 = storeMod.createStore()
  s1.state.sessions['x'] = rec('x', { [dayA]: dayCell(7) })
  s1.state.builtAt = 12345
  s1.save()
  const s2 = storeMod.createStore()
  s2.load()
  assert.equal(s2.state.builtAt, 12345)
  assert.equal(s2.state.sessions['x'].days[dayA].tokens.input, 7)
})
test('损坏 JSON / 版本不符 → 空状态', async () => {
  const path = storeMod.stateFilePath()
  writeFileSync(path, '{corrupted!', 'utf8')
  let s = storeMod.createStore()
  s.load()
  assert.equal(Object.keys(s.state.sessions).length, 0)
  writeFileSync(path, JSON.stringify({ ...storeMod.emptyState(), v: 999, sessions: { y: {} } }), 'utf8')
  s = storeMod.createStore()
  s.load()
  assert.equal(Object.keys(s.state.sessions).length, 0) // 版本不符拒载
})

// ── collect：live 语义 + 故障隔离 + 增量复用 ──
console.log('# collect.refreshOnce')
/** 构造 mock sessionQuery：可注入读取失败的会话 */
function makeQuery(records, snapshots, failingIds = new Set()) {
  let reads = 0
  return {
    query: {
      listSessions: async () => records,
      readSession: async (id) => {
        if (failingIds.has(id)) throw new Error('zstd decompress failed: corrupt jsonl')
        reads += 1
        return snapshots[id]
      },
    },
    readCount: () => reads,
  }
}
const snapOf = (id, seedLength = 0) => ({
  session: { id, createdAt: T0, seedLength, cwd: `D:/w/${id}` },
  events: [mkEvent(seedLength + 1, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }, id.length)],
})

await (async () => {
  const now = Date.now()
  const records = [
    { header: { id: 'cold-a', createdAt: T0 }, live: false },
    { header: { id: 'live-b', createdAt: T0 }, live: true },
  ]
  const snapshots = { 'cold-a': snapOf('cold-a'), 'live-b': snapOf('live-b') }
  const { query, readCount } = makeQuery(records, snapshots)
  const svc = collect.createServices(query, storeMod.createStore())

  // 第一次 refresh：全部读取
  await collect.ensureData(svc)
  assert.equal(readCount(), 2)
  // live 会话只进覆盖层，不落盘 —— whale 语义
  assert.ok(!svc.store.state.sessions['live-b'], 'live 会话不应写入状态文件')
  assert.equal(svc.last.live.length, 1)
  assert.equal(svc.last.persisted.length, 1)
  // 明细正确落盘
  assert.ok(svc.store.state.sessions['cold-a'].days)

  // 第二次紧接 refresh：持久化会话命中 TTL 缓存不再读；live 每次都重读
  const before = readCount()
  await collect.ensureData(svc)
  assert.equal(readCount(), before, '新鲜窗口内不应触发新采集')

  // 强制过期后：只有 live 重读
  svc.last.at -= collect.FRESH_MS * 2
  await collect.ensureData(svc)
  assert.equal(readCount(), before + 1, 'TTL 内的冷会话复用缓存，仅 live 重读')

  // 故障隔离：冷会话读取失败 → partial 披露、当前视图不含它、旧缓存保留在状态文件
  const now2 = Date.now()
  const records3 = [
    { header: { id: 'cold-a', createdAt: T0 }, live: false },
    { header: { id: 'bad-c', createdAt: T0 }, live: false },
  ]
  const failing = makeQuery(records3, { 'cold-a': snapOf('cold-a') }, new Set(['bad-c']))
  const svc2 = collect.createServices(failing.query, storeMod.createStore())
  // 预置过期缓存：cold-a（健康，重读成功）、bad-c（读取失败，旧记录应保留在状态里）
  const stale = (id) => ({ ...rec(id, { [dayA]: dayCell(3) }), v: 1, builtAt: now2 - collect.INDEX_TTL_MS * 2 })
  svc2.store.state.sessions['cold-a'] = stale('cold-a')
  svc2.store.state.sessions['bad-c'] = stale('bad-c')
  await collect.warm(svc2)
  const outcome = svc2.last
  assert.equal(outcome.partial.skippedCount, 1)
  assert.deepEqual(outcome.partial.reasons, ['corrupt-log'])
  assert.ok(outcome.partial.skippedSessionIds.includes('bad-c'))
  // bad-c 失败：不进当前聚合视图（缺失 ≠ 0），但状态文件保留其旧记录供后续恢复
  assert.equal(outcome.persisted.find((r) => r.id === 'bad-c'), undefined)
  assert.ok(svc2.store.state.sessions['bad-c'], '失败的会话旧缓存应保留在状态文件')
  // 冷却期已过的 cold-a 重读成功并回写新明细
  assert.ok(outcome.persisted.find((r) => r.id === 'cold-a'))

  console.log(`\n${passed} 组断言全部通过 ✅`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
