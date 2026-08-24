/**
 * 时间分桶助手 —— 全部基于**本地时区**。
 *
 * whale 的坑：日键用 toISOString()（UTC）、小时却用本地 getHours()，两者口径混用，
 * 对 UTC+8 用户晚间会话整体漂移一天。token-lens 统一本地时区：日键 / 周键 / 月键 /
 * 小时全部从同一个本地 Date 推导。
 */

export const DAY_MS = 24 * 60 * 60 * 1000
export const WEEK_MS = 7 * DAY_MS

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时区日键："YYYY-MM-DD" */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 日键 → 该日本地零点的 epoch ms（用于排序与区间裁剪） */
export function dayKeyToStartMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
}

/** 本地小时（0-23） */
export function localHourOf(ms: number): number {
  return new Date(ms).getHours()
}

/** 本地当日零点 */
export function startOfDayMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 一周起点 = 本周一零点（周一定为一周起点，实现内定死这一种） */
export function weekStartMs(ms: number): number {
  const d = new Date(ms)
  // getDay(): 周日=0 … 周六=6；换算为 周一=0 … 周日=6
  const dow = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime()
}

/** 周键 = 当周周一的日键（"YYYY-MM-DD"） */
export function weekKeyOf(ms: number): string {
  return localDayKey(weekStartMs(ms))
}

/** 本地当月一号零点 */
export function monthStartMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** 月键："YYYY-MM" */
export function monthKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

/** 月份平移：ms 所在月 ± n 个月的一号零点 */
export function addMonthsMs(ms: number, n: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
}

/**
 * ISO 周号（周一起算，含"属于哪一年"）—— whale periodKey 的本地时区版。
 * 算法照抄上游 src/insights.ts L186-191（UTC 版），此处全部换成本地 Date：
 * 定位到本周周四（ISO 规定含第一个周四的那周为第 1 周，周四所在年 = 周归属年）。
 */
export function isoWeekOf(ms: number): { year: number; week: number } {
  const d = new Date(ms)
  // getDay(): 周日=0 → 归一为 周一=1 … 周日=7（与 presetRange weekly 的归一同式）
  const dayNum = d.getDay() === 0 ? 7 : d.getDay()
  d.setDate(d.getDate() + 4 - dayNum) // 移到本周周四
  const yearStart = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return { year: d.getFullYear(), week }
}

/** 本地当年 1 月 1 日零点（presetRange yearly 边界） */
export function yearStartMs(ms: number): number {
  return new Date(new Date(ms).getFullYear(), 0, 1).getTime()
}

/** 年键："YYYY" */
export function yearKeyOf(ms: number): string {
  return String(new Date(ms).getFullYear())
}

/**
 * 解析查询参数里的时间值（ISO 字符串、"YYYY-MM-DD" 或纯数字 epoch；空值返回 fallback）。
 * 纯数字容错两种口径：≥1e12 视为毫秒，否则视为秒（×1000）。
 * 非法格式抛错（由 API 层统一转成 400 JSON）。
 */
export function parseTimeParam(value: string | null | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const trimmed = value.trim()
  // epoch 容错：浏览器端可能直接传 summary.range 的毫秒数（2026-08-23 面板 400 事故）
  if (/^\d{10,16}$/.test(trimmed)) {
    const n = Number(trimmed)
    return n >= 1e12 ? n : n * 1000
  }
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) {
    throw new Error(`无法解析时间：${value}（请用 ISO 格式，如 2026-08-01 或 2026-08-01T09:00:00）`)
  }
  return ms
}
