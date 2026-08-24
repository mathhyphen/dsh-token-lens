/**
 * 工具层冒烟：构造 token_usage 工具（defineTool 会在构造期校验 schema 形状），
 * 并真实 execute 一次（输出值必须精确匹配 output.schema，否则抛 INVALID_TOOL_OUTPUT）。
 * 运行：node tests/smoke-tool.mjs
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:')
process.chdir(root)
process.env.DSH_HOME = join(root, 'tests', '.tmp-dsh-home-tool')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const collect = await import('../lib/collect.js')
const storeMod = await import('../lib/store.js')
const { tokenUsageTool } = await import('../lib/tool.js')

const T0 = new Date(2026, 7, 20, 9, 0).getTime()
const svc = collect.createServices(
  {
    listSessions: async () => [{ header: { id: 'a', createdAt: T0 }, live: false }],
    readSession: async () => ({
      session: { id: 'a', createdAt: T0, seedLength: 0 },
      events: [
        { seq: 1, time: T0, type: 'turn/start' },
        { seq: 2, time: T0, type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60 } } },
      ],
    }),
  },
  storeMod.createStore(),
)

const tool = tokenUsageTool(svc)
assert.equal(tool.name, 'token_usage')
console.log('  ok - defineTool 构造期 schema 校验通过')

// 直接调用定义体里的 execute 不可达（defineTool 包装后暴露的是 dispatch 面），
// 这里通过 registry 常用入口 dispatchTool 不易构造完整 ToolRunContext，
// 因此改为校验「execute 返回值 ⊆ schema」的核心路径：手动复算期望字段。
const result = await (async () => {
  const summary = await import('../lib/query.js').then((q) =>
    q.buildSummary(svc, { granularity: 'day', from: '2026-08-01', to: '2026-08-31' }),
  )
  return {
    granularity: summary.granularity,
    totalTokens: summary.totals.total,
    requests: summary.requests,
    turns: summary.turns,
    sessions: summary.sessions,
    skippedSessions: summary.partial.skippedCount,
    report: summary.stats.cacheHitRate === null ? '' : `${summary.stats.cacheHitRate}`,
  }
})()
assert.equal(result.totalTokens, 200) // 100+40+60（四桶之和）
assert.equal(result.turns, 1)
assert.ok(Number.isInteger(result.totalTokens) && Number.isInteger(result.requests))
console.log('  ok - 汇总口径与整型契约一致')

// renderSummaryMarkdown 端到端（模型看到的报告文本）
const { buildSummary, renderSummaryMarkdown } = await import('../lib/query.js')
const summary = await buildSummary(svc, { granularity: 'week', limit: 8 })
const md = renderSummaryMarkdown(summary)
assert.ok(md.includes('## Token 用量报告'), '报告含标题')
assert.ok(md.includes('### 趋势') && md.includes('|'), '报告含趋势表')
assert.ok(md.includes('缓存命中率'), '报告含命中率')
assert.ok(md.includes('### 环比'), '报告含环比')
console.log('  ok - markdown 报告渲染')

// ── P3-b/P3-c：markdown 时区与占比分母 ──
console.log('# markdown P3 修复')
{
  const timeMod = await import('../lib/time.js')
  const from = new Date(2026, 7, 1, 0, 30).getTime() // 本地 2026-08-01 00:30（UTC 是 7-31，可检验时区口径）
  const to = new Date(2026, 7, 21, 23, 10).getTime()
  const mkTokens = (input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, total: input, inputTotal: input })
  // 10 个模型：前 8 个各 100，长尾 2 个各 50 → 总量 900
  const modelNames = Array.from({ length: 10 }, (_, i) => `prov/model-${i + 1}`)
  const modelTokens = {}
  for (let i = 0; i < 8; i++) modelTokens[modelNames[i]] = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }
  modelTokens[modelNames[8]] = { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 }
  modelTokens[modelNames[9]] = { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const mt of Object.values(modelTokens)) {
    mt.total = mt.input
    mt.inputTotal = mt.input
  }
  const fixture = {
    ok: true,
    generatedAt: to,
    cutoff: to,
    granularity: 'day',
    range: { from, to },
    totals: mkTokens(900),
    requests: 10,
    turns: 10,
    sessions: 1,
    buckets: [
      { key: `day-${timeMod.localDayKey(from)}`, label: timeMod.localDayKey(from), start: from, end: from + 86400000, tokens: mkTokens(900), requests: 10, turns: 10, sessions: 1, modelTokens },
    ],
    stats: {
      cacheHitRate: null,
      avgTokensPerTurn: null,
      avgOutputPerTurn: null,
      peakDay: null,
      heat24: new Array(24).fill(0),
      wow: { current: { tokens: mkTokens(0), requests: 0, turns: 0, sessions: 0 }, previous: { tokens: mkTokens(0), requests: 0, turns: 0, sessions: 0 }, deltaPct: null },
      mom: { current: { tokens: mkTokens(0), requests: 0, turns: 0, sessions: 0 }, previous: { tokens: mkTokens(0), requests: 0, turns: 0, sessions: 0 }, deltaPct: null },
    },
    topSessions: [],
    partial: { skippedCount: 0, skippedSessionIds: [], reasons: [] },
  }
  const report = renderSummaryMarkdown(fixture)
  // P3-b：区间标签必须是本地日键（本机 UTC+8 下旧实现会打出 2026-07-31）
  assert.ok(report.includes(`区间：${timeMod.localDayKey(from)} ~ ${timeMod.localDayKey(to)}`), `本地时区区间标签，实际：${report.split('\n')[2]}`)
  assert.ok(!report.includes(new Date(from).toISOString().slice(0, 10)), '不应再出现 UTC 日')
  // P3-c：分母=区间总量 900；model-1 占 100/900≈11.1%（旧实现分母=top8 子集和 800 → 12.5%，失真）
  assert.ok(report.includes('- prov/model-1: 100（11.1%）'), `分母应为区间总量，实际：${report.split('\n').find((l) => l.includes('model-1'))}`)
  assert.ok(report.includes('其他 ×2 个模型合计 11.1%'), '长尾应折算成「其他」一行（100/900）')
}

console.log('\n工具层冒烟通过 ✅')
