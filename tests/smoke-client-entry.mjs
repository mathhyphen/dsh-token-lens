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
function makeCtx({ service, deferSlot }) {
  const log = { slotsRegistered: [], footerDisposed: 0 }
  let pendingSlotCallback = null
  const slots = {
    inject(_key, callback) {
      if (deferSlot) {
        pendingSlotCallback = callback
        return () => {}
      }
      callback()
      return () => {}
    },
    register(spec, component) {
      log.slotsRegistered.push({ spec, component })
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        log.footerDisposed += 1
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

/** 从注册记录里取兜底组件并渲染一次（bundle 不导出 LensEntry，只能经 slots.register 拿）。 */
function renderFooter(log) {
  const first = log.slotsRegistered[0]
  return first === undefined ? undefined : first.component({ wide: true })
}

/* ── A 正常：标签注册成功 → 兜底注册被撤 + 兜底组件渲染 null ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const { ctx, log } = makeCtx({ service: { registerTab: () => () => {} }, deferSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  cap.restore()
  check('A 正常：兜底注册过一次', log.slotsRegistered.length === 1, `registered=${log.slotsRegistered.length}`)
  check('A 正常：标签就位后兜底被撤', log.footerDisposed === 1, `disposed=${log.footerDisposed}`)
  check('A 正常：兜底组件渲染 null', entry === null, `entry=${entry === null ? 'null' : typeof entry}`)
}

/* ── B 竞态：footer 槽位声明晚于标签注册 → 兜底根本不注册 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const { ctx, log, runDeferredSlot } = makeCtx({ service: { registerTab: () => () => {} }, deferSlot: true })
  mod.apply(ctx)
  runDeferredSlot() // 槽位现在才声明
  cap.restore()
  check('B 竞态：兜底不再注册', log.slotsRegistered.length === 0, `registered=${log.slotsRegistered.length}`)
}

/* ── C 重复注册（同 id 已在册）→ 视为就位，兜底被撤 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const duplicate = new Error('[dsh-better-sidebar] tab type "dsh-token-lens" already registered')
  const service = { registerTab: () => { throw duplicate }, getTab: () => ({ id: 'dsh-token-lens' }) }
  const { ctx, log } = makeCtx({ service, deferSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  const warned = cap.seen.warn.some((line) => line.includes('标签已存在'))
  const errors = cap.seen.error.length
  cap.restore()
  check('C 重复：兜底被撤', log.footerDisposed === 1, `disposed=${log.footerDisposed}`)
  check('C 重复：兜底组件渲染 null', entry === null, `entry=${entry === null ? 'null' : typeof entry}`)
  check('C 重复：打了 warn 而非 error', warned && errors === 0, `warn=${warned} error=${errors}`)
}

/* ── D 真失败 → 保留兜底（按钮仍可用）并报错 ── */
{
  const cap = captureConsole()
  const mod = loadBundle()
  const service = { registerTab: () => { throw new Error('boom') }, getTab: () => undefined }
  const { ctx, log } = makeCtx({ service, deferSlot: false })
  mod.apply(ctx)
  const entry = renderFooter(log)
  const errored = cap.seen.error.some((line) => line.includes('标签注册失败'))
  cap.restore()
  check('D 失败：兜底保留（未撤）', log.footerDisposed === 0, `disposed=${log.footerDisposed}`)
  check('D 失败：兜底组件仍渲染按钮', entry !== null && entry !== undefined, 'entry=null')
  check('D 失败：打了 console.error', errored, `errors=${cap.seen.error.length}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
