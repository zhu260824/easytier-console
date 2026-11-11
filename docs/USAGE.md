# EasyTier 控制台 —— 使用说明

**绿色便携版，双击即用，不需要安装 Python、Rust 或任何运行时。**

---

## 一、目录结构

```
dist\
├── EasyTier-Console.exe        ← 只需要双击这一个
├── config\
│   └── config.toml           ← EasyTier 配置文件
├── logs\
│   └── easytier-runtime.log  ← 运行日志（自动生成）
└── resource\                 ← EasyTier 运行时（不用动）
    ├── easytier-core.exe
    ├── easytier-cli.exe
    ├── wintun.dll
    ├── Packet.dll
    └── WinDivert64.sys
```

**所有路径都相对于 exe 所在目录**，整个 `dist` 文件夹可以随意移动、拷到 U 盘，路径不变即可正常工作。

---

## 二、快速开始

1. 双击 `EasyTier-Console.exe`
2. **Windows 会弹出 UAC 提示**（「是否允许此应用对你的设备进行更改」），点 **「是」**
3. 点右上角 **「启动」** 按钮
4. 稍等几秒，状态徽章变绿显示「运行中」，各卡片出现数据

### ⚠️ 必须要有管理员权限

**这是硬性要求，不是可选的。**

EasyTier 通过 **wintun 驱动创建虚拟网卡**，需要加载内核驱动、修改网络配置。
普通用户权限下必然失败，核心会报：

```
ERROR CORE::INSTANCE: tun device error err=rust tun error Failed to create adapter
ERROR CORE: error=some instances stopped with errors
```

**实测对比**（同一 exe、同一份配置）：

| 运行权限 | 结果 |
|---|---|
| 管理员（High Mandatory Level） | `INFO tun device ready dev="et_6_xxxx"` ✅ |
| 普通用户（Basic User / runas /trustlevel） | `ERROR Failed to create adapter` ❌ |

**两种确保管理员权限的方式：**

**方式 A（推荐）**：直接双击，程序检测到权限不足时会自动弹 UAC 请求提权，
点「是」即可。提权后会自动重新打开界面。

**方式 B**：右键 `EasyTier-Console.exe` → **「以管理员身份运行」**

**如果 UAC 提示被拒绝**：程序会以普通权限打开，界面顶部会显示红色的
「未以管理员身份运行」警告条，此时点「启动」会弹出明确的错误说明而不是莫名失败。

> 提示：想永久免除 UAC 提示，可以右键 exe → 属性 → 兼容性 →
> 勾选「以管理员身份运行此程序」。注意这会跳过 UAC 确认，请自行评估安全性。

---

## 三、界面说明

### 操作反馈（loading）

所有耗时操作都有明确的视觉反馈，不会出现「点了没反应」：

| 操作 | 反馈形式 | 耗时 |
|---|---|---|
| **启动** | 全屏遮罩 +「正在启动核心…创建虚拟网卡、连接对等节点」 | 2~5 秒 |
| **停止** | 全屏遮罩 +「正在停止核心…清理虚拟网卡并释放端口」 | 1~3 秒 |
| **重启** | 全屏遮罩 +「正在重启核心…先停止再创建网卡」 | 4~8 秒 |
| **刷新** | 按钮内联转圈（不遮挡界面） | < 1 秒 |
| **打开目录** | 按钮内联转圈 | < 1 秒 |
| **刷新日志** | 按钮内联转圈 | < 1 秒 |
| **保存配置** | 按钮内联转圈 +「校验中…」文字 | < 1 秒 |
| **开机自启开关** | 顶部徽章变「正在开启/关闭自启…」 | < 1 秒 |

**三个层次的反馈设计：**

1. **按钮内联转圈** — 轻量操作。按钮内出现小转圈，文字略变淡，不遮挡界面。
2. **全屏遮罩** — 耗时操作。半透明遮罩 + 居中卡片 + 转圈动画 + 说明文字，
   明确告诉你"系统正在做什么"以及"大概要等多久"。
3. **顶部状态徽章** — 转为蓝色转圈样式显示「启动中…」/「停止中…」，
   不遮挡界面，适合需要边操作边看数据的场景。

**细节处理：**

- 操作进行中会**暂停自动轮询**，避免 2 秒一次的刷新覆盖掉 loading 状态
- 操作期间**其他按钮保持禁用**，防止重复点击
- 操作完成/失败后都会**立即刷新数据并恢复轮询**，不会让界面"卡死"
- 失败时用红色 toast 提示具体原因，并立刻恢复按钮可用

### 顶部栏
| 元素 | 说明 |
|---|---|
| 状态徽章 | 🟢 运行中 / 🔴 已停止 / 蓝色转圈「启动中…」/「重连中…」（采集偶发失败时自动重试） |
| 启动 / 停止 / 重启 | 控制 easytier-core 进程，按钮按状态自动禁用，操作时显示转圈 |

### 本节点
显示虚拟 IP、主机名、Peer ID、UDP/TCP NAT 类型（中文）、公网 IP、对外端口范围、监听地址，以及对等节点/网段/活跃连接的统计。

### 对等节点
九列：**主机名 → 虚拟 IP → 连接方式 → 延迟 → 丢包 → 隧道 → 接收 → 发送 → NAT 类型**

- 连接方式颜色：`直连`（绿）/ `中转`（橙）/ `本机`（灰）
- 延迟分级：<15ms 绿 / <50ms 亮绿 / <150ms 橙 / >150ms 红

### 子网代理
每个网段一张卡片，显示允许协议、本机地址、访问入口、当前活跃连接数。

### 路由表
每个节点的跳数、路径延迟、下一跳、可访问网段。

### 端口转发
每条规则显示协议、绑定地址 → 目标地址，并自动识别常见端口用途（3389 远程桌面、22 SSH、445 SMB 等）。

### 活跃转发连接
当前正在转发的连接，标注来源、目标、状态，以及所属规则（端口转发 / 子网代理）。

### 操作区
| 按钮 | 功能 |
|---|---|
| 查看日志 | 右侧抽屉显示最近 400 行运行日志 |
| 编辑配置 | 弹窗编辑 `config/config.toml`，保存前做语法校验，并自动备份为 `.toml.bak` |
| 打开目录 | 用资源管理器打开程序目录 |
| **开机自启** | 开关，写入用户启动文件夹的快捷方式 |

---

## 四、配置文件

`config/config.toml` 是标准 EasyTier 配置，示例：

```toml
instance_name = "default"
hostname = "my-pc"
ipv4 = "10.0.0.1"
dhcp = false

listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]

[network_identity]
network_name = "your-network"
network_secret = "your-secret"

[[peer]]
uri = "tcp://1.2.3.4:11010"

[[proxy_network]]
cidr = "192.168.1.0/24"

[[port_forward]]
bind_addr = "0.0.0.0:13389"
dst_addr = "127.0.0.1:3389"
proto = "tcp"
```

控制台的「编辑配置」会做**基础语法校验**（缺等号、括号不闭合、字符串未闭合等），
并检查是否存在 `[network_identity]` 段。真正的 TOML 解析仍由 core 完成。

---

## 五、系统托盘

程序支持**最小化到系统托盘**，不占任务栏。

### 行为

| 操作 | 效果 |
|---|---|
| 点窗口右上角 **✕ 关闭** | **隐藏到托盘**，程序继续运行（不退出） |
| **左键单击**托盘图标 | 显示并聚焦主窗口 |
| **右键单击**托盘图标 | 弹出菜单 |
| 菜单「显示主窗口」 | 同左键 |
| 菜单「启动核心」 | 不打开窗口直接启动 core |
| 菜单「停止核心」 | 不打开窗口直接停止 core |
| 菜单「退出」 | **真正退出**（会先停止 core，不留孤儿进程） |

### 托盘菜单

```
┌──────────────┐
│ 显示主窗口    │
├──────────────┤
│ 启动核心      │
│ 停止核心      │
├──────────────┤
│ 退出          │
└──────────────┘
```

### 为什么要用托盘

EasyTier 通常需要长期后台运行。最小化到托盘后：
- 任务栏不占位置
- core 继续工作，显存/CPU 占用不变
- 随时右键查看/控制

**真实退出**请用托盘菜单的「退出」，或点窗口关闭后从托盘退出。
直接结束进程（任务管理器）不会停掉 core，也不会清理虚拟网卡。

---

## 六、开机自启说明

开启后会在以下位置创建快捷方式：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EasyTier 控制台.lnk
```

**优点**：
- 不写注册表，对系统零侵入
- 可在「任务管理器 → 启动」里看到并随时禁用
- 关闭开关即删除该文件（同时会清理改名前遗留的旧快捷方式）

**注意**：开机自启只启动**控制台窗口**，不会自动启动 core。如果需要开机自动连网，可以：
- 在控制台启动后手动点「启动」；或
- 把 `easytier-core.exe` 注册为 Windows 服务（需额外配置）

**想开机自动进托盘？** 目前启动后会显示主窗口。如果需要静默启动，
可以给快捷方式加 `--tray` 参数（预留能力）。

---

## 七、命令行自检（排查问题用）

程序内置自检模式，无需 GUI 即可验证各功能：

```powershell
cd dist

# 完整自检
.\EasyTier-Console.exe --selftest

# 只查状态
.\EasyTier-Console.exe --selftest status

# 只读日志
.\EasyTier-Console.exe --selftest log

# 只测配置读取与校验
.\EasyTier-Console.exe --selftest config

# 动作类
.\EasyTier-Console.exe --selftest start
.\EasyTier-Console.exe --selftest stop
.\EasyTier-Console.exe --selftest restart
.\EasyTier-Console.exe --selftest autostart-on
.\EasyTier-Console.exe --selftest autostart-off
```

输出末尾会显示 `失败项: N`，0 表示全部正常。

---

## 八、常见问题

### 状态显示「已停止」但点启动没反应
检查 `resource\` 下的三个关键文件是否齐全：
- `easytier-core.exe`
- `easytier-cli.exe`
- `wintun.dll`（必需，缺了 tun 设备建不起来）

### 启动后立即退出

1. 点「查看日志」，看最后几行报错
2. 常见原因：
   - 配置文件语法错误（用「编辑配置」检查）
   - 11010 端口被占用（关掉其他 EasyTier 实例）
   - 缺少 `wintun.dll`

### 日志出现 `Failed to create adapter`

完整报错形如：
```
ERROR CORE::INSTANCE: tun device error err=rust tun error Failed to create adapter
ERROR CORE: error=some instances stopped with errors
```

**含义**：虚拟网卡创建失败，core 因此退出。

这个错误有**两个已知成因**，1.0.0 版本都已处理：

#### 成因 1：`CREATE_BREAKAWAY_FROM_JOB` 标志（已修复）

早期版本为了「让 core 脱离面板独立存活」，在启动参数里加了
`CREATE_BREAKAWAY_FROM_JOB`（0x01000000）。实测这个标志会导致 wintun 建网卡失败：

| 进程创建标志 | 十六进制 | 建网卡结果 |
|---|---|---|
| 无 | 0x00000000 | ✅ 成功 |
| `DETACHED_PROCESS` | 0x00000008 | ✅ 成功 |
| `DETACHED \| NEW_GROUP` | 0x00000208 | ✅ 成功 |
| `CREATE_NO_WINDOW` | 0x08000000 | ✅ 成功 |
| `DETACHED \| NEW_GROUP \| BREAKAWAY` | 0x01000208 | ❌ **失败** |

失败有两种形态，第二种特别难查：
1. `spawn` 直接失败：`WinError 5 拒绝访问`（父进程在不允许 breakaway 的 Job 里）
2. **`spawn` 成功，但 core 内部建网卡失败**——日志报 `Failed to create adapter`

第 2 种最坑：因为 `spawn()` 返回 Ok，代码里的「失败降级」分支根本不会触发，
现象就是「启动后立即退出」，日志里只有一句 tun device error。

现在**只用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`**，彻底不用 BREAKAWAY。
`DETACHED_PROCESS` 已经能保证 core 不属于面板的进程组，面板关闭不会连带杀掉 core。

#### 成因 2：wintun 僵尸适配器残留（已自动处理）

core 被**强制结束**（任务管理器结束进程、崩溃、断电）时，wintun 创建的设备会
残留在 PnP 里，状态变成 `Unknown`：

```powershell
# 查看是否有残留
Get-PnpDevice | Where-Object { $_.InstanceId -like 'SWD\WINTUN\*' }
# 输出形如：[Unknown] et_6_qxck Tunnel
```

**注意**：这种残留 `ipconfig` 看不到（网卡本身已消失），只有 `Get-PnpDevice` 能看到。

下次启动时，wintun 建新适配器就会失败。

**现在的处理方式**（自动，无需干预）：
1. **启动前**自动扫描并移除状态异常的 wintun 设备
2. **启动失败时**再清理一次并重试
3. **停止时**先发优雅终止信号（让 core 自己清理网卡），超时才强杀，之后再次清理

启动成功的提示里如果出现「清理了 N 个残留网卡」，说明触发了这套机制。

**手动清理**（万一自动清理失效）：
```powershell
# 以管理员身份运行
Get-PnpDevice | Where-Object { $_.InstanceId -like 'SWD\WINTUN\*' -and $_.Status -ne 'OK' } |
  ForEach-Object { pnputil /remove-device $_.InstanceId }
```

#### 排查顺序

1. **是否以管理员身份运行**（右键 exe → 以管理员身份运行）
2. `resource\wintun.dll` 是否存在（当前版本 0.14.1）
3. 点「停止」按钮，看是否提示「清理了 N 个残留网卡」
4. 手动执行上面的 PowerShell 清理命令
5. 重启系统

### 显示「采集失败」

说明 `easytier-cli` 连不上 core 的 RPC 门户（`127.0.0.1:15888`）。
控制台启动 core 时会显式加 `-r 127.0.0.1:15888` 参数保证一致。
如果手动启动过 core 且没带这个参数，会导致 CLI 连不上——用控制台的「重启」按钮即可恢复。

### 控制台显示「控制台失联」
前端连续 3 次采集失败才显示此状态，中间会显示「重连中…」。
如果持续失联，可能是控制台进程已退出，重新双击 exe 即可。

---

## 九、技术参数

| 项目 | 数值 |
|---|---|
| 主程序体积 | 3.1 MB |
| 内存占用 | 约 27 MB |
| 启动时间 | < 1 秒 |
| 技术栈 | Rust + Tauri 2 + WebView2 |
| 渲染 | 系统 WebView2（不用打包 Chromium） |

---

## 十、从旧版迁移

如果你之前把 EasyTier 文件放在别的目录（比如 `D:\easytier-core`），
把 `easytier-core.exe`、`easytier-cli.exe`、`wintun.dll`、`Packet.dll`、`WinDivert64.sys`、
`config.toml` **一起放到新 `dist` 目录下**（和 exe 同级），首次启动会自动归位到
`resource\` 和 `config\`，无需手动整理。
