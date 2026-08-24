/**
 * 入口组件集合：better-sidebar 标签页（主入口）+ 侧边栏底部按钮（兜底）。
 *
 * 主入口（2026-08-23 按用户需求）：与终端/浏览器/深迹(DeepTrace) 同列，
 * 注册进 dsh-better-sidebar 的标签系统 —— 契约见其 lib/types/client/service.d.ts：
 * TabDescriptor{ id,title,icon,order,single,component }，component 收 TabComponentProps
 * 返回 ReactNode。DeepTrace 生产先例：dsh-whale-report lib/client.js registerTab 调用。
 * 兜底：better-sidebar 服务不存在时退回 sidebar.footer.action 按钮 + 命令式悬浮层。
 */
import { createRoot, type Root } from 'react-dom/client'
import { TokenLensPanel } from './panel'

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
  return asDisposer(
    service.registerTab({
      id: 'dsh-token-lens',
      title: 'Token Lens',
      icon: (size: number) => <LensIcon size={size} />,
      order: 92,
      single: true,
      component: () => <TokenLensTab />,
    }),
  )
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

/** 兜底按钮组件：宽栏=文字行内钮，窄栏(56px rail)=图标圆钮；自身零状态。 */
export function LensEntry(props: { wide?: boolean }): JSX.Element {
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
