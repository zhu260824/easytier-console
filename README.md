# EasyTier 控制台

EasyTier 的第三方桌面控制台。用一个 exe 管理 EasyTier 的虚拟网络：查看节点状态、
子网代理、端口转发、路由表，一键启停核心，支持系统托盘常驻。

> **本项目不是 EasyTier 官方项目**，只是对官方 `easytier-core` / `easytier-cli` 的图形化封装。
> EasyTier 本体见 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)。

---

## 功能

**实时状态**
- 本节点信息：虚拟 IP、Peer ID、UDP/TCP NAT 类型（中文标注）、公网 IP、监听地址
- 对等节点：主机名、虚拟 IP、连接方式（直连/中转）、延迟、丢包、收发字节、NAT 类型
- 路由表：每跳节点、路径延迟、下一跳、可访问网段
- 子网代理：每个网段一张卡片，显示活跃连接数
- 端口转发：规则列表 + 当前活跃连接

**控制**
- 启动 / 停止 / 重启核心，带完整 loading 反馈
- 内置配置编辑器，保存前做语法校验并自动备份
- 查看运行日志（时间戳自动转本地时区）
- 系统托盘：关闭窗口不退出，托盘菜单可直接启停核心
- 开机自启（写用户启动文件夹，不碰注册表）

**绿色便携**
- 单 exe + 一个 `resource` 目录，无安装、无依赖
- 所有路径相对 exe 所在目录，可整体拷到 U 盘

---

## 使用

### 1. 准备运行时文件

本仓库**不包含** EasyTier 的二进制文件（体积大且更新频繁）。
请从 [EasyTier Releases](https://github.com/EasyTier/EasyTier/releases) 下载对应平台的文件，
按下面结构放好：

```
dist/
├── EasyTier 控制台.exe        ← 本项目的程序
├── config/
│   └── config.toml            ← 配置（首次使用需改成自己的网络参数）
├── logs/                      ← 日志目录（自动创建）
└── resource/
    ├── easytier-core.exe      ← 从 EasyTier 下载
    ├── easytier-cli.exe       ← 从 EasyTier 下载
    ├── wintun.dll             ← Windows 必需
    ├── Packet.dll             ← 可选（WinDivert 抓包相关）
    └── WinDivert64.sys        ← 可选
```

首次启动会自动创建 `config/`、`logs/`、`resource/` 三个目录。
如果你把 EasyTier 的文件直接散在 exe 同目录，首次启动会自动归位到 `resource/`。

### 2. 配置

仓库根目录的 `config.example.toml` 是**示例模板**，复制到运行时目录再改：

```bash
# Windows
copy config.example.toml dist\config\config.toml

# Linux / macOS
cp config.example.toml dist/config/config.toml
```

然后编辑 `dist/config/config.toml`，至少要改：

```toml
[network_identity]
network_name = "your-network-name"
network_secret = "a-strong-random-secret"
```

`network_name` 和 `network_secret` 必须与你的其他 EasyTier 节点一致。
如果需要连到其他节点，还要配 `[[peer]]`（种子地址），否则只能发现自己。

详见 [EasyTier 配置文档](https://easytier.cn/guide/network/configuration-file.html)。

> ⚠️ **注意区分两个文件**
>
> | 文件 | 用途 | 是否入库 |
> |---|---|---|
> | `config.example.toml` | 示例模板，不含真实参数 | ✅ 会提交 |
> | `dist/config/config.toml` | 实际运行配置，含真实密钥 | ❌ 已忽略 |
>
> 改配置请改 `dist/config/config.toml`，**不要改示例模板**，
> 也不要拿模板覆盖运行时配置（那样会丢失 peer 和密钥，导致连不上任何节点）。

### 3. 运行

双击 `EasyTier 控制台.exe` → UAC 提示点「是」→ 点「启动」。

> ⚠️ **必须用管理员权限运行。**
> EasyTier 通过 wintun 驱动创建虚拟网卡，需要加载内核驱动和修改网络配置，
> 普通权限下会报 `Failed to create adapter` 并退出。
> 程序检测到权限不足时会自动弹 UAC 请求提权。

---

## 从源码构建

### 环境要求

- Rust 1.77+
- Windows: MSVC 工具链（Visual Studio 2022 生成工具）
- WebView2 运行时（Windows 10/11 已内置）

### 构建

```bash
cd src-tauri
cargo build --release
```

产物在 `src-tauri/target/release/easytier-console.exe`，
重命名为 `EasyTier 控制台.exe` 后按上面的目录结构放置即可。

### 打包

```bash
cd src-tauri
cargo tauri build
```

或在项目根目录用 `cargo tauri` 命令。打包需要额外安装 `cargo-tauri`：

```bash
cargo install tauri-cli --version "^2"
```

### 重新生成图标

图标基于 EasyTier 官方 logo。如需调整尺寸，修改 `scripts/gen_icons.py` 里的
源文件路径后运行：

```bash
python scripts/gen_icons.py
```

---

## 项目结构

```
.
├── src/                       前端（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src-tauri/                 Rust 后端
│   ├── src/main.rs            全部逻辑（Tauri 命令 + 进程管理 + 托盘）
│   ├── Cargo.toml
│   ├── build.rs               嵌入 UAC 清单
│   ├── tauri.conf.json
│   ├── app.manifest           要求管理员权限
│   ├── app.rc
│   └── icons/
├── scripts/
│   └── gen_icons.py           图标生成（纯标准库）
├── config.example.toml        配置示例模板（复制到 dist/config/ 后修改）
├── dist/                      发布包（不入版本控制）
├── .gitignore
├── LICENSE
└── README.md
```

---

## 实现要点

### 进程启动参数

启动 `easytier-core` 时固定使用：

```
easytier-core.exe -c <config.toml> -r 127.0.0.1:15888 \
    （creation_flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP）
```

两个关键点：

1. **必须显式指定 `-r 127.0.0.1:15888`**
   核心的默认值语义是「先试 15888，被占用则随机选端口」。
   若随机到其他端口，`easytier-cli` 仍去连 15888 就会失败，界面显示「采集失败」。

2. **不能用 `CREATE_NO_WINDOW`，也不能加 `CREATE_BREAKAWAY_FROM_JOB`**
   实测矩阵（同一 exe、同一配置）：

   | 进程创建标志 | 值 | 建网卡结果 |
   |---|---|---|
   | 无 | `0x00000000` | ✅ |
   | `DETACHED_PROCESS` | `0x00000008` | ✅ |
   | `DETACHED \| NEW_GROUP` | `0x00000208` | ✅ |
   | `CREATE_NO_WINDOW` | `0x08000000` | ✅ |
   | `DETACHED \| NEW_GROUP \| BREAKAWAY` | `0x01000208` | ❌ |

   `CREATE_BREAKAWAY_FROM_JOB` 有两种失败形态：`spawn` 直接返回
   `WinError 5 拒绝访问`，或 **`spawn` 成功但 core 内部建网卡失败**
   （日志报 `Failed to create adapter`）。后者最坑——因为 `spawn` 返回 `Ok`，
   代码里的「失败降级」分支根本不会触发。

### wintun 僵尸设备清理

core 被强制结束（任务管理器、崩溃、断电）时，wintun 创建的设备会残留在
PnP 里，状态变成 `Unknown`。这种残留 `ipconfig` 看不到，只有 `Get-PnpDevice` 能看到：

```powershell
Get-PnpDevice | Where-Object { $_.InstanceId -like 'SWD\WINTUN\*' }
```

下次启动时 wintun 建新适配器就会失败。程序的处理方式：

1. 启动前扫描并移除状态异常的 wintun 设备
2. 启动失败时再清理一次并自动重试
3. 停止时先发优雅终止信号（让 core 自己清理网卡），超时才强杀，之后再次清理

### 日志时间

`easytier-core` 输出 UTC 时间（`2026-11-10T03:01:52.556Z`）。
前端在展示时转成本地时区（`2026-11-10 11:01:52.556`）。

### 开机自启

按 [MS-SHLLINK] 规范手工构造 `.lnk` 二进制，写入：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EasyTier 控制台.lnk
```

相比写注册表的好处：不依赖 `reg.exe`、可在「任务管理器 → 启动」里管理、
关闭开关即删文件、对系统零侵入。

细节：`LocalBasePath` 字段按规范是 ANSI 字符串，路径含中文时会变成乱码。
程序检测到非 ASCII 时把该字段留空，完整路径由 UTF-16 的 `StringData` 承载。

### 提权

easytier-core 建虚拟网卡必须有管理员权限。程序启动时检测：

```rust
if !is_elevated() && elevate_self() {
    std::process::exit(0);   // ShellExecuteW + "runas" 拉起管理员实例
}
```

传 `--elevated` 标记防止无限循环重启。

---

## 命令行自检

不开界面也能验证各功能，排查问题很有用：

```powershell
.\EasyTier 控制台.exe --selftest            # 完整自检
.\EasyTier 控制台.exe --selftest status     # 只查状态
.\EasyTier 控制台.exe --selftest log        # 只读日志
.\EasyTier 控制台.exe --selftest config     # 只测配置读取与校验
.\EasyTier 控制台.exe --selftest start      # 启动核心
.\EasyTier 控制台.exe --selftest stop       # 停止核心
.\EasyTier 控制台.exe --selftest restart    # 重启核心
.\EasyTier 控制台.exe --selftest autostart-on
.\EasyTier 控制台.exe --selftest autostart-off
```

输出末尾显示 `失败项: N`，0 表示全部正常。

---

## 常见问题

### 启动报 `Failed to create adapter`

按顺序检查：

1. **是否以管理员身份运行**（这是最常见原因）
2. `resource/wintun.dll` 是否存在
3. 有 wintun 僵尸设备残留 → 点「停止」，看是否提示「清理了 N 个残留网卡」
4. 手动清理：
   ```powershell
   Get-PnpDevice | Where-Object { $_.InstanceId -like 'SWD\WINTUN\*' -and $_.Status -ne 'OK' } |
     ForEach-Object { pnputil /remove-device $_.InstanceId }
   ```
5. 重启系统

### 状态显示「采集失败」

`easytier-cli` 连不上 core 的 RPC 门户（`127.0.0.1:15888`）。
本程序启动 core 时会显式加 `-r 127.0.0.1:15888` 保证一致。
如果之前用别的方式启动过 core 且没带这个参数，点「重启」即可恢复。

### 托盘图标不见了

Windows 可能把它收进了隐藏图标区（点任务栏 ^ 展开）。
如需固定，在隐藏区里把图标拖到任务栏。

---

## 已知限制

- **仅测试过 Windows 10/11 x64**。代码里有 Linux/macOS 分支（`cfg(target_os)`），
  但未经过实机验证。
- 不支持修改运行中核心的参数（EasyTier 本身也不支持热重载配置，改完需重启）。
- 托盘菜单的「启动核心」失败时只会把窗口叫出来，不会弹独立错误框。

---

## 致谢

- [EasyTier](https://github.com/EasyTier/EasyTier) —— 本项目的底层网络引擎，MIT 协议
- [Tauri](https://tauri.app/) —— 应用框架
- [Wintun](https://www.wintun.net/) —— Windows 虚拟网卡驱动

本项目使用的 EasyTier logo 版权归 EasyTier 项目所有，此处仅作生态关联标识。

---

## 许可证

[MIT](LICENSE)
