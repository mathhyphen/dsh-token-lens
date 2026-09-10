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


/* ── 悬浮卡片：顶层（top layer）`<dialog showModal()>` 承载 ──
 * 2026-09-10 v0.3.5：从「body 里 position:fixed 的 div」换成原生 dialog。
 * 理由：fixed 元素会被任何带 transform/filter/backdrop-filter 的祖先当成包含块
 * （皮肤/动效插件很容易加），一旦被劫持就会渲染到视口外——表现正是"点了没反应"。
 * dialog 走浏览器顶层渲染，免疫堆叠上下文与包含块；Esc / 遮罩点击原生可用，
 * 免掉自己维护 keydown 监听。 */

let overlayHost: HTMLDialogElement | null = null
let overlayRoot: Root | null = null
let overlayOpenedAt = 0

/** 关闭并完全卸载悬浮层（幂等）。插件 dispose 时也会调用，保证卸载即净。 */
export function closeLensOverlay(): void {
  if (overlayRoot !== null) {
    overlayRoot.unmount()
    overlayRoot = null
  }
  const host = overlayHost
  overlayHost = null
  if (host !== null) {
    try {
      if (host.open) host.close()
    } catch {
      /* 已关闭 */
    }
    host.remove()
  }
}

function openLensOverlay(): void {
  if (overlayHost !== null) return
  const dialog = document.createElement('dialog')
  dialog.className = 'tl-dialog'
  dialog.dataset.tlOverlay = 'true'
  document.body.appendChild(dialog)
  overlayHost = dialog
  overlayOpenedAt = Date.now()

  // Esc：原生 cancel 事件（阻止默认的"直接关掉"，交给统一出口做清理）
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeLensOverlay()
  })
  // 点遮罩关闭：dialog 自身即遮罩命中目标（内容在 .tl-modal 里）。
  // 400ms 窗口内忽略：连点/同一次指针操作的残留事件不该把刚开的卡片关掉。
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && Date.now() - overlayOpenedAt > 400) closeLensOverlay()
  })

  overlayRoot = createRoot(dialog)
  overlayRoot.render(
    <div className="tl-modal" role="dialog" aria-modal="true" aria-label="Token Lens">
      <button type="button" className="tl-close" onClick={closeLensOverlay} title="关闭（Esc）" aria-label="关闭 Token Lens">
        ×
      </button>
      <TokenLensPanel />
    </div>,
  )
  try {
    dialog.showModal()
  } catch (error) {
    // 极老的内核没有 showModal：退回 open 属性（仍渲染，只是不在顶层）
    console.warn('[token-lens] showModal 不可用，退回普通浮层：', error)
    dialog.setAttribute('open', '')
  }
  console.info('[token-lens] 悬浮卡片已打开')
}

/** 开合悬浮层。同一指针操作可能派发两次 click（连点/宿主冒泡），
 * 用 300ms 窗口忽略紧随其后的一次，避免"点一下开了又关"。 */
export function toggleLensOverlay(): void {
  if (overlayHost !== null) {
    if (Date.now() - overlayOpenedAt < 400) return
    closeLensOverlay()
    console.info('[token-lens] 悬浮卡片已关闭')
  } else openLensOverlay()
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
