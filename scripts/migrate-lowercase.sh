#!/usr/bin/env bash
#
# migrate-lowercase.sh —— 把运行目录与程序名统一改为小写
#
# 背景：
#   早期版本用 EasyTier-Console.exe + D:\EasyTier-Console 目录，
#   在 Linux/脚本环境下大小写混用容易出错，统一改成 easytier-console。
#
# 这个脚本会做 6 件事，任何一步失败都自动回滚：
#   1. 停止面板与核心
#   2. 备份自启快捷方式并在迁移后重建
#   3. 目录改名 D:\EasyTier-Console → D:\easytier-console
#   4. 替换 exe 为 easytier-console.exe
#   5. 重建自启快捷方式
#   6. 校验（目录、exe、快捷方式、能否启动）
#
# 用法：
#   bash scripts/migrate-lowercase.sh            # 执行迁移
#   bash scripts/migrate-lowercase.sh --dry-run  # 只看会做什么
#
set -uo pipefail

OLD_DIR="${OLD_DIR:-/d/EasyTier-Console}"
NEW_DIR="${NEW_DIR:-/d/easytier-console}"
OLD_EXE="EasyTier-Console.exe"
NEW_EXE="easytier-console.exe"
OLD_LNK="EasyTier Console.lnk"
NEW_LNK="easytier-console.lnk"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
run()  {
  if [ "$DRY" = "1" ]; then
    printf "  \033[90m[dry-run]\033[0m %s\n" "$*"
  else
    eval "$@"
  fi
}

STARTUP_DIR="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
[ -d "$STARTUP_DIR" ] || STARTUP_DIR="$HOME/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"

# ---------- 前置检查 ----------
step "[1/6] 前置检查"

if [ ! -d "$OLD_DIR" ] && [ ! -d "$NEW_DIR" ]; then
  err "两个目录都不存在，无需迁移"
  exit 1
fi

# 判断是否已完成迁移：新目录里有新 exe，且旧目录已不存在
ALREADY=0
if [ -d "$NEW_DIR" ] && [ -f "$NEW_DIR/$NEW_EXE" ] && [ ! -d "$OLD_DIR" ]; then
  ALREADY=1
fi

if [ "$ALREADY" = "1" ]; then
  ok "已完成迁移：$NEW_DIR/$NEW_EXE"
  echo ""
  ok "无需重复迁移，退出"
  exit 0
fi

NEED_MIGRATE=1

# 关键检查：两个目录同时存在 → 危险，可能是历史误操作留下的副本
if [ -d "$OLD_DIR" ] && [ -d "$NEW_DIR" ]; then
  warn "检测到两个目录同时存在："
  echo "       旧: $OLD_DIR"
  echo "       新: $NEW_DIR"
  echo ""
  echo "     这通常是历史操作遗留的副本。请先确认哪个是真实数据："
  echo "       · 查自启快捷方式指向哪个"
  echo "       · 对比 config/config.toml 是否一致"
  echo "       · 看 logs/ 里哪个有最近的运行日志"
  echo ""
  echo "     确认后可手动删除多余的目录，再重新运行本脚本。"
  echo "     或用参数指定：NEW_DIR=/d/xxx bash $0"
  err "为避免数据丢失，已中止"
  exit 2
fi

ok "需要迁移：$OLD_DIR → $NEW_DIR"

if [ "$DRY" = "1" ]; then warn "dry-run 模式，不会真的修改"; fi

# ---------- 停止进程 ----------
step "[2/6] 停止面板与核心"

if tasklist //FI "IMAGENAME eq $OLD_EXE" 2>/dev/null | grep -qi "$OLD_EXE"; then
  run "taskkill //F //IM '$OLD_EXE' >/dev/null 2>&1"
  ok "已停止 $OLD_EXE"
else
  ok "面板未运行"
fi

if tasklist //FI "IMAGENAME eq easytier-core.exe" 2>/dev/null | grep -qi "easytier-core"; then
  run "taskkill //F //IM easytier-core.exe >/dev/null 2>&1"
  ok "已停止 easytier-core"
else
  ok "核心未运行"
fi

[ "$DRY" = "0" ] && sleep 2

# ---------- 备份状态（用于回滚）----------
step "[3/6] 备份当前状态"

BACKUP_LNK=""
if [ -f "$STARTUP_DIR/$OLD_LNK" ]; then
  BACKUP_LNK="$STARTUP_DIR/$OLD_LNK.migrating"
  run "mv -f '$STARTUP_DIR/$OLD_LNK' '$BACKUP_LNK'"
  ok "已移走旧快捷方式（迁移后重建）"
else
  ok "无旧快捷方式"
fi

RENAMED=0

rollback() {
  err "迁移失败，开始回滚…"
  if [ "$RENAMED" = "1" ] && [ -d "$NEW_DIR" ] && [ ! -d "$OLD_DIR" ]; then
    mv "$NEW_DIR" "$OLD_DIR" 2>/dev/null && warn "目录已还原：$OLD_DIR"
  fi
  if [ -n "$BACKUP_LNK" ] && [ -f "$BACKUP_LNK" ]; then
    mv -f "$BACKUP_LNK" "$STARTUP_DIR/$OLD_LNK" 2>/dev/null && warn "快捷方式已还原"
  fi
  err "已回滚，程序仍可用旧路径启动"
  exit 1
}

# ---------- 目录改名 ----------
step "[4/6] 目录改名"

if [ -d "$OLD_DIR" ] && [ ! -d "$NEW_DIR" ]; then
  if ! run "mv '$OLD_DIR' '$NEW_DIR'"; then
    rollback
  fi
  RENAMED=1
  ok "目录已改名：$NEW_DIR"
elif [ -d "$NEW_DIR" ]; then
  ok "新目录已存在，跳过改名"
else
  err "找不到源目录"
  rollback
fi

[ "$DRY" = "0" ] && [ ! -d "$NEW_DIR" ] && { err "改名后目录不存在"; rollback; }

# ---------- 替换 exe ----------
step "[5/6] 替换程序文件"

if [ -f "$NEW_DIR/$OLD_EXE" ]; then
  run "mv -f '$NEW_DIR/$OLD_EXE' '$NEW_DIR/$NEW_EXE'"
  ok "$OLD_EXE → $NEW_EXE"
else
  warn "旧 exe 不存在，跳过改名"
fi

# 如果构建产物已就绪，顺便更新
SRC_EXE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/target/release/easytier-console.exe"
if [ -f "$SRC_EXE" ]; then
  run "cp -f '$SRC_EXE' '$NEW_DIR/$NEW_EXE'"
  ok "已部署最新编译产物"
fi

# ---------- 重建自启快捷方式 ----------
step "[6/6] 重建自启快捷方式"

if [ -n "$BACKUP_LNK" ] || [ -f "$STARTUP_DIR/$OLD_LNK.migrating" ]; then
  # 用 PowerShell 重建（.lnk 二进制格式手写不可靠）
  if [ "$DRY" = "1" ]; then
    printf "  \033[90m[dry-run]\033[0m 重建快捷方式 → %s\n" "$NEW_DIR/$NEW_EXE"
  else
    PS_SCRIPT=$(cat <<PSEOF
\$ErrorActionPreference='Stop'
try {
  \$sh = New-Object -ComObject WScript.Shell
  \$lnk = \$sh.CreateShortcut("$STARTUP_DIR\\$NEW_LNK")
  \$lnk.TargetPath = "$NEW_DIR\\$NEW_EXE"
  \$lnk.WorkingDirectory = "$NEW_DIR"
  \$lnk.Description = "easytier-console"
  \$lnk.Save()
  Write-Output "OK"
} catch {
  Write-Output "FAIL"
}
PSEOF
)
    RESULT=$(powershell -NoProfile -NonInteractive -Command "$PS_SCRIPT" 2>/dev/null | tr -d '\r\n ')
    if [ "$RESULT" = "OK" ]; then
      ok "自启快捷方式已重建：$NEW_LNK"
      rm -f "$STARTUP_DIR/$OLD_LNK.migrating" 2>/dev/null
    else
      warn "快捷方式重建失败，请手动在设置里重新开启「开机自启」"
    fi
  fi
else
  ok "未启用自启，无需重建"
fi

# ---------- 校验 ----------
step "校验"

FAIL=0
[ -d "$NEW_DIR" ] && ok "目录存在" || { err "目录不存在"; FAIL=1; }
[ -f "$NEW_DIR/$NEW_EXE" ] && ok "exe 存在" || { err "exe 不存在"; FAIL=1; }
[ -f "$NEW_DIR/config/config.toml" ] && ok "配置文件保留" || warn "配置文件缺失（可能需要重新配置）"
[ ! -d "$OLD_DIR" ] && ok "旧目录已清除" || warn "旧目录仍在"

if [ "$FAIL" = "0" ]; then
  echo ""
  ok "迁移完成"
  echo "     新路径: $NEW_DIR/$NEW_EXE"
  echo "     建议先手动启动一次确认能正常运行"
else
  rollback
fi
