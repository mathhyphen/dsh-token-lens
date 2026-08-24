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
import { LensEntry, closeLensOverlay, registerLensTab } from './entry'
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

  // 兜底入口先行注册：better-sidebar 不在时依然可用
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () => {
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
        return disposable
      }),
    'dsh-token-lens: footer fallback',
  )

  // 主入口：better-sidebar 标签页（与终端/浏览器/深迹同列）
  ctx.inject(['betterSidebar'], (injected) => {
    const service = injected.betterSidebar as
      | { registerTab: (descriptor: Record<string, unknown>) => unknown }
      | undefined
    if (service === undefined || tabRegistered) return
    tabRegistered = true
    ctx.effect(() => {
      // 注册逻辑（含 JSX）在 entry.tsx：registerLensTab
      const disposer = registerLensTab(service)
      // 正式入口就位，撤掉兜底按钮（样式保留，标签页还在用）
      footerDisposer?.dispose()
      footerDisposer = null
      return combine(
        () => disposer?.dispose(),
        () => closeLensOverlay(),
      )
    }, 'dsh-token-lens: better-sidebar tab')
  })
}
