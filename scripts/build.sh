#!/bin/bash
# 自包含构建脚本（Windows 友好，不依赖 DSH 源码 checkout）：
#   1) 定位全局安装的 @deepseek-ai/dsh 包（宿主同源 peer 来源）
#   2) junction 链接 @deepseek-ai/cordis、@deepseek-ai/dsh-tools 到本插件 node_modules
#      （与宿主运行时同源：defineTool 拿到的就是宿主同一模块实例族）
#   3) 本地 tsc（npm install 安装的 devDependencies）编译 src → lib
# client 半边由 dev_build_plugin 流水线另行调用 `npm run build:client`（tsdown）完成。
set -euo pipefail

# ── WSL 自愈：本插件的构建链全是 Windows 工具（Windows node_modules + junction），
# 若被 WSL bash 拉起（无原生 node），转投 Windows git-bash 重新执行本脚本。──
if [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null && ! command -v node >/dev/null 2>&1; then
  GITBASH=""
  # 首选：LOCALAPPDATA（Windows 形式）经 wslpath 转成 POSIX 路径
  if [ -n "${LOCALAPPDATA:-}" ]; then
    cand="$(wslpath -u "$LOCALAPPDATA" 2>/dev/null)/hermes/git/bin/bash.exe"
    [ -f "$cand" ] && GITBASH="$cand"
  fi
  # 兜底：通配扫描常见安装位置
  if [ -z "$GITBASH" ]; then
    for candidate in /mnt/c/Users/*/AppData/Local/hermes/git/bin/bash.exe "/mnt/c/Program Files/Git/bin/bash.exe"; do
      if [ -f "$candidate" ]; then GITBASH="$candidate"; break; fi
    done
  fi
  if [ -z "$GITBASH" ]; then
    echo "build: running under WSL without node and Windows git-bash not found" >&2
    exit 1
  fi
  SCRIPT_WIN="$(wslpath -w "$0" 2>/dev/null || echo "$0")"
  echo "build: WSL detected (no node) — re-exec via Windows git-bash: $GITBASH"
  exec "$GITBASH" "$SCRIPT_WIN"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 定位宿主 @deepseek-ai/dsh 包 ──
DSH_PKG="${DSH_PACKAGE:-}"
if [ -z "$DSH_PKG" ]; then
  for candidate in \
    "${APPDATA:-}/npm/node_modules/@deepseek-ai/dsh" \
    "$HOME/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh" \
    "$(npm root -g 2>/dev/null)/@deepseek-ai/dsh" \
    "/usr/lib/node_modules/@deepseek-ai/dsh"; do
    if [ -n "$candidate" ] && [ -d "$candidate/node_modules/@deepseek-ai/dsh-tools" ]; then
      DSH_PKG="$candidate"
      break
    fi
  done
fi
if [ -z "$DSH_PKG" ] || [ ! -d "$DSH_PKG/node_modules/@deepseek-ai/dsh-tools" ]; then
  echo "build: cannot locate installed @deepseek-ai/dsh package (set DSH_PACKAGE)" >&2
  exit 1
fi
echo "=== Peer source: $DSH_PKG ==="

# junction 链接一个 peer（幂等：已指向同一目标则跳过）
link_peer() {
  local link="$1"
  local target="$2"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      const real = fs.realpathSync(link);
      if (real === target) { console.log('link ok (existing):', link); process.exit(0); }
    } catch {}
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    console.log('linked:', link, '->', target);
  " "$link" "$target"
}

mkdir -p node_modules/@deepseek-ai
link_peer "node_modules/@deepseek-ai/cordis" "$DSH_PKG/node_modules/@deepseek-ai/cordis"
link_peer "node_modules/@deepseek-ai/dsh-tools" "$DSH_PKG/node_modules/@deepseek-ai/dsh-tools"

# ── 编译 host 半边（client 由 tsdown 单独打包，src/client 不参与 tsc）──
TSC="node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: local typescript missing — run: npm install" >&2
  exit 1
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Host build complete ==="
