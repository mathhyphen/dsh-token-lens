/**
 * 入口组件集合：better-sidebar 标签页（主入口）+ 侧边栏底部按钮（兜底）。
 *
 * 主入口（2026-08-23 按用户需求）：与终端/浏览器/深迹(DeepTrace) 同列，
 * 注册进 dsh-better-sidebar 的标签系统 —— 契约见其 lib/types/client/service.d.ts：
 * TabDescriptor{ id,title,icon,order,single,component }，component 收 TabComponentProps
 * 返回 ReactNode。DeepTrace 生产先例：dsh-whale-report lib/client.js registerTab 调用。
 * 兜底：better-sidebar 服务不存在时退回 sidebar.footer.action 按钮 + 命令式悬浮层。
 */
import { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TokenLensPanel } from './panel'

/* ── Tab 就位状态（模块级外部 store）────────────────────────────────────────
 * 2026-09-08 位置错乱修复：兜底按钮此前靠「标签注册成功后 dispose」撤除，
 * 依赖 slots.inject 回调与 ctx.inject(['betterSidebar']) 回调的先后顺序——
 * 若 footer 槽位声明晚于标签注册（DSH 更新后 ui-sidebar 的槽位声明时机变了），
 * 回调会在标签就位之后才跑，footerDisposer 当时还是 null，于是按钮注册了就
 * 再也没人撤 → 左侧边栏底部一直多一个 Token Lens 按钮。
 * 改为状态驱动（照抄 dsh-whale-report 的 FallbackDrawer 做法）：标签一就位，
 * 兜底组件自己渲染 null，与注册顺序无关。
 * ──────────────────────────────────────────────────────────────────────── */
let tabRegistered = false
const tabModeListeners = new Set<() => void>()

/** 标签是否已就位（兜底入口据此退场）。 */
export function isLensTabRegistered(): boolean {
  return tabRegistered
}

/** 标记标签就位/退场，并通知兜底组件重渲染。 */
export function setLensTabRegistered(next: boolean): void {
  if (tabRegistered === next) return
  tabRegistered = next
  for (const listener of tabModeListeners) {
    try {
      listener()
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

/** useSyncExternalStore 的订阅/快照对（服务端快照恒 false）。 */
function subscribeTabMode(listener: () => void): () => void {
  tabModeListeners.add(listener)
  return () => {
    tabModeListeners.delete(listener)
  }
}

/* ── 图标：透镜/仪表盘小图标（描边跟随 currentColor，尺寸自适应）── */
export function LensIcon(props: { size: number }): JSX.Element {
  const s = props.size
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.6 A3.4 3.4 0 0 1 10.4 7 L7 7 Z" fill="currentColor" opacity="0.85" />
      <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/* ── better-sidebar 标签页内容（props: TabComponentProps，本面板自取数不消费）── */
export function TokenLensTab(): JSX.Element {
  return <TokenLensPanel />
}

/* ── 会话头部入口（官方槽位 conversation.session.header.actions）──
 * 一个 28px 圆形图标按钮，点开/收起悬浮卡片（悬浮层由本文件的命令式实现承载：
 * esc / 点遮罩关闭）。位置随会话标题栏，属于宿主给插件预留的正规座位。 */
export function TokenLensHeaderAction(): JSX.Element {
  return (
    <button
      type="button"
      className="tl-header-action"
      onClick={(e) => {
        e.stopPropagation()
        toggleLensOverlay()
      }}
      title="Token Lens · 全部会话的 token 用量统计"
      aria-label="Token Lens"
    >
      <LensIcon size={16} />
    </button>
  )
}

/* ── DSH 0.1.5+ 内建右侧栏（ui-sidebar-right）─────────────────────────────
 * 契约：`ctx.sidebarRightTabs.register({ id, kind, title, guide })` 定义页签类型；
 * 正文注册进槽位 `sidebar.right.pane.tab`、标题芯片注册进
 * `sidebar.right.pane.tab.title`，两者的 entryKey 都是 definition.id。
 * 用户从右侧栏的引导胶囊（guide 条目）点开 → openTab(kind)。
 * ──────────────────────────────────────────────────────────────────────── */

/** 页签标题芯片：图标 + 标题（标题来自宿主 hookContext 的 useTabInfo）。 */
export function TokenLensChip(props: { useTabInfo?: () => { tab?: { title?: string } } }): JSX.Element {
  const title = props.useTabInfo?.()?.tab?.title ?? 'Token Lens'
  return (
    <>
      <LensIcon size={16} />
      {title}
    </>
  )
}

/** 内建右侧栏的页签类型定义（guide = 右侧栏引导胶囊/「+」菜单里的入口）。 */
export function builtinTabDefinition(): Record<string, unknown> {
  return {
    id: 'dsh-token-lens',
    kind: 'token-lens',
    title: () => 'Token Lens',
    guide: [
      {
        order: 92,
        title: () => 'Token Lens',
        description: () => '全部会话的 token 用量统计',
        icon: (props: { size?: number }) => <LensIcon size={props?.size ?? 16} />,
      },
    ],
  }
}

type TabService = { registerTab: (descriptor: Record<string, unknown>) => unknown }
type Disposable = { dispose: () => void }

/** 兼容宿主 disposer 形态（disposable 对象或裸函数）。 */
function asDisposer(raw: unknown): Disposable | null {
  if (typeof raw === 'function') return { dispose: raw as () => void }
  if (typeof raw === 'object' && raw !== null && 'dispose' in raw) {
    return { dispose: (raw as { dispose: () => void }).dispose.bind(raw) }
  }
  return null
}

/**
 * 向 dsh-better-sidebar 注册 Token Lens 标签页（含 JSX，故置于 .tsx）。
 * 形态照抄 dsh-whale-report 的生产调用：id/title/icon/order/single/component。
 * 返回宿主 disposer 的规范化包装（调用即移除标签类型）。
 */
export function registerLensTab(service: TabService): Disposable | null {
  const disposer = asDisposer(
    service.registerTab({
      id: 'dsh-token-lens',
      title: 'Token Lens',
      icon: (size: number) => <LensIcon size={size} />,
      order: 92,
      single: true,
      component: () => <TokenLensTab />,
    }),
  )
  // 标签就位 → 兜底组件立刻退场（状态驱动，不依赖调用顺序）
  setLensTabRegistered(true)
  if (disposer === null) return null
  return {
    dispose: (): void => {
      disposer.dispose()
      setLensTabRegistered(false)
    },
  }
}


/* ── 以下为兜底入口：sidebar.footer.action 按钮 + 命令式全屏悬浮层 ── */

let overlayHost: HTMLDivElement | null = null
let overlayRoot: Root | null = null
let escHandler: ((e: KeyboardEvent) => void) | null = null

/** 关闭并完全卸载悬浮层（幂等）。插件 dispose 时也会调用，保证卸载即净。 */
export function closeLensOverlay(): void {
  if (escHandler !== null) {
    window.removeEventListener('keydown', escHandler)
    escHandler = null
  }
  if (overlayRoot !== null) {
    overlayRoot.unmount()
    overlayRoot = null
  }
  if (overlayHost !== null) {
    overlayHost.remove()
    overlayHost = null
  }
}

function openLensOverlay(): void {
  if (overlayHost !== null) return
  const host = document.createElement('div')
  host.dataset.tlOverlay = 'true'
  document.body.appendChild(host)
  overlayHost = host

  const mountedAt = Date.now()
  // 忽略挂载后极短时间内的关闭手势：防「打开它的同一次指针操作」的残留事件误关
  const onCloseGuarded = (): void => {
    if (Date.now() - mountedAt > 200) closeLensOverlay()
  }
  escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeLensOverlay()
  }
  window.addEventListener('keydown', escHandler)

  overlayRoot = createRoot(host)
  overlayRoot.render(
    <div
      className="tl-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseGuarded()
      }}
    >
      <div className="tl-modal">
        <button type="button" className="tl-close" onClick={closeLensOverlay} title="关闭（Esc）" aria-label="关闭 Token Lens">
          ×
        </button>
        <TokenLensPanel />
      </div>
    </div>,
  )
}

/** 兜底按钮点击：开合命令式悬浮层；stopPropagation 防宿主全局点击行为干扰。 */
export function toggleLensOverlay(): void {
  if (overlayHost !== null) closeLensOverlay()
  else openLensOverlay()
}

/** 兜底按钮组件：宽栏=文字行内钮，窄栏(56px rail)=图标圆钮；自身零状态。
 * 标签页一旦就位即渲染 null（状态驱动退场——顺序无关，见文件头说明）。 */
export function LensEntry(props: { wide?: boolean }): JSX.Element | null {
  const tabMode = useSyncExternalStore(subscribeTabMode, isLensTabRegistered, () => false)
  if (tabMode) return null
  const wide = props.wide !== false
  return (
    <button
      type="button"
      className={wide ? 'tl-entry tl-entry-wide' : 'tl-entry'}
      onClick={(e) => {
        e.stopPropagation()
        toggleLensOverlay()
      }}
      title="Token Lens · 全部会话的 token 用量统计"
      aria-label="Token Lens"
    >
      <span className="tl-entry-icon">◎</span>
      {wide ? <span className="tl-entry-text">Token Lens</span> : null}
    </button>
  )
}
