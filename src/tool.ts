/**
 * agent 工具：token_usage —— 让模型也能查询任意时间范围的聚合结果。
 * 与 HTTP API 共用 query.ts 的组装逻辑，口径完全一致；
 * 报告渲染是纯本地确定性代码（不调用任何模型 API，生成成本 0 token）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LensServices } from './collect.js'
import { buildSummary, renderSummaryMarkdown } from './query.js'

export function tokenUsageTool(svc: LensServices) {
  return defineTool({
    name: 'token_usage',
    description:
      'Query DSH token usage statistics over a time range (daily/weekly/monthly aggregation, per-model breakdown, ' +
      'cache hit rate, peak day, week-over-week and month-over-month comparison, top sessions). ' +
      "Use when the user asks about token spend/usage ('这个月用了多少 token', '本周 token 消耗怎么样', " +
      "'哪个模型用得最多'). Read-only; the report is generated locally with zero extra model cost.",
    parameters: {
      granularity: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: '聚合粒度：day=按日（默认）、week=按周、month=按月、year=按年。',
      },
      from: {
        type: 'string',
        description: '起始时间（ISO 格式，如 2026-08-01）；缺省按粒度取最近默认窗口。',
      },
      to: {
        type: 'string',
        description: '结束时间（ISO 格式）；缺省为现在。',
      },
      limit: {
        type: 'integer',
        description: '返回最近 N 个桶（day 默认 30 上限 400；week/month 默认 12；year 默认 3）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          granularity: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          totalTokens: { type: 'integer', required: true },
          inputTokens: { type: 'integer', required: true },
          outputTokens: { type: 'integer', required: true },
          cacheReadTokens: { type: 'integer', required: true },
          cacheWriteTokens: { type: 'integer', required: true },
          requests: { type: 'integer', required: true },
          turns: { type: 'integer', required: true },
          sessions: { type: 'integer', required: true },
          skippedSessions: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute: async (args) => {
      const summary = await buildSummary(svc, {
        granularity: args.granularity ?? 'day',
        limit: args.limit,
        from: args.from ?? null,
        to: args.to ?? null,
      })
      return {
        granularity: summary.granularity,
        from: new Date(summary.range.from).toISOString(),
        to: new Date(summary.range.to).toISOString(),
        totalTokens: summary.totals.total,
        inputTokens: summary.totals.input,
        outputTokens: summary.totals.output,
        cacheReadTokens: summary.totals.cacheRead,
        cacheWriteTokens: summary.totals.cacheWrite,
        requests: summary.requests,
        turns: summary.turns,
        sessions: summary.sessions,
        skippedSessions: summary.partial.skippedCount,
        report: renderSummaryMarkdown(summary),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `查询 token 用量（${args.granularity ?? 'day'}）`,
      kind: 'other',
      rawInput: args,
    }),
  })
}
