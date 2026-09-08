/**
 * @dsh-external/dsh-token-lens — client 入口（v0.2.0：better-sidebar 标签页形态）。
 *
 * 入口设计（2026-08-23 二次调整，对齐 DeepTrace）：统计是全局视图，入口与
 * 终端/浏览器/深迹(DeepTrace) 同列 —— 注册进 dsh-better-sidebar 标签系统：
 *   ctx.inject(['betterSidebar'], (injected) => service.registerTab({...}))
 * 契约来源：dsh-better-sidebar lib/types/client/service.d.ts（TabDescriptor /
 * TabComponentProps），生产先例 dsh-whale-report lib/client.js（id 深迹:report、
 * order 90、single:true、component 返回面板组件）。
 * 兜底：better-sidebar 服务不可用时自动退回 sidebar.footer.action 按钮 +
 * createRoot 命令式全屏悬浮层；标签注册成功即撤掉兜底按钮。
 * 本文件保持纯 TS（tsdown 入口固定 src/client/index.ts）；JSX 在 entry.tsx。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { LensEntry, closeLensOverlay, isLensTabRegistered, registerLensTab, setLensTabRegistered } from './entry'
import { PANEL_CSS } from './theme'

type ClientContext = {
  slots: SlotsService
  inject: (services: string[], cb: (injected: Record<string, unknown>) => void) => void
  effect: (fn: () => unknown, tag?: string) => unknown
}

export const inject = ['slots']

/** 注入面板样式（幂等：热重载/重复挂载不叠加）。返回清理函数交由宿主管理。 */
function ensureStyles(): () => void {
  const STYLE_ID = 'dsh-token-lens-style'
  document.getElementById(STYLE_ID)?.remove()
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = PANEL_CSS
  document.head.appendChild(el)
  return () => el.remove()
}

type Disposable = { dispose: () => void }

/** 合并多个清理步骤为一个 disposable。 */
function combine(...steps: Array<(() => void) | undefined>): Disposable {
  return {
    dispose: (): void => {
      for (const step of steps) step?.()
    },
  }
}

/** 兼容 slots.register 返回值形态（disposable 对象或裸函数）。 */
function asDisposer(raw: unknown): Disposable | null {
  if (typeof raw === 'function') return { dispose: raw as () => void }
  if (typeof raw === 'object' && raw !== null && 'dispose' in raw) {
    return { dispose: (raw as { dispose: () => void }).dispose.bind(raw) }
  }
  return null
}

export function apply(ctx: ClientContext): void {
  // 样式生命周期挂插件级 effect：标签页与兜底按钮共用，谁先注册都不丢样式
  ctx.effect(() => ensureStyles(), 'dsh-token-lens: styles')

  let footerDisposer: Disposable | null = null
  let tabRegistered = false

  // 兜底入口：better-sidebar 不在时依然可用（标签就位后由 LensEntry 自行渲染 null）
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () => {
        // 标签已就位（footer 槽位声明晚于标签注册的时序）→ 不再注册兜底按钮
        if (isLensTabRegistered()) return () => {}
        // 内联字面量声明（注入器预检要求 register({ ... name: '<known-slot>' }) 可静态识别）
        const disposable = ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'token-lens',
            order: 90,
            label: (): string => 'Token Lens',
          },
          LensEntry,
        )
        footerDisposer = asDisposer(disposable)
        // 注册期间标签就位（竞态兜底）→ 立即撤掉
        if (isLensTabRegistered()) {
          footerDisposer?.dispose()
          footerDisposer = null
        }
        return disposable
      }),
    'dsh-token-lens: footer fallback',
  )

  // 主入口：better-sidebar 标签页（与终端/浏览器/深迹同列）
  type TabService = {
    registerTab: (descriptor: Record<string, unknown>) => unknown
    /** v0.18.0 起可用：查已注册标签（重复注册判定用；缺省则退化为普通失败） */
    getTab?: (id: string) => unknown
  }

  /** 注册标签；重复注册（同 id 已在册）也视为就位——撤掉兜底入口。 */
  const tryRegisterTab = (service: TabService): (() => void) | null => {
    try {
      const disposer = registerLensTab(service)
      console.info('[token-lens] better-sidebar 标签已注册（左侧兜底入口已撤）')
      return disposer
    } catch (error) {
      const existing = typeof service.getTab === 'function' ? service.getTab('dsh-token-lens') : undefined
      if (existing !== undefined) {
        // 同 id 标签已在册（重复加载/热重载残留）→ 标签其实就在右侧栏，只需撤兜底
        setLensTabRegistered(true)
        console.warn('[token-lens] 标签已存在，跳过重复注册（撤掉兜底入口）：', error)
        return null
      }
      // 真的注册失败 → 保留兜底入口（至少能用），原因打到控制台便于定位
      console.error('[token-lens] better-sidebar 标签注册失败，保留侧边栏兜底入口：', error)
      return null
    }
  }

  ctx.inject(['betterSidebar'], (injected) => {
    const service = injected.betterSidebar as TabService | undefined
    if (service === undefined || tabRegistered) return
    tabRegistered = true
    ctx.effect(() => {
      // 注册逻辑（含 JSX）在 entry.tsx：registerLensTab
      const disposer = tryRegisterTab(service)
      // 仅在标签确实就位时撤兜底（真失败则保留，至少还能用）
      if (isLensTabRegistered()) {
        footerDisposer?.dispose()
        footerDisposer = null
      }
      return combine(
        () => disposer?.dispose(),
        () => closeLensOverlay(),
      )
    }, 'dsh-token-lens: better-sidebar tab')
  })
}
