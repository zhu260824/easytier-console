# 测试脚本

## 后端自检

不需要额外依赖，直接对已部署的程序跑：

```bash
# 全量：路径、权限、设置项、开机自启、核心状态、历史库、日志、孤儿进程
easytier-console.exe --selftest full

# 单个专项
easytier-console.exe --selftest orphan     # 孤儿进程检测
easytier-console.exe --selftest settings   # 设置项读取
easytier-console.exe --selftest config     # 配置读写
easytier-console.exe --selftest autostart  # 开机自启
easytier-console.exe --selftest start      # 启动核心（需管理员）
```

## 前端测试

用 jsdom 在 Node 里跑真实前端代码，覆盖 9 个功能区共 58 项断言。

```bash
cd scripts/tests
npm install jsdom --no-save
node frontend-test.js
```

脚本会自己把 `index.html`、`app.js`、`mock-data.js` 内联成一个文档执行，
不依赖 Tauri 运行时。

### 覆盖范围

| 区块 | 内容 |
|---|---|
| 主界面 | 7 个模块卡片、表格行、节点计数、异常标签、表头排序 |
| 表格交互 | 排序三态、搜索过滤与清空、列设置面板 |
| 节点详情 | 5 个分区、本机空值语义化、关闭 |
| 延迟大图 | 曲线绘制、时间范围切换、统计块 |
| 异常明细 | 卡片、原因条目、跳转详情 |
| 拓扑图 | 节点与连线绘制、视图切换、布局切换 |
| 设置面板 | 5 个分区、6 套主题、7 个模块、7 个开关、5 个配置标签 |
| 退出确认 | 弹窗与选项 |
| 运行时错误 | 全程无异常 |

### 数据说明

`mock-data.js` 全部是占位符：

- IP 用 RFC 5737 文档示例网段（`192.0.2.0/24`、`198.51.100.0/24`）
- 主机名用 `node-a` ~ `node-f`

**请勿在提交前填回真实主机名或内网 IP。**
