#!/usr/bin/env bash
#
# build-and-sync.sh —— 编译 + 部署到运行目录
#
# 解决的问题：
#   开发目录 dist/ 是唯一构建输出，但程序实际从 D:\EasyTier-Console 运行。
#   以前手工 cp，容易忘了同步，导致「改了代码但打开的还是旧版」。
#
# 用法：
#   bash scripts/build-and-sync.sh           # 只同步 exe
#   bash scripts/build-and-sync.sh --build   # 先编译再同步
#   bash scripts/build-and-sync.sh --full    # 编译 + 同步全部（含 resource）
#
set -uo pipefail

# ---------- 路径配置 ----------
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$DEV_DIR/dist"
RUN_DIR="${EASYTIER_RUN_DIR:-/d/EasyTier-Console}"
EXE_NAME="EasyTier-Console.exe"

# ---------- 输出 ----------
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# ---------- 参数 ----------
DO_BUILD=0
DO_FULL=0
for a in "$@"; do
  case "$a" in
    --build) DO_BUILD=1 ;;
    --full)  DO_BUILD=1; DO_FULL=1 ;;
    -h|--help)
      sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) err "未知参数: $a"; exit 1 ;;
  esac
done

# ---------- 前置检查 ----------
step "[1/5] 环境检查"

if [ ! -d "$DIST_DIR" ]; then
  err "找不到构建输出目录: $DIST_DIR"
  exit 1
fi
ok "构建目录 $DIST_DIR"

if [ ! -d "$RUN_DIR" ]; then
  err "找不到运行目录: $RUN_DIR"
  echo "     可通过环境变量覆盖：EASYTIER_RUN_DIR=/d/xxx bash $0"
  exit 1
fi
ok "运行目录 $RUN_DIR"

# ---------- 编译 ----------
if [ "$DO_BUILD" = "1" ]; then
  step "[2/5] 编译（cargo tauri build）"

  # 必须先停掉进程，否则 exe 被占用无法覆盖
  if tasklist //FI "IMAGENAME eq $EXE_NAME" 2>/dev/null | grep -qi "$EXE_NAME"; then
    warn "程序正在运行，先停止"
    taskkill //F //IM "$EXE_NAME" >/dev/null 2>&1
    sleep 2
  fi
  # 核心也要停，避免占用 resource
  taskkill //F //IM easytier-core.exe >/dev/null 2>&1

  export PATH="$HOME/.cargo/bin:$PATH"
  BUILD_LOG=$(mktemp)
  if ( cd "$DEV_DIR" && cargo tauri build --no-bundle ) >"$BUILD_LOG" 2>&1; then
    ok "编译成功"
  else
    err "编译失败，最后 20 行日志："
    tail -20 "$BUILD_LOG"
    rm -f "$BUILD_LOG"
    exit 1
  fi
  # 检查是否有 warning（grep -c 无匹配时返回 1，需兜底成单个 0）
  W=$(grep -c "^warning" "$BUILD_LOG" 2>/dev/null | head -1)
  W=${W:-0}
  if [ "$W" -gt 0 ] 2>/dev/null; then
    warn "有 $W 条编译警告"
  fi
  rm -f "$BUILD_LOG"
else
  step "[2/5] 跳过编译（未指定 --build）"
fi

# ---------- 同步 exe ----------
step "[3/5] 同步 $EXE_NAME"

SRC_EXE="$DEV_DIR/src-tauri/target/release/easytier-console.exe"
if [ ! -f "$SRC_EXE" ]; then
  err "找不到编译产物: $SRC_EXE"
  exit 1
fi

# 先同步到 dist（作为归档副本）
cp -f "$SRC_EXE" "$DIST_DIR/$EXE_NAME" 2>/dev/null
ok "已更新 $DIST_DIR/$EXE_NAME"

# 停进程（新版覆盖前必须）
if tasklist //FI "IMAGENAME eq $EXE_NAME" 2>/dev/null | grep -qi "$EXE_NAME"; then
  warn "程序正在运行，先停止"
  taskkill //F //IM "$EXE_NAME" >/dev/null 2>&1
  sleep 2
fi

# 备份运行目录里的旧版（只留一份上次的）
if [ -f "$RUN_DIR/$EXE_NAME" ]; then
  cp -f "$RUN_DIR/$EXE_NAME" "$RUN_DIR/$EXE_NAME.bak" 2>/dev/null && ok "旧版已备份为 .bak"
fi

if cp -f "$SRC_EXE" "$RUN_DIR/$EXE_NAME" 2>/dev/null; then
  ok "已部署到 $RUN_DIR/$EXE_NAME"
else
  err "部署失败，可能 exe 被占用。请先手动退出程序（含托盘）"
  exit 1
fi

# ---------- 同步 resource（可选） ----------
if [ "$DO_FULL" = "1" ]; then
  step "[4/5] 同步 resource/ 与文档"
  for d in resource; do
    if [ -d "$DIST_DIR/$d" ]; then
      mkdir -p "$RUN_DIR/$d"
      cp -rf "$DIST_DIR/$d/." "$RUN_DIR/$d/" 2>/dev/null && ok "已同步 $d/"
    fi
  done
  for f in QUICKSTART.txt USAGE.md; do
    [ -f "$DIST_DIR/../build-release/pkg/EasyTier-Console/$f" ] && \
      cp -f "$DIST_DIR/../build-release/pkg/EasyTier-Console/$f" "$RUN_DIR/$f" 2>/dev/null && ok "已同步 $f"
  done
else
  step "[4/5] 跳过 resource 同步（--full 可同步）"
fi

# ---------- 校验 ----------
step "[5/5] 校验"

A=$(wc -c < "$SRC_EXE" 2>/dev/null | tr -d ' ')
B=$(wc -c < "$RUN_DIR/$EXE_NAME" 2>/dev/null | tr -d ' ')
if [ "$A" = "$B" ]; then
  ok "大小一致：$A 字节"
else
  err "大小不一致！构建=$A 运行=$B"
  exit 1
fi

HA=$(sha256sum "$SRC_EXE" 2>/dev/null | cut -d' ' -f1)
HB=$(sha256sum "$RUN_DIR/$EXE_NAME" 2>/dev/null | cut -d' ' -f1)
if [ "$HA" = "$HB" ]; then
  ok "哈希一致：${HA:0:16}..."
else
  err "哈希不一致，部署可能不完整"
  exit 1
fi

echo ""
ok "完成。可执行：$RUN_DIR/$EXE_NAME"
