# v1.1.1 完整实施计划

> 需求确认：2026-11-12
> 状态：等设计图确认后逐项实施

---

## 一、已确认的决策

| 项 | 决策 |
|---|---|
| 关闭面板时停止核心 | **默认关**（保持现有行为），孤儿进程靠「启动时清理」解决 |
| 拓扑图位置 | 作为独立模块，可在页面设置里显隐/改名 |
| 配置表单化 | 保留「原始配置」页给高级用户 |
| 发布节奏 | **全部一起做**，一个版本发完 |
| 对等节点配置 | 从配置页**移除**（它属于部署期一次性配置，不是日常可改项） |
| 高级配置 | 新增，覆盖官方全部参数 |

---

## 二、需求清单（10 项）

| # | 需求 | 动 Rust | 优先级 |
|---|---|---|---|
| 1 | 关闭面板时停止核心 + 孤儿进程清理 | ✅ | P0 |
| 2 | 全面小写化 | ✅ | P0 |
| 3 | 设置面板（5 分区） | 前端 | P0 |
| 4 | 页面设置（模块显隐/排序/改名） | 前端 | P0 |
| 5 | 配置表单化（基础/网络/高级） | 前端 | P1 |
| 6 | 高级配置（官方全参数） | 前端 | P1 |
| 7 | 端口转发独立页面 | 前端 | P1 |
| 8 | 网络拓扑图（优化版） | 前端 | P1 |
| 9 | 延迟大图（SQLite 历史） | ✅ | P2 |
| 10 | 节点详情弹窗 | ✅ 少量 | P2 |

---

## 三、需求 1：进程生命周期（P0，最优先）

### 现状问题

```rust
// main.rs:729
const DETACHED_PROCESS: u32 = 0x0000_0008;
```

core 完全脱离父进程。三条关闭路径只有一条会停 core：

| 关闭方式 | 是否停 core | 结果 |
|---|---|---|
| 托盘 → 退出 | ✅ `stop_core()` | 干净 |
| 点窗口 × | ❌ 只 `hide()` | core 继续跑 |
| 任务管理器强杀 | ❌ | **core 成孤儿** |
| 系统断电/重启 | ❌ | **core 成孤儿** |

孤儿 core 占着 `wintun.dll`、`easytier-core.exe`，覆盖升级时报「文件使用中」。

### 方案

#### 1.1 新增配置项

```rust
struct AppSettings {
    stop_core_on_exit: bool,      // 默认 false
    confirm_on_exit: bool,        // 默认 true
    minimize_to_tray: bool,       // 默认 true
    autostart: bool,
    autostart_core: bool,         // 默认 false
    start_minimized: bool,        // 默认 true
}
```

存 `data/settings.json`，不放 AppData（保持便携）。

#### 1.2 关闭时按配置处理

```rust
.on_window_event(|window, event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let s = load_settings();

        // 需要二次确认 → 交给前端弹窗
        if s.confirm_on_exit {
            api.prevent_close();
            window.emit("ask-exit", ()).ok();
            return;
        }
        if s.stop_core_on_exit {
            let _ = stop_core();
            app.exit(0);   // 真退出
        } else if s.minimize_to_tray {
            api.prevent_close();
            window.hide();
        }
    }
})
```

前端收到 `ask-exit` 弹窗：

```
┌─ 退出 easytier-console ────────────┐
│  要停止 EasyTier 核心吗？            │
│                                    │
│  停止：网络断开，虚拟网卡被移除       │
│  不停止：核心继续后台运行（推荐）     │
│                                    │
│  ☐ 记住我的选择                     │
│                                    │
│  [停止核心并退出] [仅退出面板] [取消] │
└────────────────────────────────────┘
```

#### 1.3 孤儿进程清理（解决你的实际问题）

**这是关键**。启动时检测并清理：

```rust
fn cleanup_orphan_core() {
    // 1. 找 easytier-core.exe 进程
    // 2. 判断其父进程是否为我们的 GUI
    //    - 若父进程已不存在（孤儿）→ 清理
    //    - 若父进程是别的程序 → 不动（用户可能同时跑官方客户端）
    // 3. 清理残留 wintun 适配器
}
```

用 WMI/CIM 查进程父子关系：

```powershell
Get-CimInstance Win32_Process -Filter "Name='easytier-core.exe'" |
  Select-Object ProcessId, ParentProcessId
```

**安全边界**：只清理「父进程 PID 不存在」或「父进程是 easytier-console.exe 但已退出」的 core。不碰用户手动启动的 core。

#### 1.4 退出时兜底

即使 `stop_core_on_exit=false`，程序正常退出时也应记录「我启动过 core」：

```
data/state.json → { "started_core_pid": 23524, "started_at": "..." }
```

下次启动发现 PID 还活着且是自己的 → 提示用户「检测到上次的核心仍在运行，要停止吗？」

---

## 四、需求 2：全面小写化（P0）

| 位置 | 现值 | 目标 |
|---|---|---|
| exe | `EasyTier-Console.exe` | `easytier-console.exe` |
| productName | `EasyTier-Console` | `easytier-console` |
| 运行目录 | `D:\EasyTier-Console` | `D:\easytier-console` |
| 发布包 | `EasyTier-Console-v1.1.0-...` | `easytier-console-v1.1.1-...` |
| 自启快捷方式 | `EasyTier Console.lnk` | `easytier-console.lnk` |

### 迁移脚本 `scripts/migrate-lowercase.sh`

```
1. 停进程（GUI + core）
2. 停自启（删旧快捷方式）
3. 目录改名 D:\EasyTier-Console → D:\easytier-console
4. 替换 exe
5. 重建自启快捷方式
6. 校验：目标存在 + 快捷方式可解析 + 试启动
7. 失败则回滚目录名
```

**注意**：`identifier` 保持 `com.easytier.console` 不变，否则 WebView 数据目录会变，localStorage 里的配置全丢。

---

## 五、需求 3 + 4：设置面板 + 页面设置（P0）

### 抽屉结构

```
┌─ 设置 ─────────────── [📁] [×] ┐
│ 主题   │                        │
│ 页面   │   （内容区）            │
│ 启动退出│                       │
│ 配置   │                        │
│ 日志   │                        │
└────────┴────────────────────────┘
```

### 页面设置

7 个模块，每个支持：显隐 / 拖拽排序 / 改名

```
⣿ ☑ 本节点      [本节点    ] ↺
⣿ ☑ 对等节点    [对等节点  ] ↺
⣿ ☑ 网络拓扑    [网络拓扑  ] ↺
⣿ ☑ 子网代理    [子网代理  ] ↺
⣿ ☐ 路由表      [路由表    ] ↺
⣿ ☑ 端口转发    [端口转发  ] ↺
⣿ ☑ 活跃连接    [活跃转发连接] ↺
```

**实现约束**：拖动用 `insertBefore` 移动节点，**禁止重建 DOM**（会丢表格滚动位置）。

---

## 六、需求 5 + 6 + 7：配置重构（P1）

### 新结构：4 个标签页

```
[基础] [网络] [端口转发] [高级]
```

**「对等节点」从配置页移除** —— 它是一次性部署配置，改了必然要重启核心，放在日常设置里反而误导用户。

### 6.1 基础

| 字段 | 类型 | 对应 TOML |
|---|---|---|
| 实例名 | text | `instance_name` |
| 主机名 | text | `hostname` |
| 虚拟 IP | text | `ipv4` |
| 启用 DHCP | switch | `dhcp` |
| TUN 设备名 | text | `[flags] dev_name` |
| MTU | number | `[flags] mtu` |

### 6.2 网络

| 字段 | 类型 | 对应 |
|---|---|---|
| 网络名称 | text（必填） | `network_name` |
| 网络密钥 | password（必填） | `network_secret` |
| 安全模式 | switch | `secure_mode` |
| 本地私钥 | password | `local_private_key` |
| 监听地址 | 列表 | `listeners` |
| 子网代理 | 列表 | `[[proxy_network]] cidr` |

### 6.3 端口转发（独立标签页）

用卡片列表，比 TOML 里的 `[[port_forward]]` 直观得多：

```
┌────────────────────────────────────────┐
│ 0.0.0.0:13389  →  127.0.0.1:3389       │
│ 绑定地址             目标地址            │
│ 协议 TCP     [编辑] [删除]              │
├────────────────────────────────────────┤
│ 0.0.0.0:13390  →  127.0.0.1:22         │
│ 协议 TCP     [编辑] [删除]              │
└────────────────────────────────────────┘
        [+ 添加转发规则]
```

**加一个「常用模板」下拉**，一键填 RDP / SSH / SMB / HTTP：

| 模板 | 绑定 | 目标 |
|---|---|---|
| RDP | `0.0.0.0:13389` | `127.0.0.1:3389` |
| SSH | `0.0.0.0:10022` | `127.0.0.1:22` |
| SMB | `0.0.0.0:10445` | `127.0.0.1:445` |
| HTTP | `0.0.0.0:10080` | `127.0.0.1:80` |

### 6.4 高级（官方全参数）

**按官方 `easytier-core --help` 实测整理，共 70+ 项。分组折叠展示**，默认只展开常用组。

#### 组 A：IPv6

| 字段 | 类型 |
|---|---|
| `ipv6` | text |
| `disable_ipv6` | switch |
| `ipv6_public_addr_auto` | switch |
| `ipv6_public_addr_prefix` | text |
| `ipv6_public_addr_provider` | text |

#### 组 B：协议加速（KCP / QUIC）

| 字段 | 类型 | 说明 |
|---|---|---|
| `enable_kcp_proxy` | switch | KCP 代理 TCP 流，弱网提速 |
| `disable_kcp_input` | switch | 不允许别人用 KCP 连我 |
| `enable_quic_proxy` | switch | QUIC 代理 TCP 流 |
| `disable_quic_input` | switch | 不允许别人用 QUIC 连我 |
| `quic_listen_port` | number | 0=随机 |
| `default_protocol` | select | tcp/udp/ws/wss/quic/wg |
| `compression` | select | none / zstd |

#### 组 C：P2P 与穿透

| 字段 | 类型 |
|---|---|
| `disable_p2p` | switch |
| `p2p_only` | switch |
| `lazy_p2p` | switch |
| `need_p2p` | switch |
| `disable_udp_hole_punching` | switch |
| `disable_tcp_hole_punching` | switch |
| `disable_sym_hole_punching` | switch |
| `disable_upnp` | switch |
| `stun_servers` | 列表 |
| `stun_servers_v6` | 列表 |
| `tcp_stun_servers` | 列表 |
| `mapped_listeners` | 列表 |

#### 组 D：路由与转发

| 字段 | 类型 |
|---|---|
| `latency_first` | switch（延迟优先 vs 最短路径） |
| `exit_nodes` | 列表 |
| `enable_exit_node` | switch |
| `manual_routes` | 列表 |
| `proxy_forward_by_system` | switch |
| `relay_network_whitelist` | text |
| `relay_all_peer_rpc` | switch |
| `foreign_relay_bps_limit` | number |
| `instance_recv_bps_limit` | number |

#### 组 E：白名单

| 字段 | 类型 |
|---|---|
| `tcp_whitelist` | text（支持 80,8000-9000） |
| `udp_whitelist` | text |
| `private_mode` | switch |
| `rpc_portal_whitelist` | text |
| `socks5` | number |

#### 组 F：高级杂项

| 字段 | 类型 |
|---|---|
| `no_tun` | switch |
| `use_smoltcp` | switch |
| `multi_thread` | switch |
| `multi_thread_count` | number |
| `bind_device` | text |
| `accept_dns` | switch |
| `tld_dns_zone` | text |
| `vpn_portal` | text |
| `vpn_portal_private_key` | password |
| `vpn_portal_client` | 列表 |
| `credential` | password |
| `credential_file` | text |
| `machine_id` | text |
| `encryption_algorithm` | select |

#### 组 G：日志（进程级，需重启才生效）

`console_log_level` / `file_log_level` / `file_log_dir` / `file_log_size` / `file_log_count`

**注意**：官方文档明确说日志配置**不支持写在 `-c` 配置文件里**，只能通过命令行或环境变量。所以这组要单独处理——改完需要重启核心并传对应参数。

### 双向同步机制

表单 ↔ TOML 必须双向同步：

```
TOML 解析成 JSON（serde） → 表单绑定
表单改动 → 生成 TOML → 保存
```

**难点**：TOML 的 `[[peer]]`、`[[proxy_network]]`、`[[port_forward]]` 是数组表，
表单化时要保持顺序和完整性。**未识别的字段必须原样保留**，否则用户手写的
ACL 规则会被表单吞掉。

方案：解析时把未知字段存入 `_unknown: toml::Value`，生成时合并回去。

---

## 七、需求 8：网络拓扑图（P1，需优化）

### 第一版的问题

之前的实现是「本机居中 + 其余环形环绕」，有两个缺陷：

1. **连线重叠**：全互联 mesh 下，6 个节点有 15 条边，环形的弦全部穿过中心
2. **层次不清**：看不出谁是中转、谁是直连

### 优化方向（参考网络拓扑可视化惯例）

#### 7.1 克制连线数量

**默认只画「本机 ↔ 每个节点」的边**（星型），而不是全互联。

理由：用户关心的是「我这台机器和谁连着、怎么连」，
节点之间的互联关系在详情里看即可。想看全图再点「显示全部连接」。

```
默认：星型（6 条边）
        ○ kylinos
        │
○ zl-nas ─ ● 本机 ─ ○ zl-jxgm
        │
        ○ ecs-relay
```

#### 7.2 用视觉编码表达「怎么连」

| 连接方式 | 线型 | 颜色 |
|---|---|---|
| 直连 p2p | 实线，粗 | 绿 |
| 经中转 relay | 虚线 | 橙 |
| 本机 | — | 蓝 |

线宽按延迟分档：<10ms 粗、10-50ms 中、>50ms 细（视觉上「越粗越快」）。

#### 7.3 节点信息分层

```
        ╭─────────╮
        │    ●    │  ← 圆圈大小=角色（本机大，中转中，普通小）
        │ kylinos │  ← 第一行：主机名
        ╰─────────╯
          1.05ms    ← 第二行：延迟（颜色编码）
          p2p ✓     ← 第三行：连接方式
```

**默认只显示名称和延迟**，连接方式用圆圈边框样式区分（实线边=直连，虚线边=中转），
避免文字过多。

#### 7.4 布局：分层而非环形

参考网络管理工具的惯例，用**径向分层**：

```
第 0 层（中心）：本机
第 1 层（内环）：直连 p2p 节点
第 2 层（外环）：仅中转可达的节点
```

这样一眼能看出「哪些是直连、哪些绕了路」。

角度分配：按延迟排序，从顶部顺时针排列，相邻角度均分。
如果某层只有 1 个节点，放正上方。

#### 7.5 交互

| 操作 | 效果 |
|---|---|
| 悬停节点 | 高亮该节点及其连线，其他淡出到 25% |
| 点击节点 | 打开节点详情弹窗 |
| 悬停连线 | tooltip 显示「A ↔ B  延迟 xx ms  协议 tcp」 |
| 拖拽节点 | 手动调整位置（松手记住，存 localStorage） |
| 滚轮 | 缩放（0.5x ~ 2.5x） |
| 双击空白 | 重置布局 |

#### 7.6 视觉细节

- 背景：径向渐变（中心略亮），暗示「本机在中心」
- 节点圆：双层（外圈 halo 半透明 + 内圈实心）
- 连线：`stroke-linecap="round"`，避免直角
- 动画：切换布局时用 CSS transition 平滑移动（`transform` 过渡 0.35s）
- 无数据/未运行时：显示空状态插画 + 提示文案

#### 7.7 保留「全部连接」模式

工具栏：
```
[星型视图] [全互联] [环形]      ☑ 显示延迟  ☐ 显示字节数
```

全互联模式下降低所有边透明度到 30%，只在悬停时高亮，避免视觉噪音。

---

## 八、需求 9：延迟大图（P2，动 Rust）

### 后端

```sql
CREATE TABLE samples (
  node_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  lat     REAL,
  loss    REAL,
  PRIMARY KEY (node_id, ts)
);
```

采样线程：每 5 秒，独立于前端轮询。
保留 24 小时，每小时清理一次。
位置：`data/history.db`

命令：`get_latency_history(node_id, minutes) -> Vec<Point>`
降采样到最多 360 点。

### 前端

点 sparkline → 模态框，1h/6h/24h + 延迟/丢包切换 + 平均线 + hover 十字准线 + 导出 CSV。

---

## 九、需求 10：节点详情（P2）

5 个分区：基本信息 / 连接质量 / 流量 / 路径 / 直连邻居。
数据源：`peer` + `peer-center` + `route` 三命令组合。
按需查询，不进主轮询。

---

## 十、实施顺序（7 步）

每步独立可验证、可回滚：

| 步 | 内容 | 验证方式 |
|---|---|---|
| **S1** | 进程生命周期（关闭配置 + 孤儿清理） | 强杀 GUI → 重启 → 确认孤儿被清理 |
| **S2** | 小写化迁移 | 目录改名成功、自启重建、能启动 |
| **S3** | 设置面板框架 + 页面设置 | 5 分区可切换、模块显隐排序改名生效 |
| **S4** | 配置重构（基础/网络/端口转发/高级） | 表单改动能正确写回 TOML、未知字段保留 |
| **S5** | 拓扑图优化 | 布局清晰、悬停高亮正确 |
| **S6** | SQLite + 延迟大图 | 数据落盘、大图正确、CSV 导出 |
| **S7** | 节点详情 | 信息完整 |

**S1 和 S2 必须最先做**，因为它们改变了文件结构和进程行为，
后续所有测试都依赖新的运行环境。

---

## 十一、风险与对策

| 风险 | 对策 |
|---|---|
| 目录改名导致 localStorage 丢失 | `identifier` 不变，数据目录路径不变 |
| 表单吞掉未知 TOML 字段 | 解析时保存 `_unknown`，生成时合并回去 |
| 日志配置写不进 TOML | 单独处理，改完提示「需重启核心」并传命令行参数 |
| 拓扑图连线过多看不清 | 默认星型视图，全互联作为可选 |
| SQLite 增大二进制 | +1.5MB 可接受 |
| 孤儿清理误杀用户手动启动的 core | 只清理父进程已退出的，不碰其他 |

---

## 十二、待确认

1. **「启动时清理孤儿 core」是否需要弹窗告知？**
   - A：静默清理，日志记录一笔（推荐，无干扰）
   - B：弹窗询问「检测到上次残留的核心，要清理吗？」

2. **高级配置 70+ 项，是否默认全部展开？**
   - A：按组折叠，默认只展开「IPv6」「协议加速」（推荐）
   - B：全部展开，滚动查看

3. **端口转发的「常用模板」要不要？**（RDP/SSH/SMB/HTTP 一键填）

4. **拓扑图默认视图**：星型（推荐）还是全互联？
