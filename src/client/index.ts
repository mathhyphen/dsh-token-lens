/**
 * @dsh-external/dsh-token-lens — client 入口。
 *
 * 入口演进：
 *  - v0.2.0：better-sidebar 标签页（ctx.inject(['betterSidebar']) → registerTab）。
 *  - v0.3.3（2026-09-10）：DSH 0.1.5 把右侧栏收进内核并移除了第三方
 *    dsh-better-sidebar，插件因此退化到左侧栏兜底按钮（正好压在「设置」上面）。
 *    现改为优先注册进内核右侧栏：
 *      ctx.inject(['sidebarRightTabs']) → registry.register({id, kind, title, guide})
 *      + 槽位 sidebar.right.pane.tab / sidebar.right.pane.tab.title（key = definition.id）
 *    契约来源：@deepseek-ai/dsh-client-ui-sidebar-right 与内置生产者
 *    dsh-client-ui-sidebar-files（filesDefinition / FilesBody / FilesTitle）。
 *  兜底链：内建右侧栏 → better-sidebar（老版本 DSH）→ sidebar.footer.action 按钮。
 *  本文件保持纯 TS（tsdown 入口固定 src/client/index.ts）；JSX 在 entry.tsx。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BUILTIN_TAB_KIND,
  LensEntry,
  TokenLensChip,
  TokenLensHeaderAction,
  TokenLensTab,
  builtinTabDefinition,
  closeLensOverlay,
  isLensTabRegistered,
  registerLensTab,
  setDockedOpener,
  setLensTabRegistered,
} from './entry'
import { PANEL_CSS } from './theme'

type ClientContext = {
  slots: SlotsService
  inject: (services: string[], cb: (injected: Record<string, unknown>) => void) => void
  effect: (fn: () => unknown, tag?: string) => unknown
}

/** DSH 0.1.5+ 内建右侧栏的页签注册表（ctx.sidebarRightTabs）。 */
type RightTabRegistry = { register: (definition: Record<string, unknown>) => unknown }

/** DSH 0.1.5+ 内建右侧栏的导航面（ctx.sidebarRight）：openTab 由内核拉开侧栏。 */
type RightBarService = { openTab?: (kind: string, options?: Record<string, unknown>) => void }

/** 页签正文/标题槽位的 entryKey（= definition.id）。 */
const BUILTIN_TAB_ID = 'dsh-token-lens'

/** 新槽位名不在 dsh-client-ui-slots 的类型表里，注册/注入走宽松签名。 */
type LooseRegister = (spec: Record<string, unknown>, component: unknown) => unknown
type LooseInject = (key: string, cb: () => unknown) => unknown

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

  // 正规入口一（官方槽位）：会话头部动作按钮 —— 位置随会话标题栏，点开悬浮卡片
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () => {
        const disposable = ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'token-lens',
            order: 90,
          },
          TokenLensHeaderAction,
        )
        // 头部入口就位 → 兜底按钮退场（状态位同时让兜底组件渲染 null，顺序无关）
        setLensTabRegistered(true)
        footerDisposer?.dispose()
        footerDisposer = null
        return disposable
      }),
    'dsh-token-lens: header action (floating card)',
  )

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

  // 主入口 A（DSH 0.1.5+）：内核右侧栏页签
  const tryRegisterBuiltinTab = (registry: RightTabRegistry): Disposable | null => {
    const steps: Array<() => void> = []
    // 注意：slots 的方法内部用 this.ctx，摘下来必须绑定，否则 "Cannot read properties of undefined (reading 'ctx')"
    const register = (ctx.slots.register as unknown as LooseRegister).bind(ctx.slots) as LooseRegister
    const injectSlot = (ctx.slots.inject as unknown as LooseInject).bind(ctx.slots) as LooseInject
    const push = (raw: unknown): void => {
      const d = asDisposer(raw)
      if (d !== null) steps.push(() => d.dispose())
    }
    try {
      push(registry.register(builtinTabDefinition()))
      push(
        injectSlot('sidebar.right.pane.tab', () =>
          register({ name: 'sidebar.right.pane.tab', key: BUILTIN_TAB_ID }, TokenLensTab),
        ),
      )
      push(
        injectSlot('sidebar.right.pane.tab.title', () =>
          register({ name: 'sidebar.right.pane.tab.title', key: BUILTIN_TAB_ID }, TokenLensChip),
        ),
      )
    } catch (error) {
      for (const step of steps) {
        try {
          step()
        } catch {
          /* 回滚尽力而为 */
        }
      }
      console.error('[token-lens] 内建右侧栏页签注册失败，保留兜底入口：', error)
      return null
    }
    setLensTabRegistered(true)
    console.info('[token-lens] 已注册进内核右侧栏（sidebarRightTabs）')
    return { dispose: (): void => { for (const step of steps) step() } }
  }

  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
    const registry = injected.sidebarRightTabs as RightTabRegistry | undefined
    const rightbar = injected.sidebarRight as RightBarService | undefined
    if (registry === undefined || tabRegistered) return
    tabRegistered = true
    ctx.effect(() => {
      const disposer = tryRegisterBuiltinTab(registry)
      if (rightbar !== undefined && typeof rightbar.openTab === 'function') {
        // 头部按钮 → 宿主右侧栏：由内核拉开侧栏并切到本页签（官方路径，最稳）
        setDockedOpener(() => {
          rightbar.openTab?.(BUILTIN_TAB_KIND)
          console.info('[token-lens] 已请求宿主打开右侧栏 Token Lens 页签')
          return true
        })
      }
      if (isLensTabRegistered()) {
        footerDisposer?.dispose()
        footerDisposer = null
      }
      return combine(
        () => disposer?.dispose(),
        () => setDockedOpener(null),
        () => closeLensOverlay(),
      )
    }, 'dsh-token-lens: builtin right sidebar tab')
  })

  // 主入口 B（旧版 DSH）：better-sidebar 标签页
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
