#!/usr/bin/env node
/**
 * smoke-client-entry.mjs — 入口退场契约回归（2026-09-08「左侧边栏底部多出 Token Lens 按钮」事故）
 *
 * 事故根因：兜底入口（sidebar.footer.action）此前靠「标签注册成功后 dispose」撤除，
 * 依赖两个回调的先后顺序。DSH 更新后 footer 槽位声明晚于标签注册时，dispose 时
 * footerDisposer 仍是 null，按钮注册后就再没人撤 → 左侧栏底部常驻一个 Token Lens。
 * 修复：改为状态驱动（useSyncExternalStore + 模块级 tabRegistered），并兼容
 * 「同 id 已注册」的重复加载场景。
 *
 * 本脚本直接跑构建产物 lib/client.js（浏览器 __ModuleLoader__ 形态），用最小
 * ctx / react 桩覆盖四种时序。运行：node tests/smoke-client-entry.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const SRC = readFileSync(BUNDLE, 'utf8')

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS | ${label}`)
  } else {
    fail += 1
    console.log(`FAIL | ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 最小 react / react-dom 桩（bundle 只 require 这三个）。 */
const REACT_STUBS = {
  react: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
  'react/jsx-runtime': {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  },
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
}
const requireStub = (id) => {
  if (id in REACT_STUBS) return REACT_STUBS[id]
  throw new Error(`unexpected require(${id})`)
}

/** 每个场景重新求值一次 bundle，拿到全新的模块级状态。 */
function loadBundle() {
  let captured = null
  const windowStub = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  new Function('window', SRC)(windowStub)
  if (captured === null) throw new Error('bundle 未调用 __ModuleLoader__.load')
  return captured.factory(requireStub)
}

/** 最小 document 桩（apply 里 ensureStyles 用）。 */
function installDom() {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  }
}

/** 记录用控制台捕获。 */
function captureConsole() {
  const seen = { info: [], warn: [], error: [] }
  const saved = {}
  for (const level of ['info', 'warn', 'error']) {
    saved[level] = console[level]
    console[level] = (...args) => seen[level].push(args.map(String).join(' '))
  }
  return {
    seen,
    restore: () => {
      for (const level of ['info', 'warn', 'error']) console[level] = saved[level]
    },
  }
}

/**
 * 最小 ctx 桩。deferSlot=true 模拟「footer 槽位声明晚于标签注册」的时序。
 * service 为 betterSidebar 桩（registerTab / getTab 行为由场景给定）。
 */
function makeCtx({ service, deferSlot, headerSlot = true }) {
  const log = { slotsRegistered: [], disposed: [] }
  let pendingSlotCallback = null
  const slots = {
    inject(key, callback) {
      // headerSlot=false：模拟宿主没有会话头部槽位（此时兜底链才轮到 footer）
      if (key === 'conversation.session.header.actions' && !headerSlot) return () => {}
      // 只延迟兜底槽位（sidebar.footer.action）的声明——模拟「footer 声明晚于标签注册」
      if (deferSlot && key === 'sidebar.footer.action') {
        pendingSlotCallback = callback
        return () => {}
      }
      callback()
      return () => {}
    },
    register(spec, component) {
      const record = { spec, component, disposed: false }
      log.slotsRegistered.push(record)
      const dispose = () => {
        if (record.disposed) return
        record.disposed = true
        log.disposed.push(spec.name)
      }
      dispose.dispose = dispose
      return dispose
    },
  }
  const ctx = {
    slots,
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    inject(_deps, callback) {
      callback({ betterSidebar: service })
    },
  }
  return {
    ctx,
    log,
    runDeferredSlot: () => {
      const cb = pendingSlotCallback
      pendingSlotCallback = null
      return cb === null ? null : cb()
    },
  }
}

installDom()

/** 兜底槽位的注册记录（0.3.3 起还有头部入口槽位，断言必须按槽位过滤）。 */
const FOOTER = 'sidebar.footer.action'
const HEADER = 'conversation.session.header.actions'
const footerRegs = (log) => log.slotsRegistered.filter((r) => r.spec.name === FOOTER)
const headerRegs = (log) => log.slotsRegistered.filter((r) => r.spec.name === HEADER)
const footerDisposed = (log) => log.disposed.filter((n) => n === FOOTER).length

/** 渲染兜底组件一次（bundle 不导出 LensEntry，只能经 slots.register 拿）。 */
function renderFooter(log) {
  const first = footerRegs(log)[0]
  return first === undefined ? undefined : first.component({ wide: true })
}

/* ── A 正常（宿主无头部槽位）：标签注册成功 → 兜底注册被撤 + 兜底组件渲染 null ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const { ctx, log } = makeCtx({ service: { registerTab: () => () => {} }, deferSlot: false, headerSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  cap.restore()
  check('A 正常：兜底注册过且被撤', footerRegs(log).length === 1 && footerDisposed(log) === 1, `footers=${footerRegs(log).length} disposed=${footerDisposed(log)}`)
  check('A 正常：兜底组件渲染 null', entry === null, `entry=${entry === null ? 'null' : typeof entry}`)
}

/* ── B 竞态：footer 槽位声明晚于标签注册 → 兜底根本不注册 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const { ctx, log, runDeferredSlot } = makeCtx({ service: { registerTab: () => () => {} }, deferSlot: true, headerSlot: false })
  mod.apply(ctx)
  runDeferredSlot() // 槽位现在才声明
  cap.restore()
  check('B 竞态：兜底不再注册', footerRegs(log).length === 0, `footers=${footerRegs(log).length}`)
}

/* ── B2 宿主机有头部槽位：头部入口就位 → 兜底永不注册 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const { ctx, log } = makeCtx({ service: { registerTab: () => () => {} }, deferSlot: false, headerSlot: true })
  mod.apply(ctx)
  const headerEntry = headerRegs(log)[0]?.component()
  const entry = renderFooter(log)
  cap.restore()
  check('B2 头部：头部入口已注册', headerRegs(log).length === 1, `header=${headerRegs(log).length}`)
  check('B2 头部：兜底永不注册', footerRegs(log).length === 0, `footers=${footerRegs(log).length}`)
  check('B2 头部：头部入口渲染按钮', headerEntry !== null && headerEntry !== undefined, 'header=null')
  check('B2 头部：无兜底组件可渲染', entry === undefined, `entry=${typeof entry}`)
}

/* ── C 重复注册（同 id 已在册，宿主无头部槽位）→ 视为就位，兜底被撤 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const duplicate = new Error('[dsh-better-sidebar] tab type "dsh-token-lens" already registered')
  const service = { registerTab: () => { throw duplicate }, getTab: () => ({ id: 'dsh-token-lens' }) }
  const { ctx, log } = makeCtx({ service, deferSlot: false, headerSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  const warned = cap.seen.warn.some((line) => line.includes('标签已存在'))
  const errors = cap.seen.error.length
  cap.restore()
  check('C 重复：兜底被撤', footerDisposed(log) === 1, `disposed=${footerDisposed(log)}`)
  check('C 重复：兜底组件渲染 null', entry === null, `entry=${entry === null ? 'null' : typeof entry}`)
  check('C 重复：打了 warn 而非 error', warned && errors === 0, `warn=${warned} error=${errors}`)
}

/* ── D 真失败（宿主无头部槽位）→ 兜底保留并报错 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const service = { registerTab: () => { throw new Error('boom') }, getTab: () => undefined }
  const { ctx, log } = makeCtx({ service, deferSlot: false, headerSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  const errored = cap.seen.error.some((line) => line.includes('标签注册失败'))
  cap.restore()
  check('D 失败：兜底保留（未撤）', footerDisposed(log) === 0, `disposed=${footerDisposed(log)}`)
  check('D 失败：兜底组件仍渲染按钮', entry !== null && entry !== undefined, 'entry=null')
  check('D 失败：打了 console.error', errored, `errors=${cap.seen.error.length}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
