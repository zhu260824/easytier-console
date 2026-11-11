// 防止 Windows 下弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// easytier-core 的 RPC 管理门户地址。
///
/// core 与 cli 必须一致：cli 默认连 127.0.0.1:15888，
/// 所以 core 启动时也固定监听这里，否则面板采集不到状态。
const RPC_PORTAL: &str = "127.0.0.1:15888";

// ---------------------------------------------------------------- 目录约定
//
// 全部路径都相对 exe 所在目录，形成「绿色便携」结构：
//
//   <exe 所在目录>/
//   ├── easytier-panel.exe        ← 只运行这一个
//   ├── config/
//   │   └── config.toml           ← EasyTier 配置
//   ├── logs/
//   │   └── easytier-runtime.log  ← 运行日志
//   └── resource/
//       ├── easytier-core.exe     ← 核心
//       ├── easytier-cli.exe      ← CLI
//       ├── wintun.dll
//       ├── Packet.dll
//       └── WinDivert64.sys
//
// 首次启动会自动创建缺失的目录，并把 exe 同目录下的
// easytier-core.exe / easytier-cli.exe 等文件自动归位到 resource/。

/// 程序根目录（exe 所在目录）。开发态回退到当前工作目录。
fn root_dir() -> PathBuf {
    if let Ok(p) = std::env::current_exe() {
        if let Some(parent) = p.parent() {
            return parent.to_path_buf();
        }
    }
    PathBuf::from(".")
}

fn config_dir() -> PathBuf {
    root_dir().join("config")
}

fn logs_dir() -> PathBuf {
    root_dir().join("logs")
}

fn resource_dir() -> PathBuf {
    root_dir().join("resource")
}

fn config_file() -> PathBuf {
    config_dir().join("config.toml")
}

fn log_file() -> PathBuf {
    logs_dir().join("easytier-runtime.log")
}

fn core_exe() -> PathBuf {
    resource_dir().join(if cfg!(target_os = "windows") {
        "easytier-core.exe"
    } else {
        "easytier-core"
    })
}

fn cli_exe() -> PathBuf {
    resource_dir().join(if cfg!(target_os = "windows") {
        "easytier-cli.exe"
    } else {
        "easytier-cli"
    })
}

/// 启动时确保目录结构存在
fn ensure_dirs() {
    for d in [config_dir(), logs_dir(), resource_dir()] {
        let _ = std::fs::create_dir_all(&d);
    }
}

/// 首次运行时，把散落在 exe 同目录的 EasyTier 文件移动到 resource/
///
/// 这样用户把 easytier-core.exe 等文件和面板 exe 放一起，也能自动归位。
fn migrate_legacy_files() {
    let root = root_dir();
    let res = resource_dir();
    let names = [
        "easytier-core.exe", "easytier-cli.exe",
        "easytier-core", "easytier-cli",
        "wintun.dll", "Packet.dll", "WinDivert64.sys",
        "libeasytier.so",
    ];
    for name in names {
        let src = root.join(name);
        if !src.is_file() {
            continue;
        }
        let dst = res.join(name);
        if dst.exists() {
            continue;
        }
        // 同盘用 rename，跨盘失败则 copy 后删除
        if std::fs::rename(&src, &dst).is_err() {
            if std::fs::copy(&src, &dst).is_ok() {
                let _ = std::fs::remove_file(&src);
            }
        }
    }

    // 旧版把 config.toml 放在根目录的，也搬进 config/
    let old_conf = root.join("config.toml");
    let new_conf = config_file();
    if old_conf.is_file() && !new_conf.exists() {
        if std::fs::rename(&old_conf, &new_conf).is_err() {
            if std::fs::copy(&old_conf, &new_conf).is_ok() {
                let _ = std::fs::remove_file(&old_conf);
            }
        }
    }
}

// ---------------------------------------------------------------- 工具函数

#[cfg(target_os = "windows")]
fn hidden_cmd(prog: &Path) -> Command {
    let mut c = Command::new(prog);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(target_os = "windows"))]
fn hidden_cmd(prog: &Path) -> Command {
    Command::new(prog)
}

/// 执行 easytier-cli，返回 stdout
fn run_cli(args: &[&str]) -> Result<String, String> {
    let cli = cli_exe();
    if !cli.exists() {
        return Err(format!("找不到 {}", cli.display()));
    }
    let out = hidden_cmd(&cli)
        .args(args)
        .output()
        .map_err(|e| format!("执行 cli 失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let so = String::from_utf8_lossy(&out.stdout);
        return Err(if err.trim().is_empty() { so.to_string() } else { err.to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 执行 easytier-cli -o json 并解析
fn cli_json(args: &[&str]) -> Result<Value, String> {
    let mut a = vec!["-o", "json"];
    a.extend_from_slice(args);
    let s = run_cli(&a)?;
    let t = s.trim();
    if t.is_empty() {
        return Err("空输出".into());
    }
    serde_json::from_str(t).map_err(|e| format!("JSON 解析失败: {e}; 原始: {}", &t[..t.len().min(200)]))
}

/// 判断 easytier-core 是否在运行
///
/// 直接查系统进程，这样即使用户用别的方式（服务、手动）启动过
/// easytier-core，面板也能正确识别。
fn core_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        let out = hidden_cmd(Path::new("tasklist"))
            .args(["/FI", "IMAGENAME eq easytier-core.exe", "/NH"])
            .output();
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout).contains("easytier-core.exe");
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("pgrep").args(["-x", "easytier-core"]).output();
        out.map(|o| o.status.success()).unwrap_or(false)
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 检查 wintun 虚拟网卡（et_* 或含 EasyTier/Wintun 的适配器）是否已建立
///
/// 用 `ipconfig` 而非 `Get-NetAdapter`，避免依赖 PowerShell。
#[cfg(target_os = "windows")]
fn tun_adapter_ready() -> bool {
    let out = hidden_cmd(Path::new("ipconfig")).output();
    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            // easytier 的 tun 设备名形如 et_6_xxxx
            text.contains("et_") || text.contains("easytier") || text.contains("wintun")
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn tun_adapter_ready() -> bool {
    // Linux 下判断 tun 设备是否存在
    std::path::Path::new("/dev/net/tun").exists()
}

/// 当前进程是否以管理员权限运行（Windows）
#[cfg(target_os = "windows")]
fn is_elevated() -> bool {
    // 用 net session 探测：非管理员会失败
    let out = hidden_cmd(Path::new("net"))
        .arg("session")
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn is_elevated() -> bool {
    // Linux 下判断是否 root
    std::env::var("USER").map(|u| u == "root").unwrap_or(false)
}

// ---------------------------------------------------------------- wintun 僵尸设备清理

/// 清理残留的 wintun 僵尸适配器
///
/// 背景：easytier-core 被强制结束（任务管理器结束进程、崩溃、断电）时，
/// wintun 创建的虚拟网卡设备会残留在 PnP 里，状态变成 `Unknown`。
/// 下次启动 core 时，wintun 尝试创建同名或新适配器会失败，表现为：
///
///   ERROR CORE::INSTANCE: tun device error err=rust tun error Failed to create adapter
///
/// 因此启动前先扫一遍 `SWD\WINTUN\*` 设备，把状态不是 OK 的移除掉。
///
/// 用 `pnputil /enum-devices /class Net` 输出解析，避免依赖 PowerShell。
#[cfg(target_os = "windows")]
fn cleanup_stale_wintun() -> usize {
    // pnputil 的输出是本地化文本，直接解析不稳定。
    // 用 PowerShell 更可靠，但启动时调 PowerShell 有延迟。
    // 折中：只在检测到启动失败时才调用（见 start_core）。
    let ps = r#"
$ErrorActionPreference='SilentlyContinue'
$d = Get-PnpDevice | Where-Object { $_.InstanceId -like 'SWD\WINTUN\*' -and $_.Status -ne 'OK' }
if (-not $d) { Write-Output 'NONE'; exit }
foreach ($x in $d) {
  pnputil /remove-device $x.InstanceId 2>&1 | Out-Null
  Write-Output ('REMOVED ' + $x.FriendlyName)
}
"#;

    let out = hidden_cmd(Path::new("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .output();

    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.lines().filter(|l| l.starts_with("REMOVED")).count()
        }
        Err(_) => 0,
    }
}

#[cfg(not(target_os = "windows"))]
fn cleanup_stale_wintun() -> usize {
    0
}

// ---------------------------------------------------------------- NAT 中文映射

fn nat_cn(v: &str) -> String {
    match v {
        "OpenInternet" => "公网直连",
        "NoPat" => "无端口转换",
        "FullCone" => "全锥形",
        "Restricted" => "地址限制锥形",
        "PortRestricted" => "端口限制锥形",
        "Symmetric" => "对称型",
        "SymUdpFirewall" => "对称型+防火墙",
        "SymUdpFirewallEasyInc" => "对称型+防火墙(易增量)",
        "UdpBlocked" => "UDP 被阻断",
        "Unknown" => "未知",
        "" => "",
        other => other,
    }
    .to_string()
}

// ---------------------------------------------------------------- 数据结构

#[derive(Serialize, Clone)]
struct Peer {
    hostname: String,
    ipv4: String,
    cidr: String,
    cost: String,
    kind: String,       // local / p2p / relay / other
    lat_ms: String,
    loss_rate: String,
    tunnel_proto: String,
    nat_type: String,
    nat_label: String,
    version: String,
    rx: String,
    tx: String,
    id: String,
}

#[derive(Serialize)]
struct Fwd {
    proto: String,
    bind: String,
    dst: String,
}

#[derive(Serialize)]
struct ProxyConn {
    src: String,
    dst: String,
    start: String,
    state: String,
    transport: String,
}

#[derive(Serialize)]
struct Route {
    hostname: String,
    ipv4: String,
    proxy_cidrs: Vec<String>,
    next_hop: String,
    path_len: i64,
    path_latency: f64,
    is_local: bool,
    is_direct: bool,
}

#[derive(Serialize)]
struct Status {
    running: bool,
    peers: Vec<Peer>,
    peers_error: Option<String>,
    node: Option<Value>,
    node_error: Option<String>,
    routes: Vec<Route>,
    routes_error: Option<String>,
    forwards: Vec<Fwd>,
    proxies: Vec<ProxyConn>,
    config_path: String,
    easytier_dir: String,
    timestamp: u64,
}

// ---------------------------------------------------------------- 解析辅助

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn normalize_peers(raw: &Value) -> Vec<Peer> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => return vec![],
    };
    let mut out: Vec<Peer> = arr
        .iter()
        .map(|p| {
            let cost = s(p, "cost");
            let lc = cost.to_lowercase();
            let kind = if lc == "local" {
                "local"
            } else if lc == "p2p" {
                "p2p"
            } else if lc.starts_with("relay") {
                "relay"
            } else {
                "other"
            };
            let nat = s(p, "nat_type");
            Peer {
                hostname: s(p, "hostname"),
                ipv4: s(p, "ipv4"),
                cidr: s(p, "cidr"),
                cost: cost.clone(),
                kind: kind.into(),
                lat_ms: s(p, "lat_ms"),
                loss_rate: s(p, "loss_rate"),
                tunnel_proto: s(p, "tunnel_proto"),
                nat_label: nat_cn(&nat),
                nat_type: nat,
                version: s(p, "version"),
                rx: s(p, "rx_bytes"),
                tx: s(p, "tx_bytes"),
                id: p.get("id").map(|x| x.to_string().trim_matches('"').to_string()).unwrap_or_default(),
            }
        })
        .collect();

    // 本机置顶，其余按延迟升序
    out.sort_by(|a, b| {
        let ka = if a.kind == "local" { 0 } else { 1 };
        let kb = if b.kind == "local" { 0 } else { 1 };
        if ka != kb {
            return ka.cmp(&kb);
        }
        let la = a.lat_ms.parse::<f64>().unwrap_or(999999.0);
        let lb = b.lat_ms.parse::<f64>().unwrap_or(999999.0);
        la.partial_cmp(&lb).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn parse_md_table(text: &str, ncol: usize) -> Vec<Vec<String>> {
    let mut rows = vec![];
    for line in text.lines() {
        let l = line.trim();
        if !l.starts_with('|') {
            continue;
        }
        let cells: Vec<String> = l
            .trim_matches('|')
            .split('|')
            .map(|c| c.trim().to_string())
            .collect();
        if cells.len() < ncol {
            continue;
        }
        let first = cells[0].to_lowercase();
        // 跳过表头与分隔线
        if first.starts_with("protocol") || first.starts_with("src") || cells[0].chars().all(|c| c == '-') {
            continue;
        }
        rows.push(cells);
    }
    rows
}

fn build_routes(raw: &Value) -> Vec<Route> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => return vec![],
    };
    arr.iter()
        .map(|r| {
            let cidrs: Vec<String> = s(r, "proxy_cidrs")
                .split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect();
            let hop = s(r, "next_hop_hostname");
            Route {
                hostname: s(r, "hostname"),
                ipv4: s(r, "ipv4"),
                proxy_cidrs: cidrs,
                path_len: r.get("path_len").and_then(|x| x.as_i64()).unwrap_or(0),
                path_latency: r.get("path_latency").and_then(|x| x.as_f64()).unwrap_or(0.0),
                is_local: hop.to_lowercase() == "local",
                is_direct: hop.to_uppercase() == "DIRECT",
                next_hop: hop,
            }
        })
        .collect()
}

// ---------------------------------------------------------------- Tauri 命令

#[tauri::command]
fn get_status() -> Result<Status, String> {
    let running = core_running();

    let mut peers = vec![];
    let mut peers_error = None;
    let mut node = None;
    let mut node_error = None;
    let mut routes = vec![];
    let mut routes_error = None;
    let mut forwards = vec![];
    let mut proxies = vec![];

    if running {
        match cli_json(&["peer"]) {
            Ok(v) => peers = normalize_peers(&v),
            Err(e) => peers_error = Some(e),
        }
        match cli_json(&["node"]) {
            Ok(mut v) => {
                if let Some(stun) = v.get("stun_info") {
                    let udp = s(stun, "udp_nat_type");
                    let tcp = s(stun, "tcp_nat_type");
                    v["nat_udp_label"] = Value::String(nat_cn(&udp));
                    v["nat_tcp_label"] = Value::String(nat_cn(&tcp));
                }
                node = Some(v);
            }
            Err(e) => node_error = Some(e),
        }
        match cli_json(&["route"]) {
            Ok(v) => routes = build_routes(&v),
            Err(e) => routes_error = Some(e),
        }
        if let Ok(t) = run_cli(&["port-forward"]) {
            forwards = parse_md_table(&t, 3)
                .into_iter()
                .map(|c| Fwd { proto: c[0].clone(), bind: c[1].clone(), dst: c[2].clone() })
                .collect();
        }
        if let Ok(t) = run_cli(&["proxy"]) {
            proxies = parse_md_table(&t, 5)
                .into_iter()
                .map(|c| ProxyConn {
                    src: c[0].clone(),
                    dst: c[1].clone(),
                    start: c[2].clone(),
                    state: c[3].clone(),
                    transport: c[4].clone(),
                })
                .collect();
        }
    }

    Ok(Status {
        running,
        peers,
        peers_error,
        node,
        node_error,
        routes,
        routes_error,
        forwards,
        proxies,
        config_path: config_file().display().to_string(),
        easytier_dir: resource_dir().display().to_string(),
        timestamp: now_ms(),
    })
}

#[tauri::command]
fn start_core() -> Result<String, String> {
    if core_running() {
        return Ok("easytier-core 已在运行".into());
    }
    let core = core_exe();
    if !core.exists() {
        return Err(format!(
            "找不到核心程序：{}\n请把 easytier-core.exe 放到 resource 目录",
            core.display()
        ));
    }
    if !config_file().exists() {
        return Err(format!(
            "找不到配置文件：{}\n请先创建 config.toml",
            config_file().display()
        ));
    }

    // ★ 权限前置检查
    //
    // wintun 建虚拟网卡必须要管理员权限，否则 core 必然报
    // `Failed to create adapter`。这里提前拦下来，给出明确提示，
    // 而不是等 core 跑起来再莫名退出。
    #[cfg(target_os = "windows")]
    if !is_elevated() {
        return Err(
            "需要管理员权限才能启动核心。\n\n\
             原因：EasyTier 通过 wintun 驱动创建虚拟网卡，\
             这需要加载内核驱动并修改网络配置，普通权限会失败。\n\n\
             解决：关闭本窗口，右键 EasyTier-Console.exe → \
             「以管理员身份运行」。"
                .into(),
        );
    }

    // 启动前先清理可能残留的 wintun 僵尸适配器
    //
    // 说明：core 被强制结束（任务管理器、崩溃、断电）时会留下状态为
    // Unknown 的 wintun 设备，导致本次启动建网卡失败。这里先扫一遍。
    let pre_cleaned = cleanup_stale_wintun();
    if pre_cleaned > 0 {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // 启动（真正的参数拼装在 spawn_core_once 里）
    //
    // 关键点：
    //  1) 必须显式指定 RPC 门户 `-r 127.0.0.1:15888`。
    //     core 的默认值是「先试 15888，占用则随机」，随机到别的端口时
    //     cli 仍连 15888，会表现为面板「采集失败」。
    //  2) 不能用 CREATE_NO_WINDOW —— 它创建的是没有窗口站的隐藏会话，
    //     wintun 建适配器要调 SetupAPI，在那个上下文里会失败，报
    //     `Failed to create adapter`。改用 DETACHED_PROCESS，
    //     stdio 重定向到日志文件，既无黑窗又能正常建网卡。
    spawn_core_once()?;

    // 等 core 完成初始化（建网卡 + 连对等节点要 1~2 秒）
    std::thread::sleep(std::time::Duration::from_millis(2500));

    if !core_running() {
        // 启动失败最常见的原因是 wintun 僵尸适配器残留。
        // 清理后重试一次。
        let removed = cleanup_stale_wintun();
        if removed > 0 {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let retry = spawn_core_once();
            if retry.is_ok() {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                if core_running() && tun_adapter_ready() {
                    return Ok(format!(
                        "已启动（清理了 {removed} 个残留网卡后重试成功）"
                    ));
                }
            }
        }
        return Err(
            "启动后立即退出。请点「查看日志」查看具体报错。\n\
             如果日志里是 `Failed to create adapter`，说明虚拟网卡被占用或残留，\
             可尝试：\n\
             \u{3000}1. 以管理员身份运行本程序\n\
             \u{3000}2. 设备管理器里卸载 et_ 开头的异常网络适配器\n\
             \u{3000}3. 重启系统"
                .into(),
        );
    }

    // 额外确认 wintun 适配器是否建起来了
    if !tun_adapter_ready() {
        return Err(
            "核心进程已启动，但虚拟网卡创建失败。\n\
             请在管理员权限下运行本程序（右键 → 以管理员身份运行）。"
                .into(),
        );
    }

    let pid = core_pid().unwrap_or(0);
    let mut msg = format!("已启动，PID={pid}");
    if pre_cleaned > 0 {
        msg.push_str(&format!("\n（启动前清理了 {pre_cleaned} 个残留网卡）"));
    }
    Ok(msg)
}

/// 取 easytier-core 的 PID（取不到返回 None）
#[cfg(target_os = "windows")]
fn core_pid() -> Option<u32> {
    let out = hidden_cmd(Path::new("tasklist"))
        .args([
            "/FI",
            "IMAGENAME eq easytier-core.exe",
            "/FO",
            "CSV",
            "/NH",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // CSV 格式: "easytier-core.exe","1234","Console","1","41,484 K"
    for line in text.lines() {
        if !line.contains("easytier-core.exe") {
            continue;
        }
        for field in line.split(',') {
            let f = field.trim().trim_matches('"');
            if let Ok(pid) = f.parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn core_pid() -> Option<u32> {
    let out = Command::new("pgrep").args(["-x", "easytier-core"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().and_then(|l| l.trim().parse::<u32>().ok())
}

/// 启动一次 easytier-core（不含结果校验），供重试逻辑复用
///
/// ⚠️ 关于进程创建标志的踩坑记录（顺序即优先级）：
///
///   实测矩阵（同一台机器，同一份 config）：
///     none                        0x00000000  → 建网卡成功
///     DETACHED_PROCESS            0x00000008  → 建网卡成功
///     DETACHED|NEW_GROUP          0x00000208  → 建网卡成功
///     CREATE_NO_WINDOW            0x08000000  → 建网卡成功
///     DETACHED|NEW_GROUP|BREAKAWAY 0x01000208 → 失败！
///
///   其中 CREATE_BREAKAWAY_FROM_JOB 有两种失败形态：
///     1. 直接 spawn 失败：WinError 5（拒绝访问）——
///        当父进程处于不允许 breakaway 的 Job 对象里时发生
///     2. spawn 成功但 wintun 建适配器失败：日志报
///        `Failed to create adapter` ——
///        进程虽然起来了，但脱离 Job 后加载 wintun 驱动时受限
///
///   第 2 种最坑：`spawn()` 返回 Ok，降级分支根本不会触发，
///   表现为「启动后立即退出」，日志里只有 tun device error。
///
///   因此这里**只用 DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP**，
///   彻底不用 BREAKAWAY。
///
/// 为什么不担心「面板关闭导致 core 被一起杀掉」：
///   DETACHED_PROCESS 已经让 core 没有控制台且不属于父进程的进程组，
///   面板退出不会连带结束 core。实测面板关闭后 core 仍在运行。
#[cfg(target_os = "windows")]
fn spawn_core_once() -> Result<(), String> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let logf = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
        .map_err(|e| format!("打开日志失败: {e}"))?;
    let loge = logf.try_clone().map_err(|e| e.to_string())?;

    Command::new(core_exe())
        .arg("-c")
        .arg(config_file())
        .arg("-r")
        .arg(RPC_PORTAL)
        .current_dir(resource_dir())
        .stdout(Stdio::from(logf))
        .stderr(Stdio::from(loge))
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动失败: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn spawn_core_once() -> Result<(), String> {
    let logf = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
        .map_err(|e| format!("打开日志失败: {e}"))?;
    let loge = logf.try_clone().map_err(|e| e.to_string())?;
    Command::new(core_exe())
        .arg("-c")
        .arg(config_file())
        .arg("-r")
        .arg(RPC_PORTAL)
        .current_dir(resource_dir())
        .stdout(Stdio::from(logf))
        .stderr(Stdio::from(loge))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动失败: {e}"))
}

#[tauri::command]
fn stop_core() -> Result<String, String> {
    if !core_running() {
        // 即使没在运行，也顺手清一遍可能残留的僵尸网卡
        let n = cleanup_stale_wintun();
        return Ok(if n > 0 {
            format!("easytier-core 未在运行（已清理 {n} 个残留网卡）")
        } else {
            "easytier-core 未在运行".to_string()
        });
    }

    #[cfg(target_os = "windows")]
    {
        // 先尝试「优雅终止」：不带 /F 的 taskkill 会发 WM_CLOSE。
        // easytier-core 收到后有机会自己删除 wintun 适配器，
        // 避免在 PnP 里留下 Unknown 状态的僵尸设备。
        let graceful = hidden_cmd(Path::new("taskkill"))
            .args(["/IM", "easytier-core.exe", "/T"])
            .output();

        let graceful_ok = graceful.map(|o| o.status.success()).unwrap_or(false);
        if graceful_ok {
            // 等最多 4 秒看它自己退不退出
            for _ in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if !core_running() {
                    break;
                }
            }
        }

        // 还没退出就强杀
        if core_running() {
            let out = hidden_cmd(Path::new("taskkill"))
                .args(["/F", "/IM", "easytier-core.exe"])
                .output()
                .map_err(|e| format!("停止失败: {e}"))?;
            if !out.status.success() {
                let msg = String::from_utf8_lossy(&out.stderr);
                return Err(format!("停止失败: {msg}"));
            }
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Linux 先 SIGTERM，给它清理的机会；3 秒不退再 SIGKILL
        let _ = Command::new("pkill").args(["-TERM", "-x", "easytier-core"]).output();
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if !core_running() {
                break;
            }
        }
        if core_running() {
            let out = Command::new("pkill").args(["-9", "-x", "easytier-core"]).output();
            if let Ok(o) = out {
                if !o.status.success() {
                    let msg = String::from_utf8_lossy(&o.stderr);
                    return Err(format!("停止失败: {msg}"));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    }

    // 停止后清理可能残留的 wintun 僵尸设备，
    // 这样下次启动不用再走「失败→清理→重试」的弯路
    std::thread::sleep(std::time::Duration::from_millis(400));
    let cleaned = cleanup_stale_wintun();

    Ok(if cleaned > 0 {
        format!("已停止（清理了 {cleaned} 个残留网卡）")
    } else {
        "已停止".to_string()
    })
}

#[tauri::command]
fn restart_core() -> Result<String, String> {
    let _ = stop_core();
    std::thread::sleep(std::time::Duration::from_millis(1200));
    start_core()
}

#[tauri::command]
fn tail_log(lines: Option<usize>) -> Result<String, String> {
    let p = log_file();
    if !p.exists() {
        return Ok(format!("日志文件不存在: {}", p.display()));
    }
    let n = lines.unwrap_or(400);
    let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let back = size.min(512 * 1024);
    f.seek(SeekFrom::Start(size - back)).map_err(|e| e.to_string())?;
    let reader = BufReader::new(f);
    let all: Vec<String> = reader.lines().map_while(Result::ok).collect();
    let start = all.len().saturating_sub(n);
    Ok(all[start..].join("\n"))
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    std::fs::read_to_string(config_file()).map_err(|e| format!("读取失败: {e}"))
}

/// 对配置文本做基础 TOML 语法校验
///
/// 说明：easytier-core 的 `--check-config` 在当前版本下
/// 无论配置对错都返回退出码 0、且不输出任何内容，
/// 因此无法用它做校验，这里改为自行检查常见的语法错误。
///
/// 只做「能挡住手误」级别的检查，不做完整 TOML 解析——
/// 真正的解析交给 core，这里避免误报。
fn validate_toml(text: &str) -> Result<(), String> {
    let mut line_no = 0usize;
    let mut in_multiline_basic = false;   // """..."""
    let mut in_multiline_literal = false; // '''...'''

    for raw in text.lines() {
        line_no += 1;
        // 去掉行尾 \r（Windows 换行）
        let line = raw.trim_end_matches('\r');
        let t = line.trim();

        // 多行字符串内部直接跳过（不做任何检查）
        if in_multiline_basic {
            if t.contains("\"\"\"") {
                in_multiline_basic = false;
            }
            continue;
        }
        if in_multiline_literal {
            if t.contains("'''") {
                in_multiline_literal = false;
            }
            continue;
        }

        // 空行、纯注释
        if t.is_empty() || t.starts_with('#') {
            continue;
        }

        // 检测多行字符串起始
        if t.matches("\"\"\"").count() % 2 == 1 {
            in_multiline_basic = true;
            continue;
        }
        if t.matches("'''").count() % 2 == 1 {
            in_multiline_literal = true;
            continue;
        }

        // 节标题 [xxx] / [[xxx]]
        if t.starts_with('[') {
            let close = if t.starts_with("[[") { "]]" } else { "]" };
            if !t.contains(close) {
                return Err(format!("第 {line_no} 行：节标题缺少闭合括号 → {t}"));
            }
            let inner = t
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim();
            if inner.is_empty() {
                return Err(format!("第 {line_no} 行：节标题为空 → {t}"));
            }
            if inner.contains(char::is_whitespace) && !inner.starts_with('"') {
                return Err(format!(
                    "第 {line_no} 行：节名不能含空格（多级用点号）→ {t}"
                ));
            }
            continue;
        }

        // 键值对必须含 '='
        if !t.contains('=') {
            return Err(format!(
                "第 {line_no} 行：缺少等号，应为 `键 = 值` → {t}"
            ));
        }

        let (k, v) = t.split_once('=').unwrap();
        let key = k.trim();
        let val = v.trim();

        if key.is_empty() {
            return Err(format!("第 {line_no} 行：等号左边没有键名 → {t}"));
        }
        if val.is_empty() {
            return Err(format!("第 {line_no} 行：等号右边没有值 → {t}"));
        }

        // 字符串必须成对
        if val.starts_with('"') {
            // 找结尾引号（忽略转义）
            let bs = val.as_bytes();
            let mut closed = false;
            let mut i = 1;
            while i < bs.len() {
                if bs[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if bs[i] == b'"' {
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(format!("第 {line_no} 行：字符串缺少结束引号 → {t}"));
            }
        }
        // 数组必须成对
        if val.starts_with('[') && !val.ends_with(']') && !val.contains(']') {
            return Err(format!("第 {line_no} 行：数组缺少结束 ] → {t}"));
        }
    }

    if in_multiline_basic {
        return Err("多行字符串 \"\"\" 没有闭合".into());
    }
    if in_multiline_literal {
        return Err("多行字符串 ''' 没有闭合".into());
    }
    Ok(())
}

#[tauri::command]
fn save_config(text: String) -> Result<String, String> {
    // 1) 本地语法校验
    validate_toml(&text)?;

    // 2) 关键字段检查（避免存下一份能保存但跑不起来的配置）
    let has_network = text.contains("[network_identity]")
        || text.contains("network_name");
    if !has_network {
        return Err(
            "配置缺少 [network_identity] 段（或 network_name），\n\
             核心将无法加入任何网络。\n\
             如果这是有意的（例如仅本地测试），可忽略此提示。"
                .into(),
        );
    }

    // 3) 落盘（先备份原文件）
    let conf = config_file();
    if conf.exists() {
        let bak = conf.with_extension("toml.bak");
        let _ = std::fs::copy(&conf, &bak);
    }
    std::fs::write(&conf, &text).map_err(|e| format!("保存失败: {e}"))?;

    Ok("配置已保存，重启核心后生效".into())
}

#[tauri::command]
fn get_meta() -> Value {
    serde_json::json!({
        "easytier_dir": resource_dir().display().to_string(),
        "config_path": config_file().display().to_string(),
        "log_path": log_file().display().to_string(),
        "root_dir": root_dir().display().to_string(),
        "platform": std::env::consts::OS,
        "autostart": autostart_enabled(),
        "elevated": is_elevated(),
    })
}

// ---------------------------------------------------------------- 开机自启
//
// Windows 方案：把快捷方式（.lnk）写入用户启动文件夹
//   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
//
// 相比注册表 HKCU\...\Run 的好处：
//   - 不依赖 reg.exe
//   - 用户可在「任务管理器 → 启动」里直接看到并管理
//   - 对系统零侵入，删文件即关闭
//
// .lnk 文件按 Shell Link Binary 格式手工构造，约 1.2 KB。
//
// Linux 方案：~/.config/autostart/*.desktop（freedesktop 标准）

// 启动文件夹里的快捷方式名（纯 ASCII，避免中文路径在部分环境下出问题）
const AUTOSTART_NAME: &str = "EasyTier Console";

/// 用户启动文件夹路径（Windows）
#[cfg(target_os = "windows")]
fn startup_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let mut p = PathBuf::from(appdata);
    p.push(r"Microsoft\Windows\Start Menu\Programs\Startup");
    Some(p)
}

#[cfg(target_os = "windows")]
fn autostart_lnk_path() -> Option<PathBuf> {
    Some(startup_dir()?.join(format!("{AUTOSTART_NAME}.lnk")))
}

/// 清理历史遗留的快捷方式（改名前生成的）
///
/// 只在关闭自启时调用，避免旧文件残留在启动文件夹里。
#[cfg(target_os = "windows")]
fn cleanup_legacy_lnk() {
    let legacy = ["EasyTier Panel.lnk", "EasyTier 管理面板.lnk"];
    if let Some(dir) = startup_dir() {
        for name in legacy {
            let p = dir.join(name);
            // 只删指向本程序的旧快捷方式，别误伤其他
            if p.exists() && p != dir.join(format!("{AUTOSTART_NAME}.lnk")) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn cleanup_legacy_lnk() {}

#[cfg(target_os = "windows")]
fn autostart_enabled() -> bool {
    autostart_lnk_path().map(|p| p.exists()).unwrap_or(false)
}

/// 构造 Windows 快捷方式（.lnk）二进制内容
///
/// 结构参考 [MS-SHLLINK]：
///   ShellLinkHeader (76B) + LinkTargetIDList + LinkInfo + StringData
/// 这里用最简形式：不带 IDList，只带 LinkInfo（本地绝对路径）
/// 和 RELATIVE_PATH + WORKING_DIR 两个字符串。
#[cfg(target_os = "windows")]
fn build_lnk(target: &str, workdir: &str) -> Vec<u8> {
    fn u16le(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }
    fn u32le(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }

    let mut out: Vec<u8> = Vec::with_capacity(2048);

    // ---- ShellLinkHeader (76 字节) ----
    out.extend_from_slice(&u32le(0x0000_004C)); // HeaderSize = 76
    // LinkCLSID = {00021401-0000-0000-C000-000000000046}
    // 按 GUID 内存布局（Data1/Data2/Data3 小端 + Data4 原序）
    out.extend_from_slice(&[
        0x01, 0x14, 0x02, 0x00, // Data1 = 0x00021401
        0x00, 0x00, // Data2 = 0x0000
        0x00, 0x00, // Data3 = 0x0000
        0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46, // Data4
    ]);
    // LinkFlags: HasLinkInfo | HasRelativePath | HasWorkingDir | IsUnicode
    //   bit1 HasLinkInfo        = 0x00000002
    //   bit3 HasRelativePath    = 0x00000008
    //   bit4 HasWorkingDir      = 0x00000010
    //   bit7 IsUnicode          = 0x00000080
    let flags: u32 = 0x0000_009A;
    out.extend_from_slice(&u32le(flags));
    out.extend_from_slice(&u32le(0x0000_0020)); // FileAttributes = FILE_ATTRIBUTE_ARCHIVE
    out.extend_from_slice(&[0u8; 8]); // CreationTime
    out.extend_from_slice(&[0u8; 8]); // AccessTime
    out.extend_from_slice(&[0u8; 8]); // WriteTime
    out.extend_from_slice(&u32le(0)); // FileSize
    out.extend_from_slice(&u32le(0)); // IconIndex
    out.extend_from_slice(&u32le(1)); // ShowCommand = SW_SHOWNORMAL
    out.extend_from_slice(&u16le(0)); // HotKey
    out.extend_from_slice(&[0u8; 2]); // Reserved1
    out.extend_from_slice(&[0u8; 4]); // Reserved2
    out.extend_from_slice(&[0u8; 4]); // Reserved3
    debug_assert_eq!(out.len(), 76, "ShellLinkHeader 必须恰好 76 字节");

    // ---- LinkInfo ----
    //
    // 布局（各 Offset 均相对 LinkInfo 起点）：
    //   0x00  LinkInfoSize          u32
    //   0x04  LinkInfoHeaderSize    u32 = 0x1C
    //   0x08  LinkInfoFlags         u32 = 1 (VolumeIDAndLocalBasePath)
    //   0x0C  VolumeIDOffset        u32 = 0x1C
    //   0x10  LocalBasePathOffset   u32
    //   0x14  CommonNetworkRelativeLinkOffset u32 = 0
    //   0x18  CommonPathSuffixOffset u32
    //   0x1C  VolumeID (17 字节)
    //         LocalBasePath  (ASCII + NUL)
    //         CommonPathSuffix (NUL)
    //
    // ⚠️ LocalBasePath 按规范是 ANSI 字符串。若路径含中文，
    //    ANSI 无法无损表示（会变成 ????）。此时把 LocalBasePath
    //    写成空串（只留 NUL），真正的目标路径由后面 UTF-16 的
    //    RELATIVE_PATH 承担——Windows 解析时会优先使用它。
    let is_ascii = target.is_ascii();
    let path_bytes: Vec<u8> = if is_ascii {
        target.bytes().collect()
    } else {
        // 含非 ASCII 字符：LocalBasePath 留空，靠 StringData 传递
        Vec::new()
    };
    let volume_id_len: u32 = 17;
    let base_off: u32 = 0x1C + volume_id_len; // = 45
    let suffix_off: u32 = base_off + path_bytes.len() as u32 + 1; // 路径后的 NUL 之后
    let link_info_size: u32 = suffix_off + 1; // + CommonPathSuffix 的 NUL

    let li_start = out.len();
    out.extend_from_slice(&u32le(link_info_size));
    out.extend_from_slice(&u32le(0x1C)); // LinkInfoHeaderSize
    out.extend_from_slice(&u32le(0x0000_0001)); // LinkInfoFlags: VolumeIDAndLocalBasePath
    out.extend_from_slice(&u32le(0x1C)); // VolumeIDOffset
    out.extend_from_slice(&u32le(base_off)); // LocalBasePathOffset
    out.extend_from_slice(&u32le(0)); // CommonNetworkRelativeLinkOffset
    out.extend_from_slice(&u32le(suffix_off)); // CommonPathSuffixOffset

    // VolumeID（17 字节）
    out.extend_from_slice(&u32le(volume_id_len));
    out.extend_from_slice(&u32le(3)); // DriveType = DRIVE_FIXED
    out.extend_from_slice(&u32le(0)); // DriveSerialNumber
    out.extend_from_slice(&u32le(0x10)); // VolumeLabelOffset
    out.push(0); // VolumeLabel 空串的 NUL

    // LocalBasePath（ASCII 以 NUL 结尾）
    out.extend_from_slice(&path_bytes);
    out.push(0);

    // CommonPathSuffix（空串，1 字节 NUL）
    out.push(0);

    debug_assert_eq!(
        out.len() - li_start,
        link_info_size as usize,
        "LinkInfoSize 与实际写入长度不一致"
    );

    // ---- StringData: RELATIVE_PATH（UTF-16LE，带长度前缀）----
    let rel: Vec<u16> = target.encode_utf16().collect();
    out.extend_from_slice(&u16le((rel.len() * 2) as u16));
    for u in &rel {
        out.extend_from_slice(&u16le(*u));
    }

    // ---- StringData: WORKING_DIR ----
    let wd: Vec<u16> = workdir.encode_utf16().collect();
    out.extend_from_slice(&u16le((wd.len() * 2) as u16));
    for u in &wd {
        out.extend_from_slice(&u16le(*u));
    }

    // ---- ExtraData: 终止块 ----
    out.extend_from_slice(&u32le(0x0000_0000));

    out
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_autostart(enable: bool) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径: {e}"))?;
    let exe_s = exe.display().to_string();
    let workdir = root_dir().display().to_string();

    let lnk = autostart_lnk_path().ok_or("无法定位启动文件夹")?;
    let dir = lnk.parent().ok_or("无法定位启动文件夹")?;

    if enable {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建启动文件夹失败: {e}"))?;
        // 先清掉改名前遗留的旧快捷方式，避免重复自启
        cleanup_legacy_lnk();
        let data = build_lnk(&exe_s, &workdir);
        std::fs::write(&lnk, &data).map_err(|e| format!("写入快捷方式失败: {e}"))?;
        // 成功提示里带上路径，方便用户核对
        Ok(format!("已开启开机自启\n快捷方式：{}", lnk.display()))
    } else {
        if lnk.exists() {
            std::fs::remove_file(&lnk).map_err(|e| format!("删除快捷方式失败: {e}"))?;
        }
        cleanup_legacy_lnk();
        Ok("已关闭开机自启".into())
    }
}

#[cfg(not(target_os = "windows"))]
fn autostart_desktop_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".config/autostart/easytier-panel.desktop");
    Some(p)
}

#[cfg(not(target_os = "windows"))]
fn autostart_enabled() -> bool {
    autostart_desktop_path().map(|p| p.exists()).unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_autostart(enable: bool) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径: {e}"))?;
    let exe_s = exe.display().to_string();
    let path = autostart_desktop_path().ok_or("无法确定 autostart 目录")?;

    if enable {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=EasyTier 控制台\nExec={exe_s}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
        );
        std::fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))?;
        Ok(format!("已开启开机自启\n文件：{}", path.display()))
    } else {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
        }
        Ok("已关闭开机自启".into())
    }
}

#[tauri::command]
fn open_dir() -> Result<String, String> {
    let dir = root_dir();

    #[cfg(target_os = "windows")]
    {
        // explorer.exe 打开目录；注意 explorer 成功时可能返回非 0，故不检查退出码
        Command::new("explorer")
            .arg(dir.display().to_string())
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(dir.display().to_string())
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(dir.display().to_string())
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    Ok(dir.display().to_string())
}

// ---------------------------------------------------------------- 自检模式

/// 命令行自检：`easytier-panel.exe --selftest [命令]`
///
/// 用于在无 GUI 环境下验证各功能是否正常，输出纯文本结果。
/// 无副作用的查询命令会直接执行；动作类命令需显式指定。
fn run_selftest() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(2).map(|s| s.as_str()).unwrap_or("all");

    println!("=== EasyTier 面板自检 ===");
    println!("根目录   : {}", root_dir().display());
    println!("配置目录 : {}", config_dir().display());
    println!("日志目录 : {}", logs_dir().display());
    println!("资源目录 : {}", resource_dir().display());
    println!();

    let mut fail = 0;

    // 目录结构
    println!("--- 目录结构 ---");
    for (name, p) in [
        ("config", config_dir()),
        ("logs", logs_dir()),
        ("resource", resource_dir()),
    ] {
        if p.is_dir() {
            println!("  [OK] {name}/ -> {}", p.display());
        } else {
            println!("  [FAIL] {name}/ 不存在");
            fail += 1;
        }
    }
    println!();

    // 关键文件
    println!("--- 关键文件 ---");
    let checks = [
        ("config.toml", config_file()),
        ("easytier-core", core_exe()),
        ("easytier-cli", cli_exe()),
    ];
    for (name, p) in checks {
        if p.is_file() {
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            println!("  [OK] {name}  {} ({:.1} MB)", p.display(), size as f64 / 1048576.0);
        } else {
            println!("  [MISS] {name}  未找到: {}", p.display());
        }
    }
    println!();

    // core 运行状态
    println!("--- 核心状态 ---");
    let running = core_running();
    println!("  core_running() = {running}");
    println!();

    match cmd {
        "status" | "all" => {
            println!("--- get_status() ---");
            match get_status() {
                Ok(s) => {
                    println!("  running   : {}", s.running);
                    println!("  peers     : {}", s.peers.len());
                    if let Some(e) = &s.peers_error {
                        println!("  peers_err : {e}");
                    }
                    println!("  routes    : {}", s.routes.len());
                    println!("  forwards  : {}", s.forwards.len());
                    println!("  proxies   : {}", s.proxies.len());
                    println!("  node      : {}", if s.node.is_some() { "有" } else { "无" });
                    if !s.peers.is_empty() {
                        // 以本机版本为基准，标出版本不一致的节点
                        let my_ver = s
                            .peers
                            .iter()
                            .find(|p| p.kind == "local")
                            .map(|p| p.version.clone())
                            .unwrap_or_default();

                        println!("  对等节点列表:");
                        for p in s.peers.iter().take(10) {
                            let short = p
                                .version
                                .split('-')
                                .next()
                                .unwrap_or("")
                                .to_string();
                            let diff = !my_ver.is_empty()
                                && !p.version.is_empty()
                                && p.version != my_ver
                                && p.kind != "local";
                            let mark = if diff { "  [版本不一致]" } else { "" };
                            println!(
                                "    {:<16} {:<16} {:<8} {} ms  {:<12} v{}{}",
                                p.hostname, p.ipv4, p.cost, p.lat_ms, p.nat_label, short, mark
                            );
                        }
                    }
                }
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
            println!();
        }
        _ => {}
    }

    match cmd {
        "log" | "all" => {
            println!("--- tail_log(20) ---");
            match tail_log(Some(20)) {
                Ok(s) => {
                    println!("  行数: {}", s.lines().count());
                    for line in s.lines().rev().take(8).collect::<Vec<_>>().iter().rev() {
                        println!("  | {line}");
                    }
                }
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
            println!();
        }
        _ => {}
    }

    match cmd {
        "config" | "all" => {
            println!("--- read_config() ---");
            match read_config() {
                Ok(s) => println!("  读取成功, {} 字符, {} 行", s.chars().count(), s.lines().count()),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
            println!();

            println!("--- validate_toml() 测试 ---");
            let cases: Vec<(&str, bool)> = vec![
                ("hostname = \"test\"\n", true),
                ("this is invalid\n", false),
                ("[network_identity]\nname = \"x\"\n", true),
                ("key = \"unclosed\n", false),
                ("[broken\nkey = 1\n", false),
                ("key = \n", false),
                ("# 只有注释\n", true),
            ];
            for (text, expect_ok) in cases {
                let r = validate_toml(text);
                let ok = r.is_ok();
                let mark = if ok == expect_ok { "[OK]" } else { "[FAIL]" };
                if ok != expect_ok {
                    fail += 1;
                }
                let detail = match &r {
                    Ok(_) => "通过".to_string(),
                    Err(e) => format!("拒绝: {e}"),
                };
                println!("  {mark} {:?} -> {}", text.replace('\n', "\\n"), detail);
            }
            println!();
        }
        _ => {}
    }

    match cmd {
        "autostart" | "all" => {
            println!("--- 开机自启 ---");
            println!("  当前状态: {}", if autostart_enabled() { "已开启" } else { "未开启" });
            #[cfg(target_os = "windows")]
            {
                if let Some(p) = autostart_lnk_path() {
                    println!("  快捷方式: {}", p.display());
                    println!("  文件存在: {}", p.exists());
                }
            }
            println!();
        }
        _ => {}
    }

    match cmd {
        "start" => {
            println!("--- start_core() ---");
            match start_core() {
                Ok(m) => println!("  [OK] {m}"),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
        }
        "stop" => {
            println!("--- stop_core() ---");
            match stop_core() {
                Ok(m) => println!("  [OK] {m}"),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
        }
        "restart" => {
            println!("--- restart_core() ---");
            match restart_core() {
                Ok(m) => println!("  [OK] {m}"),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
        }
        "autostart-on" => {
            println!("--- set_autostart(true) ---");
            match set_autostart(true) {
                Ok(m) => println!("  [OK] {m}"),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
        }
        "autostart-off" => {
            println!("--- set_autostart(false) ---");
            match set_autostart(false) {
                Ok(m) => println!("  [OK] {m}"),
                Err(e) => {
                    println!("  [FAIL] {e}");
                    fail += 1;
                }
            }
        }
        _ => {}
    }

    println!("=== 自检结束，失败项: {fail} ===");
    if fail == 0 { 0 } else { 1 }
}

// ---------------------------------------------------------------- 入口

fn main() {
    // 首次启动时建好目录结构，并把散落的 EasyTier 文件归位
    ensure_dirs();
    migrate_legacy_files();

    // 自检模式：不启动 GUI
    if std::env::args().any(|a| a == "--selftest") {
        std::process::exit(run_selftest());
    }

    // ---------------------------------------------------------- 提权检查
    //
    // easytier-core 用 wintun 建虚拟网卡必须有管理员权限，否则必然报
    //   `Failed to create adapter`
    // 并退出。所以程序启动时若发现自己不是管理员，就主动通过 UAC
    // 重新拉起一个管理员实例，然后退出当前（普通权限）实例。
    //
    // 传 --elevated 标记，避免无限循环重启。
    #[cfg(target_os = "windows")]
    {
        let already_retried = std::env::args().any(|a| a == "--elevated");
        if !already_retried && !is_elevated() {
            if elevate_self() {
                // 管理员实例已拉起，当前实例退出
                std::process::exit(0);
            }
            // 提权失败（用户点了「否」）→ 继续以普通权限运行，
            // 界面上会提示无法建网卡，但至少能查看状态和日志
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点窗口关闭按钮时：不退出，改为隐藏到托盘
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 只有当托盘创建成功时才拦截关闭
                if TRAY_READY.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_core,
            stop_core,
            restart_core,
            tail_log,
            read_config,
            save_config,
            get_meta,
            set_autostart,
            open_dir,
            tray_quit,
            show_window,
        ])
        .run(tauri::generate_context!())
        .expect("EasyTier 控制台启动失败");
}

// ---------------------------------------------------------------- 系统托盘
//
// 行为设计：
//   左键单击托盘图标  → 显示/聚焦主窗口
//   右键             → 弹出菜单（显示主窗口 / 启动核心 / 停止核心 / 退出）
//   点窗口的关闭按钮  → 隐藏到托盘（不退出程序）
//   菜单「退出」      → 真正退出（并提示 core 仍在后台运行）
//
// 用 AtomicBool 记录托盘是否就绪，避免托盘创建失败时
// 用户点关闭却关不掉窗口。

static TRAY_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    // 菜单项
    let mi_show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let mi_start = MenuItem::with_id(app, "start", "启动核心", true, None::<&str>)?;
    let mi_stop = MenuItem::with_id(app, "stop", "停止核心", true, None::<&str>)?;
    let mi_quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&mi_show, &mi_start, &mi_stop, &mi_quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("EasyTier 控制台")
        .menu(&menu)
        // 左键点击不弹菜单，改为显示窗口（在事件里处理）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                show_main_window(app);
            }
            "start" => {
                // 托盘菜单里启动核心。无论成功失败都把窗口叫出来，
                // 失败时用户能直接点「查看日志」看原因。
                let _ = start_core();
                show_main_window(app);
            }
            "stop" => {
                let _ = stop_core();
            }
            "quit" => {
                // 退出前把 core 也停掉，避免留下孤儿进程
                let _ = stop_core();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（按下后松开）→ 显示或聚焦窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 用应用自带的窗口图标（已配置为 EasyTier 官方图标）
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    TRAY_READY.store(true, std::sync::atomic::Ordering::SeqCst);

    Ok(())
}

/// 显示并聚焦主窗口（从托盘唤起）
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 前端可调用的「显示窗口」（自检/调试用）
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    show_main_window(&app);
}

/// 前端可调用的「退出程序」
#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    let _ = stop_core();
    app.exit(0);
}

/// 通过 UAC 以管理员身份重新启动自己
///
/// 用 ShellExecuteW + "runas" 动词。成功后返回 true（调用方应退出当前实例）。
#[cfg(target_os = "windows")]
fn elevate_self() -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    // 用 Windows API 的 ShellExecuteW
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> *mut std::ffi::c_void;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let exe_s = exe.display().to_string();
    let dir_s = root_dir().display().to_string();

    // 收集原参数（跳过 exe 自身路径），并追加 --elevated
    let mut params = String::new();
    for a in std::env::args().skip(1) {
        if params.is_empty() {
            params.push_str(&a);
        } else {
            params.push(' ');
            params.push_str(&a);
        }
    }
    if params.is_empty() {
        params.push_str("--elevated");
    } else {
        params.push_str(" --elevated");
    }

    let w_op = wide("runas");
    let w_exe = wide(&exe_s);
    let w_params = wide(&params);
    let w_dir = wide(&dir_s);

    // SW_SHOWNORMAL = 1
    // ShellExecuteW 返回 > 32 表示成功
    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w_op.as_ptr(),
            w_exe.as_ptr(),
            w_params.as_ptr(),
            w_dir.as_ptr(),
            1,
        )
    };

    ret as isize > 32
}
