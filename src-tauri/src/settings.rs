// ---------------------------------------------------------------- 应用设置
//
// 与 EasyTier 的 config.toml 完全分开：config.toml 是「组网配置」，
// 这里存的是「面板自身的行为偏好」（关闭窗口怎么处理、是否自启等）。
//
// 存放位置：<程序目录>/data/settings.json
//   刻意不放 %APPDATA%——保持绿色便携，拷走整个目录即迁移完成。
//
// 设计要点：
//   · 所有字段都有默认值，文件缺失/损坏时回退默认，不让程序起不来
//   · 用 #[serde(default)] 而非 Option，前端拿到的永远是完整对象
//   · 读取失败不报错（首次启动本来就没有文件），只有写入失败才提示

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// 关闭面板时是否同时停止核心
    ///
    /// 默认 false：保持与旧版本一致的行为。
    /// core 用 DETACHED_PROCESS 启动，与面板完全解耦，
    /// 这样面板崩溃/重启不影响组网。但用户想「关掉面板就断网」时需要开关。
    pub stop_core_on_exit: bool,

    /// 退出前是否弹窗二次确认
    ///
    /// 默认 true：退出即断网，误触代价高（尤其远程桌面场景，
    /// 关掉面板可能连不回来）。确认框里有「记住我的选择」。
    pub confirm_on_exit: bool,

    /// 启动时清理残留的核心进程
    ///
    /// 默认 true：这是解决「覆盖升级时提示文件使用中」的关键。
    /// 面板被任务管理器强杀或系统断电时，DETACHED 的 core 会成为孤儿，
    /// 一直占用 wintun.dll / easytier-core.exe。
    pub cleanup_orphan: bool,

    /// 关闭窗口时最小化到托盘（而不是退出）
    pub minimize_to_tray: bool,

    /// 开机自动启动面板
    pub autostart: bool,

    /// 启动面板后是否立即启动核心
    pub autostart_core: bool,

    /// 开机自启时是否直接最小化（不弹窗）
    pub start_minimized: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            stop_core_on_exit: false,
            confirm_on_exit: true,
            cleanup_orphan: true,
            minimize_to_tray: true,
            autostart: false,
            autostart_core: false,
            start_minimized: true,
        }
    }
}

fn data_dir() -> PathBuf {
    crate::root_dir().join("data")
}

fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

/// 读取设置。文件不存在或解析失败都返回默认值。
pub fn load_settings() -> AppSettings {
    let p = settings_file();
    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return AppSettings::default(),
    };
    serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("[settings] 解析失败，使用默认值: {e}");
        AppSettings::default()
    })
}

/// 保存设置。会先创建 data 目录。
pub fn save_settings(s: &AppSettings) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 data 目录失败: {e}"))?;
    let txt = serde_json::to_string_pretty(s).map_err(|e| format!("序列化失败: {e}"))?;
    let p = settings_file();
    // 先写临时文件再改名，避免写一半掉电留下损坏的 json
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, txt).map_err(|e| format!("写入设置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存设置失败: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------- 孤儿进程
//
// 背景（这是「覆盖升级提示文件使用中」的根因）：
//
//   core 用 DETACHED_PROCESS 启动，与面板没有进程父子关系。
//   正常从托盘退出时会调 stop_core()，但如果面板被任务管理器强杀、
//   或系统断电重启，core 就留了下来。它会一直占着：
//       resource/easytier-core.exe   ← 文件被锁，无法覆盖
//       resource/wintun.dll          ← 同上
//   还可能残留 et_* 虚拟网卡，导致下次建卡失败。
//
// 判定孤儿的安全边界：
//   只清理「父进程已经不存在」的 core。
//   如果有人同时在用官方 EasyTier 客户端（它也有 easytier-core.exe），
//   那个 core 的父进程是活着的官方客户端，我们绝不碰。
//
// 实现方式：
//   用 wmic 查进程父子关系。wmic 在新版 Windows 已废弃，
//   这里优先用 PowerShell 的 CIM，失败再退到 wmic，都失败则放弃
//   （宁可不清，也不能误杀）。

#[cfg(target_os = "windows")]
mod orphan {
    use crate::hidden_cmd;
    use std::collections::HashSet;
    use std::path::Path;

    /// 一条进程记录
    #[derive(Debug)]
    pub struct ProcInfo {
        pub pid: u32,
        pub ppid: u32,
        /// 进程名，仅用于日志排查
        #[allow(dead_code)]
        pub name: String,
    }

    /// 用 PowerShell CIM 枚举所有 easytier-core 进程及其父进程。
    ///
    /// 输出格式约定为每行 `pid|ppid`，减少解析复杂度。
    fn list_via_cim() -> Option<Vec<ProcInfo>> {
        let script = r#"
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='easytier-core.exe'" |
  ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }
"#;
        let out = hidden_cmd(Path::new("powershell"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        Some(parse_cim_output(&text))
    }

    /// 解析 CIM 输出（抽成纯函数便于单测）
    pub(super) fn parse_cim_output(text: &str) -> Vec<ProcInfo> {
        let mut v = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 2 {
                if let (Ok(pid), Ok(ppid)) = (parts[0].trim().parse(), parts[1].trim().parse()) {
                    let name = parts
                        .get(2)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_else(|| "easytier-core.exe".into());
                    v.push(ProcInfo { pid, ppid, name });
                }
            }
        }
        v
    }

    /// wmic 兜底（老系统 wmic 还能用）
    fn list_via_wmic() -> Option<Vec<ProcInfo>> {
        let out = hidden_cmd(Path::new("wmic"))
            .args([
                "process",
                "where",
                "name='easytier-core.exe'",
                "get",
                "ProcessId,ParentProcessId",
                "/format:csv",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut v = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("Node") {
                continue;
            }
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 3 {
                if let (Ok(ppid), Ok(pid)) = (parts[1].parse(), parts[2].parse()) {
                    v.push(ProcInfo { pid, ppid, name: "easytier-core.exe".into() });
                }
            }
        }
        Some(v)
    }

    /// 枚举所有 easytier-core 进程
    pub fn list_cores() -> Vec<ProcInfo> {
        list_via_cim()
            .or_else(list_via_wmic)
            .unwrap_or_default()
    }

    /// 判断一组 PID 里哪些还活着
    fn alive_pids(pids: &HashSet<u32>) -> HashSet<u32> {
        if pids.is_empty() {
            return HashSet::new();
        }
        // 用 tasklist 一次性查，避免逐个查询
        let out = hidden_cmd(Path::new("tasklist"))
            .args(["/FO", "CSV", "/NH"])
            .output();
        let mut alive = HashSet::new();
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                // CSV: "image","pid","session","...","mem"
                let cols: Vec<&str> = line.split("\",\"").collect();
                if cols.len() > 1 {
                    let pid_str = cols[1].trim_matches('"');
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pids.contains(&pid) {
                            alive.insert(pid);
                        }
                    }
                }
            }
        }
        alive
    }

    /// 扫描孤儿 core（父进程已不存在）
    ///
    /// 返回的 Vec 只包含确认安全的：
    ///   · 父进程 PID 不在当前存活进程列表里 → 孤儿
    ///   · 特别处理：父进程 PID 为 0 或等于自己（已被系统收养）
    pub fn find_orphans() -> Vec<ProcInfo> {
        let cores = list_cores();
        if cores.is_empty() {
            return Vec::new();
        }

        // 收集所有需要判断存活的 PID：core 自己和它们的父进程
        let mut need = HashSet::new();
        for c in &cores {
            need.insert(c.pid);
            if c.ppid > 0 {
                need.insert(c.ppid);
            }
        }
        let alive = alive_pids(&need);
        judge_orphans(cores, &alive)
    }

    /// 判定哪些是孤儿（抽成纯函数便于单测）
    ///
    /// 安全边界（宁可漏判，不可误杀）：
    ///   · ppid == 0    → 系统已回收父进程信息，视为孤儿
    ///   · ppid == pid  → 异常数据，视为孤儿
    ///   · ppid 不在存活集合 → 父进程已退出，孤儿
    ///   · 其余         → 父进程活着，不动
    pub(super) fn judge_orphans(
        cores: Vec<ProcInfo>,
        alive: &HashSet<u32>,
    ) -> Vec<ProcInfo> {
        cores
            .into_iter()
            .filter(|c| {
                if c.ppid == 0 || c.ppid == c.pid {
                    return true;
                }
                !alive.contains(&c.ppid)
            })
            .collect()
    }

    /// 结束指定进程（先礼后兵）
    pub fn kill_pid(pid: u32) -> bool {
        // 先优雅终止
        let _ = hidden_cmd(Path::new("taskkill"))
            .args(["/PID", &pid.to_string(), "/T"])
            .output();
        std::thread::sleep(std::time::Duration::from_millis(600));
        // 还在就强杀
        if alive_pids(&{
            let mut s = HashSet::new();
            s.insert(pid);
            s
        })
        .contains(&pid)
        {
            let _ = hidden_cmd(Path::new("taskkill"))
                .args(["/F", "/PID", &pid.to_string(), "/T"])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        true
    }
}

#[cfg(target_os = "windows")]
pub use orphan::{find_orphans, kill_pid, list_cores};

/// 清理孤儿 core，返回清理掉的 PID 列表
pub fn cleanup_orphan_cores() -> Vec<u32> {
    #[cfg(target_os = "windows")]
    {
        let orphans = find_orphans();
        let mut killed = Vec::new();
        for o in orphans {
            eprintln!("[orphan] 清理孤儿核心 pid={} ppid={}", o.pid, o.ppid);
            kill_pid(o.pid);
            killed.push(o.pid);
        }
        killed
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

// ---------------------------------------------------------------- 单元测试
//
// 这些测试不依赖真实进程，只验证解析与判定逻辑。
// 孤儿清理必须绝对安全（误杀会断掉用户正在用的组网），
// 所以判定规则要有明确的测试覆盖。

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use crate::settings::orphan::{parse_cim_output, judge_orphans, ProcInfo};
    use std::collections::HashSet;

    #[test]
    fn 解析正常输出() {
        let text = "1234|5678|easytier-core.exe\n9012|3456|easytier-core.exe\n";
        let v = parse_cim_output(text);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].pid, 1234);
        assert_eq!(v[0].ppid, 5678);
        assert_eq!(v[1].pid, 9012);
        assert_eq!(v[1].ppid, 3456);
    }

    #[test]
    fn 解析空输出() {
        assert!(parse_cim_output("").is_empty());
        assert!(parse_cim_output("\n\n  \n").is_empty());
    }

    #[test]
    fn 解析容错_含空白与换行符() {
        let text = "  1234 | 5678 | easytier-core.exe \r\n";
        let v = parse_cim_output(text);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pid, 1234);
        assert_eq!(v[0].ppid, 5678);
    }

    #[test]
    fn 解析跳过非法行() {
        let text = "abc|def\n1234|5678|easytier-core.exe\nonlyonepart\n";
        let v = parse_cim_output(text);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pid, 1234);
    }

    #[test]
    fn 解析_缺失名称字段时用默认名() {
        let text = "1234|5678\n";
        let v = parse_cim_output(text);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "easytier-core.exe");
    }

    /* ---------- 孤儿判定 ---------- */

    fn proc(pid: u32, ppid: u32) -> ProcInfo {
        ProcInfo { pid, ppid, name: "easytier-core.exe".into() }
    }

    #[test]
    fn 判定_父进程存活时不清理() {
        // core=1000，父进程=500 还活着
        let cores = vec![proc(1000, 500)];
        let mut alive = HashSet::new();
        alive.insert(500);
        alive.insert(1000);
        let orphans = judge_orphans(cores, &alive);
        assert!(orphans.is_empty(), "父进程存活时绝不能清理（会误杀用户的组网）");
    }

    #[test]
    fn 判定_父进程已退出时清理() {
        // core=1000，父进程=500 已不在存活列表
        let cores = vec![proc(1000, 500)];
        let mut alive = HashSet::new();
        alive.insert(1000);
        let orphans = judge_orphans(cores, &alive);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].pid, 1000);
    }

    #[test]
    fn 判定_父进程为0视为孤儿() {
        let cores = vec![proc(1000, 0)];
        let alive = HashSet::new();
        assert_eq!(judge_orphans(cores, &alive).len(), 1);
    }

    #[test]
    fn 判定_父进程等于自己视为孤儿() {
        let cores = vec![proc(1000, 1000)];
        let alive = HashSet::new();
        assert_eq!(judge_orphans(cores, &alive).len(), 1);
    }

    #[test]
    fn 判定_混合场景只清理真正的孤儿() {
        // 1000: 父 500 活着 → 保留
        // 2000: 父 600 已退出 → 清理
        // 3000: 父 0        → 清理
        let cores = vec![proc(1000, 500), proc(2000, 600), proc(3000, 0)];
        let mut alive = HashSet::new();
        alive.insert(500);
        alive.insert(1000);
        alive.insert(2000);
        alive.insert(3000);
        let orphans = judge_orphans(cores, &alive);
        assert_eq!(orphans.len(), 2);
        let pids: Vec<u32> = orphans.iter().map(|o| o.pid).collect();
        assert!(pids.contains(&2000));
        assert!(pids.contains(&3000));
        assert!(!pids.contains(&1000), "父进程存活的绝不能进清理列表");
    }

    #[test]
    fn 判定_无核心进程时返回空() {
        let orphans = judge_orphans(vec![], &HashSet::new());
        assert!(orphans.is_empty());
    }

    #[test]
    fn 设置默认值符合预期() {
        let s = AppSettings::default();
        // 关闭时不停核心（保持旧行为）
        assert!(!s.stop_core_on_exit, "关闭不停核心应为默认");
        // 退出需二次确认（防误触断网）
        assert!(s.confirm_on_exit, "退出确认应默认开启");
        // 启动时清理孤儿（解决文件占用）
        assert!(s.cleanup_orphan, "孤儿清理应默认开启");
        // 关闭最小化到托盘
        assert!(s.minimize_to_tray, "最小化到托盘应默认开启");
    }

    #[test]
    fn 设置可序列化往返() {
        let s = AppSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(s.stop_core_on_exit, back.stop_core_on_exit);
        assert_eq!(s.cleanup_orphan, back.cleanup_orphan);
    }

    #[test]
    fn 设置缺字段时用默认补齐() {
        // 老版本配置文件只有部分字段，新增字段应取默认值
        let partial = r#"{"autostart": true}"#;
        let s: AppSettings = serde_json::from_str(partial).unwrap();
        assert!(s.autostart);
        assert!(s.confirm_on_exit, "未提供的字段应取默认");
        assert!(s.cleanup_orphan, "未提供的字段应取默认");
    }
}
