/**
 * 面板主题 v3（2026-08-23 重设计 · vB「柔和卡片」方向，用户选定）。
 *
 * 设计语言：Apple 健康式大圆角无边框卡片（层级底色抬升而非描边）× Plausible 单列克制排布；
 * 母题「流量计量」：hero 卡三段比例细条、四系列渐变堆叠柱、命中率环形计量。
 * 配色基底使用宿主设计变量（--dsw-alias-*），带独立预览兜底值；深浅色双套显式定义。
 * 个性点缀预算：数据系列四色 + 单强调色，其余全部继承宿主。
 */
export const PANEL_CSS = `
/* ── token 层：宿主变量优先，逗号后为独立预览兜底 ── */
.tl-root {
  /* 背景层级 */
  --tl-bg1: var(--dsw-alias-bg-layer-1, #101418);
  --tl-bg2: var(--dsw-alias-bg-layer-2, #171c22);
  --tl-bg3: var(--dsw-alias-bg-layer-3, #1e242b);
  /* 文字 */
  --tl-fg: var(--dsw-alias-label-primary, #e8edf2);
  --tl-fg2: var(--dsw-alias-label-secondary, #9aa7b4);
  --tl-fg3: var(--dsw-alias-label-tertiary, #697480);
  --tl-fgd: var(--dsw-alias-label-dimmed, #454f59);
  /* 描边与交互 */
  --tl-bd: var(--dsw-alias-border-l2, rgba(154, 167, 180, .14));
  --tl-hov: var(--dsw-alias-interactive-bg-hover, rgba(154, 167, 180, .10));
  /* 数据系列语义色（深色） */
  --tl-s-input: #6cb2ff;
  --tl-s-cr: #52cdb4;
  --tl-s-cw: #b49af0;
  --tl-s-out: #ffb066;
  /* 模型榜六色（深色） */
  --tl-m1: #6cb2ff; --tl-m2: #52cdb4; --tl-m3: #ffb066;
  --tl-m4: #e79ab0; --tl-m5: #a48adf; --tl-m6: #8fb573;
  --tl-up: #63d08a;
  --tl-down: #ef8e76;
  --tl-accent: #6cb2ff;
}
@media (prefers-color-scheme: light) {
  .tl-root {
    --tl-bg1: var(--dsw-alias-bg-layer-1, #ffffff);
    --tl-bg2: var(--dsw-alias-bg-layer-2, #f5f7f9);
    --tl-bg3: var(--dsw-alias-bg-layer-3, #eceff2);
    --tl-fg: var(--dsw-alias-label-primary, #1a2129);
    --tl-fg2: var(--dsw-alias-label-secondary, #5a6572);
    --tl-fg3: var(--dsw-alias-label-tertiary, #8a939e);
    --tl-fgd: var(--dsw-alias-label-dimmed, #c3cad1);
    --tl-bd: var(--dsw-alias-border-l2, rgba(26, 33, 41, .10));
    --tl-hov: var(--dsw-alias-interactive-bg-hover, rgba(26, 33, 41, .05));
    --tl-s-input: #2f6fce;
    --tl-s-cr: #0f9080;
    --tl-s-cw: #7a58cf;
    --tl-s-out: #d9730f;
    --tl-m1: #2f6fce; --tl-m2: #0f9080; --tl-m3: #d9730f;
    --tl-m4: #c2597a; --tl-m5: #7a58cf; --tl-m6: #4f7d33;
    --tl-up: #188a42;
    --tl-down: #c2452c;
    --tl-accent: #2f6fce;
  }
}

.tl-root {
  height: 100%;
  overflow: auto;
  color: var(--tl-fg);
  font-size: 13px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  text-wrap: pretty;
}
.tl-wrap { max-width: 880px; margin: 0 auto; padding: 12px 14px 18px; display: flex; flex-direction: column; gap: 10px; container-type: inline-size; }

/* ── 头部条（非卡片）── */
.tl-hd { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.tl-hd h1 { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
.tl-fresh { display: inline-flex; align-items: center; gap: 5px; color: var(--tl-fg3); font-size: 11px; white-space: nowrap; }
.tl-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tl-up); flex: none; }
.tl-dot.stale { background: var(--tl-s-out); }
.tl-dot.err { background: var(--tl-down); }
.tl-spacer { flex: 1; }
.tl-iconbtn { width: 28px; height: 28px; border: none; border-radius: 50%; background: transparent; color: var(--tl-fg2); cursor: pointer; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; }
.tl-iconbtn:hover { background: var(--tl-hov); }
.tl-spin { animation: tl-rot .8s linear infinite; display: inline-block; }
@keyframes tl-rot { to { transform: rotate(360deg); } }

/* 分段切换：胶囊居中 */
.tl-segrow { display: flex; justify-content: center; }
.tl-seg { display: inline-flex; background: var(--tl-bg3); border-radius: 999px; padding: 2px; gap: 2px; }
.tl-seg button { appearance: none; border: none; background: transparent; color: var(--tl-fg2); font: inherit; font-size: 12px; padding: 3px 13px; border-radius: 999px; cursor: pointer; transition: color .15s; }
.tl-seg button:hover { color: var(--tl-fg); }
.tl-seg button.on { background: var(--tl-bg1); color: var(--tl-fg); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .14); }

/* ── 卡片：无描边、层级底抬升、大圆角 ── */
.tl-card { background: var(--tl-bg2); border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.tl-ch2 { font-size: 12px; font-weight: 600; color: var(--tl-fg2); letter-spacing: .3px; display: flex; align-items: baseline; gap: 8px; }
.tl-ch2 .r { margin-left: auto; font-weight: 400; color: var(--tl-fg3); font-size: 11px; }

/* ── Hero：本周期用量 ── */
.tl-hero-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.tl-hero-num { font-size: 34px; font-weight: 700; line-height: 1.05; letter-spacing: -.5px; }
.tl-chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 9px; font-size: 11.5px; font-weight: 600; }
.tl-chip.up { color: var(--tl-down); background: var(--tl-hov); background: color-mix(in srgb, var(--tl-down) 14%, transparent); }
.tl-chip.down { color: var(--tl-up); background: var(--tl-hov); background: color-mix(in srgb, var(--tl-up) 14%, transparent); }
.tl-hero-sub { color: var(--tl-fg3); font-size: 11.5px; }
/* 三段比例细条：流量计量母题 */
.tl-mixbar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 2px; }
.tl-mixbar i { border-radius: 2px; }
.tl-legend { display: flex; gap: 12px; flex-wrap: wrap; color: var(--tl-fg3); font-size: 11px; }
.tl-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2.5px; margin-right: 5px; }
.tl-hero-bottom { display: flex; align-items: flex-end; gap: 14px; }
.tl-hero-cap { color: var(--tl-fg2); font-size: 12px; line-height: 1.65; flex: 1; min-width: 0; }
.tl-ring-wrap { margin-left: auto; text-align: center; flex: none; }
.tl-ring { position: relative; width: 74px; height: 74px; }
.tl-ring svg { transform: rotate(-90deg); display: block; }
.tl-ring-val { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; }
.tl-ring-val b { font-size: 17px; font-weight: 700; }
.tl-ring-val span { font-size: 9.5px; color: var(--tl-fg3); }
.tl-ring-cap { font-size: 10.5px; color: var(--tl-fg3); margin-top: 4px; }

/* 迷你三格 */
.tl-mini3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.tl-mini { background: var(--tl-bg2); border-radius: 14px; padding: 10px 12px; }
.tl-mini b { display: block; font-size: 18px; font-weight: 700; letter-spacing: -.2px; }
.tl-mini span { font-size: 11px; color: var(--tl-fg3); }

/* ── 趋势图 ── */
.tl-chartbox { position: relative; }
.tl-chartbox svg { display: block; width: 100%; height: 150px; }
.tl-tip { position: absolute; pointer-events: none; background: var(--tl-bg1); border: 1px solid var(--tl-bd); border-radius: 10px; padding: 7px 10px; font-size: 11px; line-height: 1.55; box-shadow: 0 4px 16px rgba(0, 0, 0, .18); opacity: 0; transition: opacity .12s; white-space: nowrap; z-index: 3; }
.tl-tip b { font-weight: 650; }
.tl-tip.on { opacity: 1; }
.tl-axis { display: flex; justify-content: space-between; color: var(--tl-fgd); font-size: 10px; margin-top: 4px; }

/* ── 模型占比 ── */
.tl-spectrum { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; margin-bottom: 4px; }
.tl-spectrum i { min-width: 3px; }
.tl-mrow { padding: 7px 0; border-top: 1px solid var(--tl-bd); display: flex; flex-direction: column; gap: 5px; }
.tl-mrow.hl { border-top: none; padding-top: 2px; }
.tl-mline { display: flex; align-items: baseline; gap: 8px; }
.tl-mname { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; font-size: 12px; }
.tl-mname em { font-style: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-mname i { width: 8px; height: 8px; border-radius: 2.5px; flex: none; }
.tl-mpct { font-weight: 650; font-size: 12px; }
.tl-mtok { color: var(--tl-fg3); font-size: 11px; min-width: 60px; text-align: right; }
.tl-mtrack { height: 5px; border-radius: 2.5px; background: var(--tl-bg3); overflow: hidden; }
.tl-mtrack i { display: block; height: 100%; border-radius: 2.5px; }

/* ── 24h 热力 ── */
.tl-heat { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
.tl-heat i { flex: 1; border-radius: 3px 3px 1px 1px; background: var(--tl-accent); }
.tl-haxis { display: flex; justify-content: space-between; color: var(--tl-fgd); font-size: 10px; margin-top: 5px; }

/* ── Top 会话 ── */
.tl-trow { display: flex; gap: 9px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--tl-bd); }
.tl-trow.hl { border-top: none; padding-top: 2px; }
.tl-trank { color: var(--tl-accent); font-weight: 700; font-size: 11px; min-width: 15px; text-align: right; }
.tl-ttitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.tl-tval { color: var(--tl-fg3); font-size: 11px; white-space: nowrap; }

/* 杂项 */
.tl-note { color: var(--tl-fgd); font-size: 10.5px; padding: 0 4px; line-height: 1.6; }
.tl-warn { color: var(--tl-s-out); font-size: 11.5px; }
.tl-empty { padding: 26px 0; text-align: center; color: var(--tl-fg3); }
.tl-error { border: 1px solid var(--tl-down); border-radius: 12px; background: var(--tl-bg2); padding: 10px 14px; display: flex; gap: 10px; align-items: center; color: var(--tl-down); font-size: 12px; }
.tl-btn { appearance: none; border: 1px solid var(--tl-bd); background: transparent; color: var(--tl-fg); font: inherit; font-size: 12px; border-radius: 8px; padding: 3px 11px; cursor: pointer; }
.tl-btn:hover { background: var(--tl-hov); }
.tl-skel { position: relative; overflow: hidden; background: var(--tl-bg3); border-radius: 6px; height: 12px; }
.tl-skel::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, var(--tl-hov), transparent); animation: tl-shimmer 1.4s infinite; }
@keyframes tl-shimmer { to { transform: translateX(100%); } }

/* ── 效率速览卡（左下配重）── */
.tl-eff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tl-eff > div { background: var(--tl-bg3); border-radius: 10px; padding: 9px 12px; min-width: 0; }
.tl-eff b { display: block; font-size: 16px; font-weight: 700; letter-spacing: -.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-eff span { font-size: 10.5px; color: var(--tl-fg3); }

/* ── 宽态：容器查询（按面板实际宽度，而非视口——抽屉里才不会误触发两列）── */
@container (min-width: 540px) {
  .tl-wrap { max-width: none; }
  .tl-cols { display: grid; grid-template-columns: 11fr 9fr; gap: 10px; align-items: start; }
  .tl-colv { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
}
`
