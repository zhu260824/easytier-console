/* ============================================================
 * EasyTier 管理面板 —— 前端逻辑
 * ============================================================ */

const $ = (id) => document.getElementById(id);

let REFRESH_MS = 2000;
let timer = null;
let lastRunning = null;
let drawerMode = null;
let failCount = 0;          // 连续失败计数，避免偶发抖动就报失联

/**
 * 徽章是否处于「操作中」态
 *
 * 之前是靠 connBadge 上有没有 badge-busy 这个 CSS class 来判断，
 * 结果 setBadgeBusy() 加上去之后再没人移除，renderStatus() 里的
 * 守卫永远成立 → 徽章永久停在「正在开启自启…」。
 *
 * 改为显式布尔标志，由 setBadgeBusy / clearBadgeBusy 成对控制。
 */
let BADGE_BUSY = false;

/* ---------------- 工具 ---------------- */

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast ' + kind; }, 2600);
}

/* ------------------------------------------------------------
 * Loading / 忙碌态管理
 *
 * 为什么需要：
 *   启动 core 要建虚拟网卡 + 连对等节点，Rust 侧会 sleep 2.5 秒，
 *   失败还会清理重试（再 3 秒左右）。这期间界面毫无反馈，
 *   用户会以为点了没反应。
 *
 * 三层反馈：
 *   1) 按钮内联转圈（轻量操作，如刷新、打开目录）
 *   2) 全屏遮罩（重操作，如启动/停止/重启、保存配置）
 *   3) 顶部状态徽章转圈（不遮挡界面，适合轮询刷新）
 * ------------------------------------------------------------ */

/** 让某个按钮进入/退出 loading 态 */
function setBtnLoading(id, on) {
  const b = $(id);
  if (!b) return;
  if (on) {
    b.classList.add('is-loading');
    b.disabled = true;
    // 记住原始文字，但不改文字——靠 spinner 表达状态，避免布局跳动
  } else {
    b.classList.remove('is-loading');
    b.disabled = false;
  }
}

/** 显示/隐藏全屏遮罩 */
function setBusy(on, title, desc) {
  const el = $('busyOverlay');
  if (!el) return;
  if (on) {
    $('busyTitle').textContent = title || '处理中…';
    $('busyDesc').textContent = desc || '';
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

/** 顶部徽章进入「处理中」态 */
function setBadgeBusy(text) {
  const b = $('connBadge');
  if (!b) return;
  BADGE_BUSY = true;
  b.className = 'badge badge-busy';
  $('connText').textContent = text || '处理中…';
}

/** 清除徽章的「处理中」态，交回给轮询结果渲染 */
function clearBadgeBusy() {
  BADGE_BUSY = false;
}

/* ------------------------------------------------------------
 * 数据层适配：优先走 Tauri IPC，回退到 HTTP（浏览器调试用）
 *
 * Tauri 环境下 window.__TAURI_INTERNALS__ 存在，
 * 此时用 invoke 调用 Rust 命令；否则退回 fetch，
 * 方便在普通浏览器里直接调试界面。
 * ------------------------------------------------------------ */

const IS_TAURI = typeof window.__TAURI_INTERNALS__ !== 'undefined';

/** 调用 Tauri 命令 */
async function invokeCmd(cmd, args) {
  const internals = window.__TAURI_INTERNALS__;
  return internals.invoke(cmd, args || {});
}

/**
 * 统一数据入口。
 * 返回与之前 HTTP 版完全相同的 { ok, data } / { ok, message } 结构，
 * 因此上层的渲染与交互逻辑一行都不用改。
 */
async function api(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : {};

  if (IS_TAURI) {
    try {
      // ---- 查询类 ----
      if (path === '/api/status') {
        const data = await invokeCmd('get_status');
        return { ok: true, data };
      }
      if (path === '/api/meta') {
        const data = await invokeCmd('get_meta');
        return { ok: true, data };
      }
      if (path.startsWith('/api/log')) {
        const m = path.match(/lines=(\d+)/);
        const data = await invokeCmd('tail_log', { lines: m ? parseInt(m[1], 10) : 400 });
        return { ok: true, data };
      }
      if (path === '/api/config_text') {
        if (method === 'POST') {
          const message = await invokeCmd('save_config', { text: body.text });
          return { ok: true, message };
        }
        const data = await invokeCmd('read_config');
        return { ok: true, data };
      }
      // ---- 动作类 ----
      if (path === '/api/start')   return { ok: true, message: await invokeCmd('start_core') };
      if (path === '/api/stop')    return { ok: true, message: await invokeCmd('stop_core') };
      if (path === '/api/restart') return { ok: true, message: await invokeCmd('restart_core') };

      // ---- 应用设置 ----
      if (path === '/api/settings') {
        if (method === 'POST') {
          await invokeCmd('save_settings', { s: body });
          return { ok: true };
        }
        const data = await invokeCmd('get_settings');
        return { ok: true, data };
      }
      if (path === '/api/orphan_check') {
        const data = await invokeCmd('check_orphan');
        return { ok: true, data };
      }
      if (path === '/api/orphan_clean') {
        const data = await invokeCmd('cleanup_orphan');
        return { ok: true, data };
      }
      if (path === '/api/quit') {
        // 不等待返回：这个命令执行后进程就没了
        invokeCmd('quit_app', { stop: !!body.stop }).catch(() => {});
        return { ok: true };
      }

      // ---- 延迟历史 ----
      if (path.startsWith('/api/latency_history')) {
        const q = new URLSearchParams(path.split('?')[1] || '');
        const node = q.get('node') || '';
        const minutes = parseInt(q.get('minutes'), 10) || 1440;
        const data = await invokeCmd('latency_history', { node, minutes });
        return { ok: true, data };
      }

      // ---- 节点详情 ----
      if (path.startsWith('/api/peer_detail')) {
        const q = new URLSearchParams(path.split('?')[1] || '');
        const id = q.get('id') || '';
        const data = await invokeCmd('peer_detail', { id });
        return { ok: true, data };
      }

      // ---- 程序日志 ----
      if (path.startsWith('/api/app_log')) {
        const m = path.match(/lines=(\d+)/);
        const data = await invokeCmd('tail_app_log', { lines: m ? parseInt(m[1], 10) : 400 });
        return { ok: true, data };
      }

      // ---- 开机自启 ----
      if (path === '/api/autostart') {
        const message = await invokeCmd('set_autostart', { enable: !!body.enable });
        return { ok: true, message };
      }

      // ---- 打开目录 ----
      if (path === '/api/open_dir') {
        const message = await invokeCmd('open_dir');
        return { ok: true, message };
      }

      throw new Error('未知接口: ' + path);
    } catch (e) {
      // Rust 返回 Err(String) 时，此处拿到的是字符串
      throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
    }
  }

  // ---- 浏览器回退：走本地 HTTP 服务 ----
  const r = await fetch(path, opts);
  let j;
  try { j = await r.json(); } catch { throw new Error('响应不是合法 JSON'); }
  if (!r.ok && j.error) throw new Error(j.error);
  return j;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 渲染：本节点 ---------------- */

function renderNode(d) {
  const box = $('nodeBox');
  const n = d.node;

  if (!n) {
    box.innerHTML = `<div class="node-empty">${d.running ? '读取中…' : '核心未运行'}</div>`;
    $('nodeVersion').textContent = '';
    return;
  }

  const stun = n.stun_info || {};
  const listeners = (n.listeners || []).filter(u => !String(u).startsWith('ring://'));
  const proxyCidrs = n.proxy_cidrs || [];
  const peerCount = (d.peers || []).length;
  const activeCount = (d.proxies || []).length;

  const listenHtml = listeners.length
    ? `<div class="listen-list">${listeners.map(u => {
        const s = String(u);
        const mm = s.match(/^([a-z0-9]+):\/\/(.+)$/i);
        const proto = mm ? mm[1] : 'tcp';
        const addr = mm ? mm[2] : s;
        return `<span class="listen-item">
                  <span class="listen-proto">${esc(proto)}</span>${esc(addr)}
                </span>`;
      }).join('')}</div>`
    : '<span class="muted">无</span>';

  // 8 个普通项 + 1 个整行项 = 正好填满 6 列网格的两行
  const items = [
    ['虚拟 IP', `<span class="v mono">${esc(n.ipv4_addr || '-')}</span>`, ''],
    ['主机名', `<span class="v">${esc(n.hostname || '-')}</span>`, ''],
    ['Peer ID', `<span class="v mono">${esc(n.peer_id || '-')}</span>`, ''],
    ['对等节点', `<div class="mini-stats">
        <div class="mini-stat"><span class="n">${peerCount}</span><span class="l">节点</span></div>
        <div class="mini-stat"><span class="n">${proxyCidrs.length}</span><span class="l">网段</span></div>
        <div class="mini-stat"><span class="n">${activeCount}</span><span class="l">活跃</span></div>
      </div>`, ''],
    ['UDP NAT', `<span class="v">${esc(n.nat_udp_label || '—')}</span>`, ''],
    ['TCP NAT', `<span class="v">${esc(n.nat_tcp_label || '—')}</span>`, ''],
    ['公网 IP', `<span class="v mono">${esc((stun.public_ip || []).join(', ') || '-')}</span>`, ''],
    ['对外端口范围', `<span class="v mono">${
        stun.min_port && stun.max_port ? esc(stun.min_port + ' ~ ' + stun.max_port) : '—'
      }</span>`, ''],
    ['监听地址', listenHtml, 'wide'],
  ];

  box.innerHTML = items.map(([k, vHtml, cls]) => `
    <div class="node-item ${cls}">
      <div class="k">${esc(k)}</div>
      ${vHtml}
    </div>`).join('');

  $('nodeVersion').textContent = n.version ? 'v' + n.version.split('-')[0] : '';
}

/* ------------------------------------------------------------
 * 渲染：对等节点（列可配置 / 可排序 / 可搜索 / 延迟趋势）
 *
 * 设计要点：
 *   1. 列定义抽成 PEER_COLS 数组，表头与每行都从同一数组渲染，
 *      天然不会出现「表头与列错位」——这也是不用 nth-child 隐藏列的原因。
 *   2. 列顺序与显隐存 localStorage，重启保留。
 *   3. 延迟趋势用内存环形缓冲，只保留最近 30 次采样。
 *      sparkline 不做独立 Y 轴缩放：跨行同一基准，否则 1ms 抖动
 *      会和 200ms 断崖看起来一样。
 * ------------------------------------------------------------ */

/* 列定义：顺序即默认显示顺序 */
const PEER_COLS = [
  { key: 'hostname', label: '主机名',   locked: true,  align: 'left',  sortable: true },
  { key: 'ipv4',     label: '虚拟 IP',  locked: false, align: 'left',  sortable: true },
  { key: 'cost',     label: '连接方式', locked: false, align: 'left',  sortable: false },
  { key: 'lat',      label: '延迟',     locked: false, align: 'right', sortable: true },
  { key: 'loss',     label: '丢包',     locked: false, align: 'right', sortable: true },
  { key: 'ver',      label: '版本',     locked: false, align: 'left',  sortable: true },
  { key: 'tunnel',   label: '隧道',     locked: false, align: 'left',  sortable: true },
  { key: 'rx',       label: '接收',     locked: false, align: 'right', sortable: true },
  { key: 'tx',       label: '发送',     locked: false, align: 'right', sortable: true },
  { key: 'nat',      label: 'NAT 类型', locked: false, align: 'left',  sortable: true },
];

const COLS_KEY = 'easytier.peerCols';
const THEME_KEY = 'easytier.theme';
const SPARK_LEN = 30;

/* 列配置：从 localStorage 恢复，并做一次合法性校验
   （用户可能手动改过存储，或版本升级后列增减） */
function loadCols() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null'); } catch (_) {}

  const base = PEER_COLS.map(c => ({ ...c, visible: true }));
  if (!Array.isArray(saved) || !saved.length) return base;

  const byKey = {};
  base.forEach(c => { byKey[c.key] = c; });

  const out = [];
  saved.forEach(it => {
    if (!it || !it.key) return;
    const def = byKey[it.key];
    if (!def) return;                 // 已删除的列，忽略
    out.push({ ...def, visible: it.visible !== false });
    delete byKey[it.key];
  });
  // 新增的列（老配置里没有）追加到末尾
  Object.values(byKey).forEach(c => out.push({ ...c, visible: true }));

  // 锁定列必须可见
  out.forEach(c => { if (c.locked) c.visible = true; });
  return out;
}

let peerCols = loadCols();
let peerSort = { key: null, dir: 0 };   // dir: 0 无序 / 1 升 / -1 降
let peerKeyword = '';

/* 延迟历史：hostname -> [ms, ms, ...] */
const latHistory = new Map();
let lastPeers = [];

function saveCols() {
  try {
    localStorage.setItem(COLS_KEY, JSON.stringify(
      peerCols.map(c => ({ key: c.key, visible: c.visible }))
    ));
  } catch (_) {}
}

/* 把一次采样推进历史缓冲 */
function pushLatHistory(peers) {
  peers.forEach(p => {
    if (p.kind === 'local') return;
    const v = parseFloat(p.lat_ms);
    if (isNaN(v)) return;
    const k = p.hostname || p.id || '?';
    let arr = latHistory.get(k);
    if (!arr) { arr = []; latHistory.set(k, arr); }
    arr.push(v);
    if (arr.length > SPARK_LEN) arr.shift();
  });
  // 清理已消失节点，避免 Map 无限增长
  const alive = new Set(peers.map(p => p.hostname || p.id || '?'));
  for (const k of latHistory.keys()) {
    if (!alive.has(k)) latHistory.delete(k);
  }
}

/* 延迟趋势线。color 与左侧数字同色，保持语义一致 */
function sparkSVG(arr, color) {
  if (!arr || arr.length < 2) return '';
  const W = 44, H = 15, PAD = 1.5;
  let min = Math.min(...arr), max = Math.max(...arr);
  const span = Math.max(max - min, 0.01);
  const pts = arr.map((v, i) => {
    const x = PAD + (i / (arr.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = d + ` L${(W - PAD).toFixed(1)} ${H} L${PAD} ${H} Z`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" fill-opacity=".16"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function latColor(v) {
  if (isNaN(v)) return 'var(--txt-mute)';
  if (v < 15) return 'var(--green)';
  if (v < 50) return 'var(--txt-dim)';
  if (v < 150) return 'var(--orange)';
  return 'var(--red)';
}

/* 异常判定：丢包 ≥5% / 延迟 ≥150ms / 版本与本机不一致 */
function isAbnormalPeer(p, myVer) {
  if (p.kind === 'local') return false;
  // 统一走 abnormalReasons，避免「行标橙条」和「明细弹窗」
  // 两处判定漂移（比如以后改了阈值只改一处）
  return abnormalReasons(p, myVer).length > 0;
}

/* 渲染表头 */
function renderPeerHead() {
  const head = $('peerHead');
  if (!head) return;
  const vis = peerCols.filter(c => c.visible);

  head.innerHTML = '<tr>' + vis.map(c => {
    const isSorted = peerSort.key === c.key;
    const cls = [
      c.align === 'right' ? 'num' : '',
      isSorted ? 'sorted' : '',
      c.locked ? 'locked-col' : ''
    ].filter(Boolean).join(' ');

    let ico;
    if (isSorted && peerSort.dir === 1) {
      ico = '<svg viewBox="0 0 10 12"><path d="M5 1L9 7H1z"/></svg>';
    } else if (isSorted && peerSort.dir === -1) {
      ico = '<svg viewBox="0 0 10 12"><path d="M5 11L1 5h8z"/></svg>';
    } else {
      ico = '<svg viewBox="0 0 10 12"><path d="M5 1L9 6H1z" opacity=".6"/><path d="M5 11L1 6h8z" opacity=".6"/></svg>';
    }

    const click = c.sortable
      ? ` data-sort="${c.key}"`
      : '';
    const title = c.sortable ? '点击排序' : '';

    return `<th class="${cls}"${click} title="${title}">
      <span class="th-in">${esc(c.label)}<span class="sort-ico">${ico}</span></span>
    </th>`;
  }).join('') + '</tr>';
}

/* 点击表头排序 */
function onHeadClick(e) {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  if (peerSort.key === key) {
    peerSort.dir = peerSort.dir === 0 ? 1 : peerSort.dir === 1 ? -1 : 0;
    if (peerSort.dir === 0) peerSort.key = null;
  } else {
    peerSort.key = key;
    peerSort.dir = 1;
  }
  if (lastStatus) renderPeers(lastStatus);
}

/* 取排序用值 */
function sortVal(p, key) {
  switch (key) {
    case 'hostname': return p.hostname || '';
    case 'ipv4':     return p.ipv4 || '';
    case 'lat':      return parseFloat(p.lat_ms);
    case 'loss':     return parseFloat(p.loss_rate);
    case 'ver':      return (p.version || '').split('-')[0];
    case 'tunnel':   return p.tunnel_proto || '';
    case 'rx':       return p.rx_bytes || '';
    case 'tx':       return p.tx_bytes || '';
    case 'nat':      return p.nat_label || '';
    default:         return '';
  }
}

let lastStatus = null;

function renderPeers(d) {
  lastStatus = d;
  const tb = $('peerBody');
  if (!tb) return;
  const peers = d.peers || [];
  pushLatHistory(peers);

  // 本机版本，作为版本一致性基准
  const myVer = (peers.find(p => p.kind === 'local') || {}).version || '';

  $('peerCount').textContent = peers.length + ' 个';

  // 异常计数
  const abnCount = peers.filter(p => isAbnormalPeer(p, myVer)).length;
  const abnTag = $('abnormalTag');
  if (abnTag) {
    if (abnCount > 0) {
      abnTag.textContent = abnCount + ' 个异常';
      abnTag.style.display = '';
    } else {
      abnTag.style.display = 'none';
    }
  }

  renderPeerHead();
  updateColCount();

  const vis = peerCols.filter(c => c.visible);
  const colspan = Math.max(vis.length, 1);

  // 过滤 + 排序
  let rows = peers.slice();

  if (peerKeyword) {
    const kw = peerKeyword.toLowerCase();
    rows = rows.filter(p =>
      String(p.hostname || '').toLowerCase().includes(kw) ||
      String(p.ipv4 || '').includes(kw)
    );
  }

  if (peerSort.key && peerSort.dir) {
    rows.sort((a, b) => {
      // 本机永远置顶，不参与排序
      if (a.kind === 'local') return -1;
      if (b.kind === 'local') return 1;
      let va = sortVal(a, peerSort.key);
      let vb = sortVal(b, peerSort.key);
      const na = (va === undefined || va === null || va === '' || (typeof va === 'number' && isNaN(va)));
      const nb = (vb === undefined || vb === null || vb === '' || (typeof vb === 'number' && isNaN(vb)));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'number') return (va - vb) * peerSort.dir;
      return String(va).localeCompare(String(vb), 'zh') * peerSort.dir;
    });
  }

  // 空状态：区分「未运行 / 采集失败 / 搜索无结果 / 真的没节点」
  if (!rows.length) {
    let ico, title, desc, action = '';
    if (!d.running) {
      ico = '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>';
      title = '核心未运行';
      desc = '点击顶部「启动」按钮启动 EasyTier 核心';
    } else if (peerKeyword) {
      ico = '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>';
      title = '没有匹配的节点';
      desc = `没有主机名或 IP 包含「${esc(peerKeyword)}」的节点`;
      action = '<button class="btn btn-sm" data-clear-search>清空搜索</button>';
    } else if (d.peers_error) {
      ico = '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>';
      title = '采集失败';
      desc = esc(d.peers_error);
    } else {
      ico = '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>';
      title = '暂无对等节点';
      desc = '检查配置里的 [[peer]] 种子地址是否填写正确';
    }
    tb.innerHTML = `<tr><td colspan="${colspan}" class="empty-cell">
      <div class="empty-box">
        <div class="e-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round">${ico}</svg></div>
        <div class="e-title">${title}</div>
        <div class="e-desc">${desc}</div>
        ${action}
      </div>
    </td></tr>`;
    return;
  }

  tb.innerHTML = rows.map(p => {
    const isLocal = p.kind === 'local';
    const abnormal = isAbnormalPeer(p, myVer);
    const rowCls = [isLocal ? 'local-row' : '', abnormal ? 'abnormal-row' : '']
      .filter(Boolean).join(' ');

    const cells = vis.map(c => {
      switch (c.key) {
        case 'hostname':
          return `<td class="hostname">${esc(p.hostname || '—')}</td>`;

        case 'ipv4':
          return p.ipv4
            ? `<td class="mono"><span class="ip-cell" data-ip="${esc(p.ipv4)}" title="点击复制">
                 ${esc(p.ipv4)}
                 <span class="ip-copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></span>
               </span></td>`
            : '<td class="mono muted">—</td>';

        case 'cost': {
          const k = p.kind;
          const cls = k === 'p2p' ? 'cost-p2p' : k === 'relay' ? 'cost-relay' : 'cost-local';
          const label = k === 'local' ? '本机' : k === 'p2p' ? '直连' : p.cost;
          return `<td><span class="cost-cell ${cls}"><i class="cost-dot"></i>${esc(label)}</span></td>`;
        }

        case 'lat': {
          const lat = parseFloat(p.lat_ms);
          let cls = 'loss-zero', txt = p.lat_ms;
          if (!isNaN(lat)) {
            cls = lat < 15 ? 'lat-good' : lat < 50 ? 'lat-mid' : lat < 150 ? 'lat-bad' : 'lat-verybad';
            txt = lat.toFixed(2) + ' ms';
          }
          const hist = latHistory.get(p.hostname || p.id || '?');
          // sparkline 外包一层 .spark-hit 作为点击热区：
          //   · 曲线本身只有 44x15，直接点很难命中
          //   · 热区补足内边距，并带节点标识，供大图定位
          //   · 数据不足 2 点时画一条虚线占位，提示「还没采够」，
          //     否则这里完全空白，用户不知道能不能点
          const hasSpark = !isLocal && hist && hist.length >= 2;
          const sparkInner = hasSpark
            ? sparkSVG(hist, latColor(lat))
            : '<svg class="spark spark-empty" viewBox="0 0 44 15" preserveAspectRatio="none">'
              + '<path d="M2 7.5 H42" stroke="currentColor" stroke-width="1" '
              + 'stroke-dasharray="2 2" opacity=".35"/></svg>';
          const hit = isLocal ? '' :
            `<span class="spark-hit" data-host="${esc(p.hostname || '')}" data-pid="${esc(String(p.id == null ? '' : p.id))}"
               title="点击查看延迟趋势（1h / 6h / 24h）">${sparkInner}</span>`;
          return `<td class="num ${cls}">
            <span class="lat-cell">
              <span class="lat-val">${esc(txt || '—')}</span>${hit}
            </span>
          </td>`;
        }

        case 'loss': {
          const loss = parseFloat(p.loss_rate);
          let cls = 'loss-zero', txt = p.loss_rate;
          if (!isNaN(loss)) {
            cls = loss === 0 ? 'loss-zero' : loss < 5 ? 'loss-bad' : 'loss-worse';
            txt = loss.toFixed(1) + '%';
          }
          return `<td class="num ${cls}">${esc(txt || '—')}</td>`;
        }

        case 'ver': {
          const full = p.version || '';
          const short = full ? full.split('-')[0] : '';
          const diff = !!(myVer && full && full !== myVer && !isLocal);
          const tip = full
            ? `完整版本: ${full}${diff ? '\n与本机(' + myVer + ')不一致，可能影响互通' : ''}`
            : '该节点未上报版本';
          return `<td>${short
            ? `<span class="ver${diff ? ' ver-diff' : ''}" title="${esc(tip)}">${esc(short)}${diff ? ' ⚠' : ''}</span>`
            : '<span class="muted">—</span>'}</td>`;
        }

        case 'tunnel':
          return `<td>${p.tunnel_proto ? `<span class="proto">${esc(p.tunnel_proto)}</span>` : '—'}</td>`;

        case 'rx':
          return `<td class="num muted small">${esc(p.rx_bytes || '—')}</td>`;

        case 'tx':
          return `<td class="num muted small">${esc(p.tx_bytes || '—')}</td>`;

        case 'nat':
          return `<td class="small">${esc(p.nat_label || '—')}</td>`;

        default:
          return '<td>—</td>';
      }
    }).join('');

    // data-host / data-pid 供点击行打开详情用；
    // 本机也带上，点开能看到本机完整信息（版本、NAT、监听等）
    const pid = p.id == null ? '' : String(p.id);
    return `<tr class="${rowCls} row-click" data-host="${esc(p.hostname || '')}" data-pid="${esc(pid)}">${cells}</tr>`;
  }).join('');
}

/* ---------------- 列设置面板 ---------------- */

function updateColCount() {
  const el = $('colCount');
  if (!el) return;
  const vis = peerCols.filter(c => c.visible).length;
  el.textContent = vis === peerCols.length ? '' : `${vis}/${peerCols.length}`;
}

/* ---------------- 列设置面板 ----------------
 *
 * 拖拽为什么不用 HTML5 原生 draggable：
 *   原生 draggable 与点击事件冲突严重——按下就进入拖拽态，
 *   勾选框的 click 经常收不到，用户感觉「点不动、要点好几下」。
 *   而且 webview2 里原生拖拽的 ghost image 表现也不稳定。
 *
 *   改用 pointer 事件手写：
 *     · 只有按住左侧手柄（或整行拖动超过 4px）才进入拖拽
 *     · 位移未超过阈值就当普通点击，勾选照常响应
 *     · 拖拽时用 transform 跟手，并实时计算插入位置
 * ------------------------------------------ */

function renderColList() {
  const box = $('colList');
  if (!box) return;
  box.innerHTML = peerCols.map((c, i) => `
    <div class="col-item ${c.visible ? 'check' : ''}" data-idx="${i}">
      <span class="grip" data-grip>⣿</span>
      <span class="cb" data-toggle>${c.visible
        ? '<svg viewBox="0 0 10 10"><path d="M2 5l2.4 2.4L8 3" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : ''}</span>
      <span class="name" data-toggle>${esc(c.label)}</span>
      ${c.locked
        ? '<span class="lock">锁定</span>'
        : (c.visible ? '' : '<span class="hide-tip">已隐藏</span>')}
    </div>
  `).join('');
}

/* 拖拽状态 */
let colDrag = null;
let justDragged = false;   // 刚完成拖拽，抑制紧随其后的 click

function initColPanel() {
  const btn = $('btnCol');
  const panel = $('colPanel');
  const list = $('colList');
  if (!btn || !panel || !list) return;

  const setOpen = (on) => {
    panel.classList.toggle('open', on);
    btn.classList.toggle('on', on);
    if (on) renderColList();
    else if (colDrag) endColDrag();
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!panel.classList.contains('open'));
  });

  /* ---------- 点击勾选 ---------- */
  list.addEventListener('click', (e) => {
    // 刚拖拽结束的那一下不要触发勾选
    if (justDragged) return;
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    const item = t.closest('.col-item');
    if (!item) return;
    const c = peerCols[+item.dataset.idx];
    if (!c || c.locked) return;

    c.visible = !c.visible;
    saveCols();
    renderColList();
    renderPeers(lastStatus || {});
  });

  /* ---------- pointer 拖拽 ---------- */
  const DRAG_THRESHOLD = 4;   // 位移超过 4px 才算拖拽

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const item = e.target.closest('.col-item');
    if (!item) return;

    const idx = +item.dataset.idx;
    const rect = item.getBoundingClientRect();

    colDrag = {
      idx,
      startY: e.clientY,
      startX: e.clientX,
      itemH: rect.height,
      listRect: list.getBoundingClientRect(),
      moved: false,
      item,
      pointerId: e.pointerId,
      // 记录所有 item 的初始位置，用于计算插入点
      slots: Array.from(list.querySelectorAll('.col-item')).map(el => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height, idx: +el.dataset.idx };
      }),
      targetIdx: idx,
    };
  });

  list.addEventListener('pointermove', (e) => {
    if (!colDrag || e.pointerId !== colDrag.pointerId) return;

    const dy = e.clientY - colDrag.startY;
    const dx = e.clientX - colDrag.startX;

    if (!colDrag.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD && Math.abs(dx) < DRAG_THRESHOLD) return;
      colDrag.moved = true;
      colDrag.item.classList.add('dragging');
      list.setPointerCapture(e.pointerId);
      list.classList.add('dragging-active');
    }

    // 跟手位移
    colDrag.item.style.transform = `translateY(${dy}px)`;

    // 计算当前应在哪个位置
    const pointerY = e.clientY;
    let target = 0;
    for (const s of colDrag.slots) {
      const center = s.top + s.height / 2;
      if (pointerY > center) target++;
    }
    target = Math.max(0, Math.min(colDrag.slots.length - 1, target));
    if (target !== colDrag.targetIdx) {
      colDrag.targetIdx = target;
      // 用其它行的位移做视觉提示
      list.querySelectorAll('.col-item').forEach(el => {
        if (el === colDrag.item) return;
        const i = +el.dataset.idx;
        const from = i;
        const to = target <= colDrag.idx
          ? (from >= target && from < colDrag.idx ? from + 1 : from)
          : (from > colDrag.idx && from <= target ? from - 1 : from);
        const shift = to - from;
        el.style.transform = shift ? `translateY(${shift * colDrag.itemH}px)` : '';
      });
    }
  });

  const finish = (e) => {
    if (!colDrag) return;
    const d = colDrag;
    const from = d.idx;
    const to = d.targetIdx;
    const moved = d.moved;
    endColDrag();

    if (!moved || from === to) return;
    // 执行重排
    const [m] = peerCols.splice(from, 1);
    peerCols.splice(to, 0, m);
    saveCols();
    renderColList();
    renderPeers(lastStatus || {});
  };

  list.addEventListener('pointerup', finish);
  list.addEventListener('pointercancel', () => endColDrag());

  function endColDrag() {
    if (!colDrag) return;
    const wasMoved = colDrag.moved;
    colDrag.item.classList.remove('dragging');
    colDrag.item.style.transform = '';
    list.querySelectorAll('.col-item').forEach(el => { el.style.transform = ''; });
    list.classList.remove('dragging-active');
    colDrag = null;

    // 拖拽刚结束，抑制接下来的 click（避免误勾选）
    if (wasMoved) {
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 80);
    }
  }

  /* ---------- 恢复默认 ---------- */
  const reset = $('btnColReset');
  if (reset) {
    reset.addEventListener('click', () => {
      peerCols = PEER_COLS.map(c => ({ ...c, visible: true }));
      peerSort = { key: null, dir: 0 };
      saveCols();
      renderColList();
      renderPeers(lastStatus || {});
      toast('已恢复默认列设置');
    });
  }

  /* ---------- 关闭 ---------- */
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
  });
}

/* ---------------- 搜索 ---------------- */

function initPeerSearch() {
  const inp = $('searchInput');
  const box = $('searchBox');
  const clr = $('btnSearchClear');
  if (!inp) return;

  inp.addEventListener('input', () => {
    peerKeyword = inp.value.trim();
    box.classList.toggle('has-val', !!inp.value);
    renderPeers(lastStatus || {});
  });

  const clear = () => {
    inp.value = '';
    peerKeyword = '';
    box.classList.remove('has-val');
    renderPeers(lastStatus || {});
    inp.focus();
  };

  if (clr) clr.addEventListener('click', clear);

  // 空状态里的「清空搜索」按钮
  const tb = $('peerBody');
  if (tb) {
    tb.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-search]')) clear();
    });
  }
}

/* ---------------- IP 复制 ---------------- */

function initPeerTable() {
  const tb = $('peerBody');
  const head = $('peerHead');
  if (head) head.addEventListener('click', onHeadClick);
  if (!tb) return;

  tb.addEventListener('click', async (e) => {
    // 1) 点击延迟列的 sparkline → 打开趋势大图
    //    必须放在行点击之前判断，否则会被行点击抢走
    const spark = e.target.closest('.spark-hit');
    if (spark) {
      e.stopPropagation();
      const sHost = spark.dataset.host || '';
      const sId = spark.dataset.pid || '';
      openLatencyChart(sId || sHost, sHost || sId);
      return;
    }

    // 2) 点击 IP 单元格 → 复制（原有行为，不触发行详情）
    const cell = e.target.closest('.ip-cell');
    if (cell) {
      const ip = cell.dataset.ip;
      if (!ip) return;
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(ip);
        const old = cell.innerHTML;
        cell.innerHTML = '<span style="color:var(--green);font-weight:600">已复制</span>';
        setTimeout(() => { cell.innerHTML = old; }, 1000);
      } catch (_) {
        toast('复制失败，请手动选择', 'err');
      }
      return;
    }

    // 3) 点击行任意其他位置 → 打开节点详情
    const tr = e.target.closest('tr[data-host]');
    if (!tr) return;
    // 空状态行没有 data-host，自然不会命中
    openNodeDetail(tr.dataset.pid || tr.dataset.host);
  });
}

/* ---------------- 应用设置与退出确认 ----------------
 *
 * 背景：core 用 DETACHED_PROCESS 启动，与面板完全脱离。
 * 好处是面板崩溃不影响组网，代价是「关面板」不会停核心。
 *
 * 用户遇到的实际问题：
 *   面板被强杀后 core 成了孤儿，一直占着 easytier-core.exe
 *   和 wintun.dll，覆盖升级时报「文件使用中」。
 *
 * 解决分两层：
 *   1. 设置开关：让用户能选「关面板就停核心」
 *   2. 启动清理：无论上次怎么退出的，下次启动都会清掉孤儿
 * ---------------------------------------------- */

let APP_SETTINGS = {
  stop_core_on_exit: false,
  confirm_on_exit: true,
  cleanup_orphan: true,
  minimize_to_tray: true,
  autostart: false,
  autostart_core: false,
  start_minimized: true,
};

const SETTINGS_KEY = 'easytier.settings';

/** 读取设置：优先后端，失败回退 localStorage */
async function loadSettings() {
  try {
    const j = await api('/api/settings');
    if (j.ok && j.data) {
      APP_SETTINGS = { ...APP_SETTINGS, ...j.data };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(APP_SETTINGS)); } catch (_) {}
      return APP_SETTINGS;
    }
  } catch (_) { /* 回退 */ }

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) APP_SETTINGS = { ...APP_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {}
  return APP_SETTINGS;
}

/** 保存设置：写后端 + 本地缓存 */
async function saveAppSettings(patch) {
  Object.assign(APP_SETTINGS, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(APP_SETTINGS)); } catch (_) {}
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(APP_SETTINGS) });
  } catch (e) {
    toast('设置保存失败: ' + e.message, 'err');
  }
}

/* ---------- 退出确认弹窗 ---------- */

let exitChoice = null;

function openExitConfirm() {
  const m = $('exitModal');
  if (!m) return;
  exitChoice = null;

  // 清空选中态
  m.querySelectorAll('.confirm-opt').forEach(el => el.classList.remove('on'));
  const rem = $('chkExitRemember');
  if (rem) rem.checked = false;

  // 如果检测到孤儿核心，顺便提示
  const tip = $('exitOrphanTip');
  if (tip) {
    api('/api/orphan_check').then(j => {
      if (j.ok && j.data && (j.data.orphans || []).length) {
        tip.textContent = `注意：检测到 ${j.data.orphans.length} 个残留的核心进程（父进程已退出），它们会继续占用文件。建议先停止核心。`;
        tip.style.display = '';
      } else {
        tip.style.display = 'none';
      }
    }).catch(() => { tip.style.display = 'none'; });
  }

  m.classList.add('open');
}

function closeExitConfirm() {
  const m = $('exitModal');
  if (m) m.classList.remove('open');
  exitChoice = null;
}

async function doExit(stop) {
  closeExitConfirm();
  try {
    await api('/api/quit', { method: 'POST', body: JSON.stringify({ stop: !!stop }) });
  } catch (_) {
    // 进程已退出，请求会中断，属正常
  }
}

function initExitConfirm() {
  const m = $('exitModal');
  if (!m) return;

  // 选项点击
  m.querySelectorAll('.confirm-opt').forEach(el => {
    el.addEventListener('click', () => {
      m.querySelectorAll('.confirm-opt').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      exitChoice = el.dataset.act;

      // 记住选择 → 勾选后立刻落盘对应设置
      const rem = $('chkExitRemember');
      if (rem && rem.checked) {
        saveAppSettings({
          confirm_on_exit: false,
          stop_core_on_exit: exitChoice === 'stop',
        });
      }
      // 选完直接执行（少一次点击）
      setTimeout(() => doExit(exitChoice === 'stop'), 120);
    });
  });

  const cancel = $('btnExitCancel');
  if (cancel) cancel.addEventListener('click', closeExitConfirm);

  // 点遮罩关闭
  m.addEventListener('click', e => {
    if (e.target === m) closeExitConfirm();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && m.classList.contains('open')) closeExitConfirm();
  });
}

/* ---------- 监听后端发来的退出询问 ---------- */

async function listenExitRequest() {
  if (!IS_TAURI) return;
  try {
    const { listen } = window.__TAURI_INTERNALS__;
    if (!listen) return;
    await listen('ask-exit', () => {
      openExitConfirm();
    });
  } catch (_) {
    // 旧版 Tauri 或不支持时静默降级
  }
}

/* ---------- 孤儿核心清理（手动触发）---------- */

async function runOrphanCleanup(silent) {
  try {
    const j = await api('/api/orphan_clean');
    if (!j.ok) throw new Error('清理失败');
    const n = (j.data.killed || []).length;
    if (n > 0) {
      toast(`已清理 ${n} 个残留核心进程`, 'ok');
    } else if (!silent) {
      toast('没有发现残留进程');
    }
    return n;
  } catch (e) {
    if (!silent) toast('清理失败: ' + e.message, 'err');
    return 0;
  }
}

function renderProxy(d) {
  const box = $('proxyBox');
  const n = d.node;
  const cidrs = (n && n.proxy_cidrs) || [];
  const proxies = d.proxies || [];
  const peers = d.peers || [];

  $('proxyCount').textContent = cidrs.length + ' 项';

  if (!cidrs.length) {
    box.innerHTML = '<div class="empty-hint">未配置子网代理</div>';
    $('proxyActive').textContent = '0 条活跃';
    $('proxyActive').className = 'tag tag-accent idle';
    return;
  }

  // 统计每个网段的活跃连接数
  const activeByCidr = {};
  proxies.forEach(p => {
    const dm = String(p.dst || '').match(/^(\d+\.\d+\.\d+)\.\d+/);
    if (!dm) return;
    const dprefix = dm[1];
    cidrs.forEach(c => {
      const cprefix = c.split('/')[0].split('.').slice(0, 3).join('.');
      if (cprefix === dprefix) activeByCidr[c] = (activeByCidr[c] || 0) + 1;
    });
  });

  const totalActive = proxies.length;
  $('proxyActive').textContent = totalActive + ' 条活跃';
  $('proxyActive').className = 'tag tag-accent' + (totalActive ? '' : ' idle');

  // 本机接口列表（用于展示"该网段对应的本机地址"）
  const ifaces = (n.ip_list || {}).interface_ipv4s || [];
  const ifaceAddrs = ifaces.map(x => {
    const a = x.addr;
    return [ (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255 ].join('.');
  }).filter(ip => !ip.startsWith('169.254'));

  box.innerHTML = `<div class="proxy-grid">${cidrs.map(c => {
    const act = activeByCidr[c] || 0;
    const cprefix = c.split('/')[0].split('.').slice(0, 3).join('.');
    // 找出该网段对应的本机地址
    const localIp = ifaceAddrs.find(ip => ip.split('.').slice(0, 3).join('.') === cprefix) || '';
    // 访问入口：优先用本机在该网段的地址，否则用本节点虚拟 IP
    // （原来这里写死了一个固定 IP，换台机器就显示错误，已修掉）
    const nodeVirtIp = (n && n.ipv4 || '').split('/')[0];
    const accessEntry = localIp || nodeVirtIp || '—';

    return `<div class="proxy-card">
      <div class="proxy-card-top">
        <span class="proxy-cidr">${esc(c)}</span>
        <span class="conn-badge ${act > 0 ? 'conn-live' : 'conn-idle'}">
          ${act > 0 ? act + ' 条连接' : '待连接'}
        </span>
      </div>
      <div class="proxy-rows">
        <div class="proxy-row">
          <span class="rk">允许协议</span>
          <span class="rv">
            <span class="allow-chip on">tcp</span>
            <span class="allow-chip on">udp</span>
            <span class="allow-chip on">icmp</span>
          </span>
        </div>
        ${localIp ? `<div class="proxy-row">
          <span class="rk">本机地址</span>
          <span class="rv mono" style="color:#93c5fd">${esc(localIp)}</span>
        </div>` : ''}
        <div class="proxy-row">
          <span class="rk">访问入口</span>
          <span class="rv mono" style="color:#93c5fd">${esc(accessEntry)}</span>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* ---------------- 渲染：端口转发 ---------------- */

function renderForwards(d) {
  const box = $('fwdBox');
  const fwds = d.forwards || [];
  const proxies = d.proxies || [];

  $('fwdCount').textContent = fwds.length + ' 条';

  if (!fwds.length) {
    box.innerHTML = '<div class="empty-hint">未配置端口转发</div>';
    $('fwdActive').textContent = '0 条活跃';
    $('fwdActive').className = 'tag tag-accent idle';
    return;
  }

  // 统计每条转发规则的活跃连接数（按目标端口匹配）
  const activeByRule = {};
  fwds.forEach(f => {
    const pm = String(f.dst).match(/:(\d+)$/);
    const port = pm ? pm[1] : null;
    if (!port) return;
    activeByRule[f.bind + '>' + f.dst] = proxies.filter(p => {
      const dm = String(p.dst).match(/:(\d+)$/);
      return dm && dm[1] === port;
    }).length;
  });

  const totalActive = Object.values(activeByRule).reduce((a, b) => a + b, 0);
  $('fwdActive').textContent = totalActive + ' 条活跃';
  $('fwdActive').className = 'tag tag-accent' + (totalActive ? '' : ' idle');

  box.innerHTML = `<div class="fwd-grid">${fwds.map(f => {
    const note = guessNote(f.dst);
    const act = activeByRule[f.bind + '>' + f.dst] || 0;
    return `<div class="fwd-card">
      <div class="fwd-card-top">
        <span class="fwd-proto">${esc(f.proto)}</span>
        <span class="conn-badge ${act > 0 ? 'conn-live' : 'conn-idle'}">
          ${act > 0 ? act + ' 条连接' : '待连接'}
        </span>
        ${note ? `<span class="fwd-note">${esc(note)}</span>` : ''}
      </div>
      <div class="fwd-flow">
        <span class="fwd-addr">${esc(f.bind)}</span>
        <span class="fwd-arrow">→</span>
        <span class="fwd-addr fwd-dst">${esc(f.dst)}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function guessNote(addr) {
  const m = String(addr).match(/:(\d+)$/);
  if (!m) return '';
  const map = {
    3389: '远程桌面', 22: 'SSH', 445: 'SMB 共享', 139: 'SMB 共享',
    80: 'HTTP', 443: 'HTTPS', 5900: 'VNC', 21: 'FTP', 8080: 'HTTP',
    3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 1433: 'SQL Server',
    1521: 'Oracle', 27017: 'MongoDB', 9200: 'Elasticsearch',
  };
  return map[parseInt(m[1], 10)] || '';
}

/* ---------------- 渲染：活跃连接 ---------------- */

function renderActive(d) {
  const tb = $('activeBody');
  const list = d.proxies || [];
  $('activeCount').textContent = list.length + ' 条';

  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">暂无活跃连接</td></tr>';
    return;
  }

  tb.innerHTML = list.map(p => {
    const ok = String(p.state).toLowerCase() === 'connected';
    // 判断属于哪条规则：目标端口匹配端口转发，或目标网段匹配子网代理
    let rule = '<span class="muted">—</span>';
    const dm = String(p.dst).match(/:(\d+)$/);
    if (dm) {
      const f = (d.forwards || []).find(x => String(x.dst).match(/:(\d+)$/) && x.dst.endsWith(':' + dm[1]));
      if (f) rule = '<span style="color:#93c5fd">端口转发</span>';
    }
    if (rule === '<span class="muted">—</span>') {
      const dprefix = String(p.dst).match(/^(\d+\.\d+\.\d+)\.\d+/);
      if (dprefix) {
        const hit = ((d.node || {}).proxy_cidrs || []).some(c =>
          c.split('/')[0].split('.').slice(0, 3).join('.') === dprefix[1]);
        if (hit) rule = '<span style="color:#a3e635">子网代理</span>';
      }
    }
    return `<tr>
      <td class="mono">${esc(p.src)}</td>
      <td class="muted">→</td>
      <td class="mono" style="color:#93c5fd">${esc(p.dst)}</td>
      <td><span class="proto">${esc(p.transport)}</span></td>
      <td><span class="state-dot ${ok ? 'state-ok' : 'state-idle'}">${esc(p.state)}</span></td>
      <td class="small">${rule}</td>
      <td class="muted small">${esc(p.start)}</td>
    </tr>`;
  }).join('');
}

/* ---------------- 渲染：路由表 ---------------- */

function renderRoutes(d) {
  const tb = $('routeBody');
  const routes = d.routes || [];
  $('routeCount').textContent = routes.length + ' 条';

  if (!routes.length) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">${
      d.running ? (d.routes_error ? '采集失败: ' + esc(d.routes_error) : '暂无路由') : '核心未运行'
    }</td></tr>`;
    return;
  }

  tb.innerHTML = routes.map(r => {
    const hopCls = r.path_len === 0 ? 'hop-0' : r.path_len === 1 ? 'hop-1' : 'hop-n';
    const hopTxt = r.path_len === 0 ? '本机' : r.path_len + ' 跳';
    // proxy_cidrs 有两种来源形态：
    //   后端已格式化为数组 ["a/24","b/23"]
    //   原始 CLI 给的是逗号分隔字符串 "a/24, b/23"
    // 之前的 (x || []).length + x.map() 在字符串上会成立 length
    // 但没有 map 方法，直接 TypeError，导致后续 renderTopo 被跳过、
    // 拓扑整块空白。这里统一归一化为数组再渲染。
    const cidrList = Array.isArray(r.proxy_cidrs)
      ? r.proxy_cidrs
      : (typeof r.proxy_cidrs === 'string' && r.proxy_cidrs.trim()
          ? r.proxy_cidrs.split(',').map(s => s.trim()).filter(Boolean)
          : []);
    const cidrs = cidrList.length
      ? `<div class="route-cidrs">${cidrList.map(c => `<span class="route-cidr">${esc(c)}</span>`).join('')}</div>`
      : '<span class="muted">—</span>';
    const nextHop = r.is_local ? '<span class="muted">本机</span>'
                   : r.is_direct ? '<span style="color:#22c55e">直连</span>'
                   : esc(r.next_hop || '—');
    return `<tr>
      <td class="hostname">${esc(r.hostname || '—')}</td>
      <td class="mono">${esc(r.ipv4 || '—')}</td>
      <td class="num"><span class="hop-badge ${hopCls}">${esc(hopTxt)}</span></td>
      <td class="num small">${r.path_latency ? esc(r.path_latency + ' ms') : '—'}</td>
      <td class="small">${nextHop}</td>
      <td>${cidrs}</td>
    </tr>`;
  }).join('');
}

/* ---------------- 总渲染 ---------------- */

/* ============================================================
 * 模块管理（S3 需求4）
 * 页面模块的显隐 / 排序 / 改名
 * ============================================================ */

const MODULES = [
  { id: 'node',     def: '本节点',       on: true  },
  { id: 'peers',    def: '对等节点',     on: true  },
  { id: 'topo',     def: '网络拓扑',     on: true  },
  { id: 'proxy',    def: '子网代理',     on: true  },
  { id: 'routes',   def: '路由表',       on: false },
  { id: 'forwards', def: '端口转发',     on: true  },
  { id: 'active',   def: '活跃转发连接', on: true  },
];

const MOD_KEY = 'easytier.modules';
let modCfg = [];

function loadModules() {
  const base = MODULES.map(m => ({ ...m, custom: '' }));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(MOD_KEY) || 'null'); } catch (_) {}
  if (!Array.isArray(saved) || !saved.length) { modCfg = base; return; }

  const byId = {};
  base.forEach(m => { byId[m.id] = m; });
  const out = [];
  saved.forEach(it => {
    if (!it || !it.id) return;
    const def = byId[it.id];
    if (!def) return;
    out.push({ ...def, on: it.on !== false, custom: it.custom || '' });
    delete byId[it.id];
  });
  // 新增的模块（老配置里没有）追加到末尾
  Object.values(byId).forEach(m => out.push(m));
  modCfg = out;
}

function saveModules() {
  try {
    localStorage.setItem(MOD_KEY, JSON.stringify(
      modCfg.map(m => ({ id: m.id, on: m.on, custom: m.custom || '' }))
    ));
  } catch (_) {}
}

/** 把配置应用到页面：改名 + 显隐 + 重排（不重建 DOM） */
function applyModules() {
  const container = $('moduleContainer');
  if (!container) return;
  const cards = {};
  container.querySelectorAll('[data-mod]').forEach(c => { cards[c.dataset.mod] = c; });

  modCfg.forEach(m => {
    const card = cards[m.id];
    if (!card) return;
    const h2 = card.querySelector('.card-head h2');
    if (h2) {
      const nm = (m.custom && m.custom.trim()) || m.def;
      if (h2.textContent !== nm) h2.textContent = nm;
    }
    card.classList.toggle('hide', !m.on);
    // 用 appendChild 移动节点而非重建，保留表格滚动位置与 sparkline
    container.appendChild(card);
  });

  // 拓扑图在显隐变化后需要重算尺寸
  if (cards.topo && !cards.topo.classList.contains('hide')) {
    requestAnimationFrame(() => renderTopo());
  }
}

/* ---------------- 页面设置列表 UI ---------------- */

let modDragFrom = null;

function renderModList() {
  const box = $('modList');
  if (!box) return;

  box.innerHTML = modCfg.map((m, i) => `
    <div class="mod-item ${m.on ? 'on' : 'off'}" data-i="${i}" draggable="true">
      <span class="grip">⣿</span>
      <span class="mod-cb" data-tog="${i}">
        <svg viewBox="0 0 10 10"><path d="M2 5l2.4 2.4L8 3"/></svg>
      </span>
      <span class="mod-name">${esc(m.def)}</span>
      <input class="mod-input" data-name="${i}" value="${esc(m.custom)}"
             placeholder="${esc(m.def)}" maxlength="16">
      <button class="mod-reset" data-reset="${i}" title="恢复默认名称">
        <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>`).join('');

  // 勾选
  box.querySelectorAll('[data-tog]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const i = +el.dataset.tog;
      // 至少保留一个可见
      if (modCfg[i].on && modCfg.filter(m => m.on).length === 1) {
        toast('至少保留一个模块可见', 'err');
        return;
      }
      modCfg[i].on = !modCfg[i].on;
      saveModules();
      renderModList();
      applyModules();
    });
  });

  // 重置名称
  box.querySelectorAll('[data-reset]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      modCfg[+el.dataset.reset].custom = '';
      saveModules();
      renderModList();
      applyModules();
    });
  });

  // 改名（输入即生效）
  box.querySelectorAll('[data-name]').forEach(el => {
    el.addEventListener('input', () => {
      modCfg[+el.dataset.name].custom = el.value.trim();
      saveModules();
      applyModules();
    });
  });

  // 拖拽排序
  box.querySelectorAll('.mod-item').forEach(el => {
    el.addEventListener('dragstart', e => {
      modDragFrom = +el.dataset.i;
      el.classList.add('drag');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(modDragFrom)); } catch (_) {}
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      const to = +el.dataset.i;
      if (modDragFrom === null || modDragFrom === to) return;
      const [m] = modCfg.splice(modDragFrom, 1);
      modCfg.splice(to, 0, m);
      modDragFrom = null;
      saveModules();
      renderModList();
      applyModules();
    });
    el.addEventListener('dragend', () => {
      modDragFrom = null;
      el.classList.remove('drag');
    });
  });
}

/* ============================================================
 * 网络拓扑图（S5 需求）
 *
 * 数据源：get_status 里的 peers（含 kind: local/p2p/relay）
 * 全互联关系由 peer-center 提供，这里降级为「所有非本机节点互连」
 * 的近似（真实项目里应从 peer-center 的 direct_peers 取）。
 * ============================================================ */

let topoView = 'star';
let topoLayout = 'circle';
let topoManual = {};     // 拖动后的坐标覆盖
let topoPeers = [];

/** 布局计算：返回 {idx: {x,y}} */
function computeTopoPos(W, H, peers) {
  const pos = {};
  const cx = W / 2, cy = H / 2;
  pos[0] = topoManual[0] || { x: cx, y: cy };

  const others = peers.map((p, i) => ({ p, i })).filter(o => o.p.kind !== 'local');
  if (!others.length) return pos;

  if (topoLayout === 'radial') {
    // 分层：直连在内环，中转在外环
    const inner = others.filter(o => o.p.kind === 'p2p')
      .sort((a, b) => (parseFloat(a.p.lat_ms) || 99) - (parseFloat(b.p.lat_ms) || 99));
    const outer = others.filter(o => o.p.kind !== 'p2p');
    placeRing(inner, Math.min(W, H) * 0.30, cx, cy, -Math.PI / 2, pos);
    placeRing(outer, Math.min(W, H) * 0.44, cx, cy, -Math.PI / 2 + 0.4, pos);
  } else {
    // 平铺环形
    placeRing(others, Math.min(W, H) * 0.37, cx, cy, -Math.PI / 2, pos);
  }

  Object.keys(topoManual).forEach(k => { pos[k] = topoManual[k]; });
  return pos;
}

function placeRing(items, R, cx, cy, start, pos) {
  const n = items.length;
  if (!n) return;
  if (n === 1) {
    pos[items[0].i] = topoManual[items[0].i] || { x: cx, y: cy - R };
    return;
  }
  items.forEach((o, k) => {
    const ang = start + (k / n) * Math.PI * 2;
    pos[o.i] = topoManual[o.i] || {
      x: cx + Math.cos(ang) * R,
      y: cy + Math.sin(ang) * R * 0.94,
    };
  });
}

function topoLatColor(v) {
  if (isNaN(v)) return 'var(--txt-mute)';
  if (v < 10) return 'var(--green)';
  if (v < 50) return 'var(--txt)';
  if (v < 150) return 'var(--orange)';
  return 'var(--red)';
}

function topoEdgeWidth(v) {
  if (isNaN(v)) return 1.4;
  if (v < 10) return 2.8;
  if (v < 50) return 2;
  return 1.3;
}

/** 主渲染 */
function renderTopo() {
  const svg = $('topoSvg');
  const canvas = $('topoCanvas');
  if (!svg || !canvas) return;

  const peers = topoPeers;
  const empty = $('topoEmpty');

  if (!peers.length) {
    svg.innerHTML = '';
    if (empty) empty.style.display = '';
    $('topoNodeCount').textContent = '0 节点';
    $('topoEdgeCount').textContent = '0 连接';
    return;
  }
  if (empty) empty.style.display = 'none';

  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 400;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pos = computeTopoPos(W, H, peers);

  // 连线
  let edges = [];
  if (topoView === 'star') {
    peers.forEach((p, i) => { if (i !== 0) edges.push({ a: 0, b: i }); });
  } else {
    for (let i = 0; i < peers.length; i++)
      for (let j = i + 1; j < peers.length; j++)
        edges.push({ a: i, b: j });
  }

  const edgeHtml = edges.map((e, k) => {
    const A = pos[e.a], B = pos[e.b];
    if (!A || !B) return '';
    const pa = peers[e.a], pb = peers[e.b];
    const lat = parseFloat(pa.lat_ms) || parseFloat(pb.lat_ms);
    const isRelay = pa.kind === 'relay' || pb.kind === 'relay';
    const col = isRelay ? 'var(--orange)' : 'var(--green)';
    const w = topoView === 'mesh' ? Math.max(1, topoEdgeWidth(lat) * 0.6) : topoEdgeWidth(lat);
    const op = topoView === 'mesh' ? 0.18 : 0.7;
    const dx = B.x - A.x, dy = B.y - A.y;
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const cqx = mx - dy * 0.045, cqy = my + dx * 0.045;
    return `<path class="topo-edge" data-e="${k}" data-a="${e.a}" data-b="${e.b}"
      d="M${A.x.toFixed(1)} ${A.y.toFixed(1)} Q${cqx.toFixed(1)} ${cqy.toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}"
      fill="none" stroke="${col}" stroke-width="${w}"
      ${isRelay ? 'stroke-dasharray="5 4"' : ''} opacity="${op}" stroke-linecap="round"/>`;
  }).join('');

  // 中心装饰环
  const c0 = pos[0] || { x: W / 2, y: H / 2 };
  const ringHtml = `
    <circle class="topo-ring pulse" cx="${c0.x}" cy="${c0.y}" r="26"/>
    <circle class="topo-ring" cx="${c0.x}" cy="${c0.y}" r="44" stroke-dasharray="2 6" opacity=".25"/>`;

  // 节点
  const showLat = $('cbTopoLat') && $('cbTopoLat').checked;
  const showTr = $('cbTopoTraffic') && $('cbTopoTraffic').checked;
  const myVer = (peers.find(p => p.kind === 'local') || {}).version || '';

  const nodeHtml = peers.map((p, i) => {
    const P = pos[i];
    if (!P) return '';
    const isLocal = p.kind === 'local';
    const lat = parseFloat(p.lat_ms);
    const loss = parseFloat(p.loss_rate);
    const abn = !isLocal && (
      (!isNaN(loss) && loss >= 5) ||
      (!isNaN(lat) && lat >= 150) ||
      (myVer && p.version && p.version !== myVer)
    );
    const r = isLocal ? 23 : 16;
    const col = isLocal ? 'var(--brand)' : (abn ? 'var(--orange)' : 'var(--green)');
    const nm = String(p.hostname || '').length > 11
      ? String(p.hostname).slice(0, 10) + '…'
      : (p.hostname || '—');

    let line2 = '', line3 = '';
    if (showLat && !isNaN(lat)) {
      line2 = `<text class="topo-lat" x="0" y="${r + 14}" text-anchor="middle"
        fill="${topoLatColor(lat)}" font-size="9.5"
        font-family="Consolas,monospace" font-weight="600">${lat.toFixed(2)}ms</text>`;
    } else if (isLocal) {
      line2 = `<text class="topo-lat" x="0" y="${r + 14}" text-anchor="middle"
        fill="var(--brand)" font-size="9" font-weight="600">本机</text>`;
    }
    if (showTr && !isLocal && p.rx) {
      line3 = `<text class="topo-lat" x="0" y="${r + 25}" text-anchor="middle"
        fill="var(--txt-mute)" font-size="8"
        font-family="Consolas,monospace">↧${esc(p.rx)}</text>`;
    }

    return `<g class="topo-node" data-n="${i}" transform="translate(${P.x.toFixed(1)},${P.y.toFixed(1)})">
      <circle class="topo-halo" r="${r}" fill="${col}" fill-opacity=".14"
        stroke="${col}" stroke-width="${isLocal ? 2.4 : 1.8}"/>
      <circle r="${isLocal ? 7 : 5}" fill="${col}"/>
      ${abn ? `<circle r="${r + 4}" fill="none" stroke="var(--orange)" stroke-width="1"
        stroke-dasharray="3 3" opacity=".7"/>` : ''}
      <text class="topo-lbl" x="0" y="${-r - 7}" text-anchor="middle"
        fill="var(--txt)" font-size="10.5" font-weight="650">${esc(nm)}</text>
      ${line2}${line3}
    </g>`;
  }).join('');

  svg.innerHTML = ringHtml + edgeHtml + nodeHtml;

  $('topoNodeCount').textContent = peers.length + ' 节点';
  $('topoEdgeCount').textContent = edges.length + ' 连接';

  bindTopoEvents(svg, pos, edges);
}

/** 事件绑定 */
function bindTopoEvents(svg, pos, edges) {
  const tip = $('topoTip');
  const canvas = $('topoCanvas');
  if (!canvas) return;

  const showTip = (html, clientX, clientY) => {
    if (!tip) return;
    const cr = canvas.getBoundingClientRect();
    tip.innerHTML = html;
    tip.classList.add('show');
    let x = clientX - cr.left;
    let y = clientY - cr.top - 8;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    x = Math.max(6, Math.min(cr.width - tw - 6, x - tw / 2));
    y = Math.max(6, y - th);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  const hideTip = () => tip && tip.classList.remove('show');

  svg.querySelectorAll('.topo-node').forEach(g => {
    const idx = +g.dataset.n;

    g.addEventListener('mouseenter', () => {
      /* 高亮规则：
         亮 = 当前节点 + 与它直接相连的节点
         暗 = 其余一切
         连线必须【一端是当前节点】才亮——这是关键，
         用「两端都在邻居集合里」判断的话，全互联模式下全部亮，等于没高亮。 */
      const litNodes = new Set([idx]);
      edges.forEach(ed => {
        if (ed.a === idx) litNodes.add(ed.b);
        if (ed.b === idx) litNodes.add(ed.a);
      });

      svg.querySelectorAll('.topo-edge').forEach(el => {
        const a = +el.dataset.a, b = +el.dataset.b;
        const keep = (a === idx || b === idx);
        el.classList.toggle('dim', !keep);
        if (keep) {
          el.dataset.ow = el.getAttribute('stroke-width');
          el.setAttribute('stroke-width', (parseFloat(el.dataset.ow) * 1.6).toFixed(2));
          el.setAttribute('opacity', '1');
        }
      });
      svg.querySelectorAll('.topo-node').forEach(o => {
        o.classList.toggle('dim', !litNodes.has(+o.dataset.n));
        const halo = o.querySelector('.topo-halo');
        if (halo) halo.setAttribute('stroke-width', +o.dataset.n === idx ? '3.6' : '1.8');
      });
    });

    g.addEventListener('mouseleave', () => {
      svg.querySelectorAll('.topo-edge').forEach(el => {
        el.classList.remove('dim');
        if (el.dataset.ow) el.setAttribute('stroke-width', el.dataset.ow);
      });
      svg.querySelectorAll('.topo-node').forEach(o => {
        o.classList.remove('dim');
        const halo = o.querySelector('.topo-halo');
        if (halo) halo.setAttribute('stroke-width', +o.dataset.n === 0 ? '2.4' : '1.8');
      });
      hideTip();
    });

    // tooltip
    g.addEventListener('mousemove', e => {
      const p = topoPeers[idx];
      if (!p) return;
      const lat = parseFloat(p.lat_ms);
      const loss = parseFloat(p.loss_rate);
      const kindTxt = p.kind === 'local' ? '本机' : (p.kind === 'relay' ? '经中转' : '直连');
      let rows = '';
      if (p.ipv4) rows += `<div class="r">IP<b class="mono">${esc(p.ipv4)}</b></div>`;
      if (!isNaN(lat)) rows += `<div class="r">延迟<b style="color:${topoLatColor(lat)}">${lat.toFixed(2)} ms</b></div>`;
      if (!isNaN(loss)) rows += `<div class="r">丢包<b>${loss.toFixed(1)}%</b></div>`;
      if (p.version) rows += `<div class="r">版本<b>${esc(String(p.version).split('-')[0])}</b></div>`;
      showTip(`<div class="h">${esc(p.hostname || '—')}<span class="k">${kindTxt}</span></div>${rows}`,
        e.clientX, e.clientY);
    });
    g.addEventListener('mouseleave', hideTip);

    /* 拖动：只移动当前节点 + 重算它的边，不重建整个 SVG
       （重建会销毁 g 元素，setPointerCapture 随之失效，拖一下就断） */
    let drag = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, scale = 1;

    g.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const P = pos[idx];
      ox = P.x; oy = P.y;
      // 屏幕像素 → SVG 坐标的换算，否则拖动会「飘」
      const rect = svg.getBoundingClientRect();
      const vb = svg.getAttribute('viewBox').split(/\s+/);
      scale = (parseFloat(vb[2]) || rect.width) / rect.width;
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
      svg.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    });

    g.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = (e.clientX - sx) * scale;
      const dy = (e.clientY - sy) * scale;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      moved = true;

      const nx = ox + dx, ny = oy + dy;
      pos[idx] = { x: nx, y: ny };
      topoManual[idx] = { x: nx, y: ny };

      g.setAttribute('transform', `translate(${nx.toFixed(1)},${ny.toFixed(1)})`);

      // 只更新与它相连的边
      svg.querySelectorAll('.topo-edge').forEach(el => {
        const a = +el.dataset.a, b = +el.dataset.b;
        if (a !== idx && b !== idx) return;
        const A = pos[a], B = pos[b];
        if (!A || !B) return;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const ddx = B.x - A.x, ddy = B.y - A.y;
        const cqx = mx - ddy * 0.045, cqy = my + ddx * 0.045;
        el.setAttribute('d',
          `M${A.x.toFixed(1)} ${A.y.toFixed(1)} Q${cqx.toFixed(1)} ${cqy.toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`);
      });

      // 中心环跟随
      if (idx === 0) {
        svg.querySelectorAll('.topo-ring').forEach(c => {
          c.setAttribute('cx', nx.toFixed(1));
          c.setAttribute('cy', ny.toFixed(1));
        });
      }
    });

    const endDrag = e => {
      if (!drag) return;
      drag = false;
      svg.classList.remove('dragging');
      try { g.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);

    g.addEventListener('click', () => {
      if (moved) return;   // 拖动后不触发详情
      openNodeDetail(idx);
    });
  });

  // 连线 tooltip
  svg.querySelectorAll('.topo-edge').forEach(el => {
    el.addEventListener('mousemove', e => {
      const a = topoPeers[+el.dataset.a], b = topoPeers[+el.dataset.b];
      if (!a || !b) return;
      const lat = parseFloat(a.lat_ms) || parseFloat(b.lat_ms);
      const isRelay = a.kind === 'relay' || b.kind === 'relay';
      showTip(`<div class="h">${esc(a.hostname || '—')} ↔ ${esc(b.hostname || '—')}</div>
        <div class="r">类型<b>${isRelay ? '经中转' : '直连'}</b></div>
        ${!isNaN(lat) ? `<div class="r">延迟<b>${lat.toFixed(2)} ms</b></div>` : ''}`,
        e.clientX, e.clientY);
    });
    el.addEventListener('mouseleave', hideTip);
  });
}

function initTopoControls() {
  const viewSeg = $('topoViewSeg');
  const layoutSeg = $('topoLayoutSeg');

  if (viewSeg) {
    viewSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        viewSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        topoView = b.dataset.v;
        renderTopo();
      });
    });
  }

  if (layoutSeg) {
    layoutSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        layoutSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        topoLayout = b.dataset.l;
        topoManual = {};   // 切换布局时清掉手动位置
        renderTopo();
      });
    });
  }

  ['cbTopoLat', 'cbTopoTraffic'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', renderTopo);
  });

  const reset = $('btnTopoReset');
  if (reset) {
    reset.addEventListener('click', () => {
      topoManual = {};
      renderTopo();
      toast('布局已重置');
    });
  }
}

/* ============================================================
 * 配置表单化（S4 需求）
 *
 * 设计要点：
 *   · 表单和 TOML 双向同步，但「原始配置」是唯一真相源
 *   · 表单改动 → 重新生成 TOML → 写回 textarea
 *   · TOML 未知字段必须原样保留，否则用户手写的 ACL 会被吞掉
 * ============================================================ */

const CFG_META = {
  basic: [
    { group: '基本信息', fields: [
      { key: 'instance_name', label: '实例名', type: 'text', mono: true },
      { key: 'hostname',      label: '主机名', type: 'text' },
      { key: 'ipv4',          label: '虚拟 IP', type: 'text', mono: true,
        hint: '需同网段且不重复' },
      { key: 'dhcp',          label: 'DHCP 自动分配', type: 'bool',
        note: '开启后忽略虚拟 IP' },
    ]},
    { group: '监听与设备', fields: [
      { key: 'listeners', label: '监听地址', type: 'list', mono: true,
        placeholder: 'tcp://0.0.0.0:11010' },
    ]},
  ],
  network: [
    { group: '网络身份', required: true, fields: [
      { key: 'network_identity.network_name',   label: '网络名称', type: 'text', mono: true },
      { key: 'network_identity.network_secret', label: '网络密钥', type: 'secret', mono: true },
    ]},
    { group: '子网代理', fields: [
      { key: 'proxy_network', label: '代理网段', type: 'cidrs', mono: true,
        placeholder: '192.168.31.0/24' },
    ]},
    { group: '对等节点', fields: [
      { key: 'peer', label: '种子地址', type: 'uris', mono: true,
        placeholder: 'tcp://1.2.3.4:11010', note: '至少一个，改后需重启核心' },
    ]},
  ],
};

/* 高级配置：按官方 easytier-core --help 整理 */
const CFG_ADV = [
  { group: 'IPv6', folded: false, fields: [
    { key: 'flags.enable_ipv6', label: '启用 IPv6', type: 'bool', def: true },
    { key: 'ipv6', label: 'IPv6 地址', type: 'text', mono: true, placeholder: 'fd00::1/64' },
    { key: 'flags.ipv6_public_addr_auto', label: '公网地址自动获取', type: 'bool' },
  ]},
  { group: '协议加速（KCP / QUIC）', folded: false, fields: [
    { key: 'flags.enable_kcp_proxy',    label: 'KCP 代理', type: 'bool', hint: '弱网下提升 TCP 吞吐' },
    { key: 'flags.disable_kcp_input',   label: '禁止他人用 KCP 连我', type: 'bool' },
    { key: 'flags.enable_quic_proxy',   label: 'QUIC 代理', type: 'bool' },
    { key: 'flags.disable_quic_input',  label: '禁止他人用 QUIC 连我', type: 'bool' },
    { key: 'flags.default_protocol',    label: '默认协议', type: 'select',
      options: ['tcp', 'udp', 'ws', 'wss', 'quic', 'wg'], def: 'tcp' },
    { key: 'flags.compression',         label: '压缩算法', type: 'select',
      options: ['none', 'zstd'], def: 'none' },
  ]},
  { group: 'P2P 与 NAT 穿透', folded: true, fields: [
    { key: 'flags.disable_p2p',                label: '禁用自动 P2P', type: 'bool' },
    { key: 'flags.p2p_only',                   label: '仅 P2P 通信', type: 'bool' },
    { key: 'flags.lazy_p2p',                   label: '按需建立 P2P', type: 'bool' },
    { key: 'flags.disable_udp_hole_punching',  label: '禁用 UDP 打洞', type: 'bool' },
    { key: 'flags.disable_tcp_hole_punching',  label: '禁用 TCP 打洞', type: 'bool' },
    { key: 'flags.disable_sym_hole_punching',  label: '禁用对称 NAT 打洞', type: 'bool' },
    { key: 'flags.disable_upnp',               label: '禁用 UPnP', type: 'bool' },
  ]},
  { group: '路由与转发', folded: true, fields: [
    { key: 'flags.latency_first',          label: '延迟优先', type: 'bool', hint: '默认走最短路径' },
    { key: 'flags.enable_exit_node',       label: '允许作为出口节点', type: 'bool' },
    { key: 'exit_nodes',                   label: '出口节点列表', type: 'list', mono: true },
    { key: 'flags.manual_routes',          label: '手动路由', type: 'list', mono: true,
      placeholder: '192.168.0.0/16' },
    { key: 'flags.relay_network_whitelist', label: '中转白名单', type: 'text', mono: true },
    { key: 'flags.relay_all_peer_rpc',     label: '转发所有 RPC', type: 'bool' },
  ]},
  { group: '白名单与访问控制', folded: true, fields: [
    { key: 'flags.tcp_whitelist',          label: 'TCP 端口白名单', type: 'text', mono: true,
      placeholder: '80,443,8000-9000' },
    { key: 'flags.udp_whitelist',          label: 'UDP 端口白名单', type: 'text', mono: true,
      placeholder: '53' },
    { key: 'flags.private_mode',           label: '私有模式', type: 'bool' },
    { key: 'flags.socks5',                 label: 'SOCKS5 端口', type: 'text', mono: true,
      placeholder: '1080' },
  ]},
  { group: '其他', folded: true, fields: [
    { key: 'flags.no_tun',           label: '不创建 TUN 设备', type: 'bool' },
    { key: 'flags.use_smoltcp',      label: '使用 smoltcp 栈', type: 'bool' },
    { key: 'flags.multi_thread',     label: '多线程运行时', type: 'bool' },
    { key: 'flags.mtu',              label: 'MTU', type: 'text', mono: true,
      hint: '加密默认 1360，非加密 1380' },
    { key: 'flags.dev_name',         label: 'TUN 设备名', type: 'text', mono: true },
    { key: 'flags.accept_dns',       label: '魔法 DNS', type: 'bool' },
    { key: 'flags.encryption_algorithm', label: '加密算法', type: 'select',
      options: ['', 'xor', 'chacha20', 'aes-gcm', 'aes-gcm-256'] },
  ]},
];

const CFG_PF_TEMPLATES = [
  { name: '远程桌面 RDP', bind: '0.0.0.0:13389', dst: '127.0.0.1:3389' },
  { name: 'SSH',         bind: '0.0.0.0:10022', dst: '127.0.0.1:22'   },
  { name: 'SMB 共享',    bind: '0.0.0.0:10445', dst: '127.0.0.1:445'  },
  { name: 'HTTP',        bind: '0.0.0.0:10080', dst: '127.0.0.1:80'   },
];

/** 配置对象（从 TOML 解析而来） */
let cfgObj = { flags: {}, network_identity: {}, peer: [], proxy_network: [], port_forward: [] };
let cfgRawChanged = false;

/* ---------------- 极简 TOML 解析 ----------------
 * 不引入 toml 库（前端没必要多 30KB 依赖），
 * 只处理本项目用到的子集：字符串/数字/布尔/数组/表/数组表。
 * 不认识的字段原样保留在 _unknown 里，写回时不丢。 */

function parseToml(text) {
  const obj = {};
  let cur = obj;
  const lines = String(text || '').split(/\r?\n/);

  lines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    // [[array.of.table]]
    let m = line.match(/^\[\[([^\]]+)\]\]$/);
    if (m) {
      const key = m[1].trim();
      if (!Array.isArray(obj[key])) obj[key] = [];
      const item = {};
      obj[key].push(item);
      cur = item;
      return;
    }
    // [table]
    m = line.match(/^\[([^\]]+)\]$/);
    if (m) {
      const key = m[1].trim();
      if (typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
      cur = obj[key];
      return;
    }

    // key = value
    m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) return;
    const key = m[1];
    let val = m[2].trim();

    // 去行尾注释（但保留字符串内的 #）
    val = stripInlineComment(val);

    cur[key] = parseTomlValue(val);
  });

  return obj;
}

function stripInlineComment(v) {
  let inStr = false, q = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === '#') return v.slice(0, i).trim();
    }
  }
  return v.trim();
}

function parseTomlValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  // 数组
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(s => parseTomlValue(s.trim()));
  }
  // 字符串
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return v;
}

function splitTopLevel(s) {
  const out = [];
  let cur = '', depth = 0, inStr = false, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += s[++i] || ''; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/* ---------------- 生成 TOML ---------------- */

function genToml(obj) {
  const lines = [];
  const scalarKeys = [];
  const tableKeys = [];

  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) tableKeys.push(k);
    else if (Array.isArray(v) && v.length && typeof v[0] === 'object') tableKeys.push(k);
    else scalarKeys.push(k);
  });

  scalarKeys.forEach(k => {
    lines.push(`${k} = ${tomlValue(obj[k])}`);
  });

  tableKeys.forEach(k => {
    const v = obj[k];
    if (Array.isArray(v)) {
      v.forEach(item => {
        lines.push('');
        lines.push(`[[${k}]]`);
        Object.keys(item).forEach(kk => lines.push(`${kk} = ${tomlValue(item[kk])}`));
      });
    } else {
      // 标量表放前面，嵌套表放后面
      const subTables = [];
      lines.push('');
      lines.push(`[${k}]`);
      Object.keys(v).forEach(kk => {
        if (v[kk] && typeof v[kk] === 'object' && !Array.isArray(v[kk])) subTables.push(kk);
        else lines.push(`${kk} = ${tomlValue(v[kk])}`);
      });
      subTables.forEach(st => {
        lines.push('');
        lines.push(`[${k}.${st}]`);
        Object.keys(v[st]).forEach(kkk => lines.push(`${kkk} = ${tomlValue(v[st][kkk])}`));
      });
    }
  });

  return lines.join('\n') + '\n';
}

function tomlValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(tomlValue).join(', ') + ']';
  if (v === null || v === undefined) return '""';
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/* ---------------- 取值/设值 ---------------- */

function getByPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = val;
}

/* ---------------- 渲染表单 ---------------- */

function renderField(f, val) {
  const id = 'f_' + f.key.replace(/\./g, '_');
  const hint = f.hint ? `<span class="hint" title="${esc(f.hint)}">?</span>` : '';

  if (f.type === 'bool') {
    return `<div class="cfg-row">
      <div class="lbl">${esc(f.label)}${hint}</div>
      <div style="display:flex;align-items:center;gap:8px">
        <label class="switch"><input type="checkbox" id="${id}" data-cfg="${f.key}"
          data-type="bool" ${val === true ? 'checked' : ''}><span class="track"></span></label>
        ${f.note ? `<span class="small muted">${esc(f.note)}</span>` : ''}
      </div>
    </div>`;
  }

  if (f.type === 'select') {
    const opts = (f.options || []).map(o =>
      `<option value="${esc(o)}" ${String(val === undefined ? f.def : val) === o ? 'selected' : ''}>${esc(o || '(默认)')}</option>`
    ).join('');
    return `<div class="cfg-row">
      <div class="lbl">${esc(f.label)}${hint}</div>
      <select class="inp" id="${id}" data-cfg="${f.key}" data-type="select">${opts}</select>
    </div>`;
  }

  if (f.type === 'secret') {
    return `<div class="cfg-row">
      <div class="lbl">${esc(f.label)}${hint}</div>
      <div class="cfg-secret">
        <input class="inp mono" type="password" id="${id}" data-cfg="${f.key}"
          data-type="text" value="${esc(val == null ? '' : val)}">
        <button class="eye" data-eye="${id}" title="显示/隐藏">
          <svg viewBox="0 0 24 24"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7S19 19 12 19 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
    </div>`;
  }

  if (f.type === 'list' || f.type === 'cidrs' || f.type === 'uris') {
    const arr = Array.isArray(val) ? val : [];
    if (f.type === 'list') {
      // 简单列表：每行一个输入框
      const rows = (arr.length ? arr : ['']).map((v, i) => `
        <div class="list-row">
          <input class="inp ${f.mono ? 'mono' : ''}" data-cfg-list="${f.key}" data-idx="${i}"
            value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">
          <button class="list-del" data-list-del="${f.key}" data-idx="${i}" title="删除">✕</button>
        </div>`).join('');
      return `<div class="cfg-row">
        <div class="lbl">${esc(f.label)}${hint}</div>
        <div class="list-box" data-list-box="${f.key}">
          ${rows}
          <button class="sm-btn" data-list-add="${f.key}">+ 添加</button>
          ${f.note ? `<div class="small muted" style="margin-top:4px">${esc(f.note)}</div>` : ''}
        </div>
      </div>`;
    }
    // cidrs / uris：数组表（[[proxy_network]] / [[peer]]）
    const subKey = f.type === 'cidrs' ? 'cidr' : 'uri';
    const rows = (arr.length ? arr : [{}]).map((item, i) => `
      <div class="list-row">
        <input class="inp ${f.mono ? 'mono' : ''}" data-cfg-tbl="${f.key}" data-sub="${subKey}" data-idx="${i}"
          value="${esc(item[subKey] || '')}" placeholder="${esc(f.placeholder || '')}">
        <button class="list-del" data-tbl-del="${f.key}" data-idx="${i}" title="删除">✕</button>
      </div>`).join('');
    return `<div class="cfg-row">
      <div class="lbl">${esc(f.label)}${hint}</div>
      <div class="list-box">
        ${rows}
        <button class="sm-btn" data-tbl-add="${f.key}" data-sub="${subKey}" data-ph="${esc(f.placeholder || '')}">+ 添加</button>
        ${f.note ? `<div class="small muted" style="margin-top:4px">${esc(f.note)}</div>` : ''}
      </div>
    </div>`;
  }

  // 默认 text
  return `<div class="cfg-row">
    <div class="lbl">${esc(f.label)}${hint}</div>
    <input class="inp ${f.mono ? 'mono' : ''}" id="${id}" data-cfg="${f.key}" data-type="text"
      value="${esc(val == null ? '' : val)}" placeholder="${esc(f.placeholder || '')}">
  </div>`;
}

function renderGroup(g) {
  const body = g.fields.map(f => renderField(f, getByPath(cfgObj, f.key))).join('');
  const req = g.required ? '<span class="req">必填</span>' : '';
  return `<div class="cfg-group ${g.folded ? 'folded' : ''}">
    <h5>${esc(g.group)} ${req} <span class="arrow">▾</span></h5>
    <div class="cfg-body">${body}</div>
  </div>`;
}

function renderConfigForm() {
  if ($('cfgBasic')) {
    $('cfgBasic').innerHTML = CFG_META.basic.map(renderGroup).join('');
  }
  if ($('cfgNetwork')) {
    $('cfgNetwork').innerHTML = CFG_META.network.map(renderGroup).join('') +
      `<div class="note warn">
        <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        <div>对等节点属于部署期配置，改后<b>必须重启核心</b>才生效。</div>
      </div>`;
  }
  if ($('cfgAdv')) {
    $('cfgAdv').innerHTML = CFG_ADV.map(renderGroup).join('');
  }
  if ($('cfgPf')) {
    renderPortForwardPane();
  }
  bindConfigEvents();
}

/** 端口转发卡片列表 */
function renderPortForwardPane() {
  const box = $('cfgPf');
  if (!box) return;
  const list = Array.isArray(cfgObj.port_forward) ? cfgObj.port_forward : [];

  const cards = list.length
    ? list.map((it, i) => `
      <div class="pf-card" data-pf="${i}">
        <div class="pf-flow">
          <input class="inp mono pf-bind" data-pf-bind="${i}" value="${esc(it.bind_addr || '')}"
            placeholder="0.0.0.0:13389">
          <span class="pf-arrow">→</span>
          <input class="inp mono pf-dst" data-pf-dst="${i}" value="${esc(it.dst_addr || '')}"
            placeholder="127.0.0.1:3389">
          <button class="sm-btn danger" data-pf-del="${i}">删除</button>
        </div>
        <div class="pf-meta"><span>绑定地址 → 目标地址</span></div>
      </div>`).join('')
    : '<div class="empty-hint">未配置端口转发</div>';

  const tpls = CFG_PF_TEMPLATES.map((t, i) =>
    `<button class="tpl" data-pf-tpl="${i}">${esc(t.name)}</button>`).join('');

  box.innerHTML = `
    <div class="note">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
      <div>把虚拟网某个端口转发到本机服务。转发到 <span class="mono">127.0.0.1</span> 只对本机生效。</div>
    </div>
    <div class="pf-list">${cards}</div>
    <div style="margin-top:10px">
      <button class="sm-btn" id="btnPfAdd">+ 添加转发规则</button>
    </div>
    <div class="tpl-row">
      <span class="small muted" style="align-self:center;margin-right:2px">快速模板：</span>
      ${tpls}
    </div>`;

  bindPortForwardEvents();
}

function bindPortForwardEvents() {
  const box = $('cfgPf');
  if (!box) return;

  const add = $('btnPfAdd');
  if (add) {
    add.addEventListener('click', () => {
      if (!Array.isArray(cfgObj.port_forward)) cfgObj.port_forward = [];
      cfgObj.port_forward.push({ bind_addr: '', dst_addr: '' });
      renderPortForwardPane();
      markCfgDirty();
    });
  }

  box.querySelectorAll('[data-pf-del]').forEach(el => {
    el.addEventListener('click', () => {
      cfgObj.port_forward.splice(+el.dataset.pfDel, 1);
      renderPortForwardPane();
      markCfgDirty();
    });
  });

  box.querySelectorAll('[data-pf-tpl]').forEach(el => {
    el.addEventListener('click', () => {
      const t = CFG_PF_TEMPLATES[+el.dataset.pfTpl];
      if (!Array.isArray(cfgObj.port_forward)) cfgObj.port_forward = [];
      cfgObj.port_forward.push({ bind_addr: t.bind, dst_addr: t.dst });
      renderPortForwardPane();
      markCfgDirty();
    });
  });

  box.querySelectorAll('[data-pf-bind]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.pfBind;
      if (cfgObj.port_forward[i]) cfgObj.port_forward[i].bind_addr = el.value.trim();
      markCfgDirty();
    });
  });
  box.querySelectorAll('[data-pf-dst]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.pfDst;
      if (cfgObj.port_forward[i]) cfgObj.port_forward[i].dst_addr = el.value.trim();
      markCfgDirty();
    });
  });
}

/** 表单事件绑定 */
function bindConfigEvents() {
  const root = $('setDrawer');
  if (!root) return;

  // 分组折叠
  root.querySelectorAll('.cfg-group > h5').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('folded'));
  });

  // 简单字段
  root.querySelectorAll('[data-cfg]').forEach(el => {
    // type 必须提到 handler 外面：
    // 下面绑定事件名时也要用（text 用 input 实时响应，其他用 change），
    // 之前只在 handler 内部声明，导致外层 ReferenceError: type is not defined
    const type = el.dataset.type;
    const handler = () => {
      const key = el.dataset.cfg;
      let v;
      if (type === 'bool') v = el.checked;
      else v = el.value;

      // 空字符串的数字字段要转成数字
      if (type === 'text' && /^\d+$/.test(v) && key === 'flags.mtu') v = parseInt(v, 10);

      setByPath(cfgObj, key, v);
      markCfgDirty();
    };
    el.addEventListener(type === 'text' ? 'input' : 'change', handler);
  });

  // 密码显示切换
  root.querySelectorAll('[data-eye]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = $(btn.dataset.eye);
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });

  // 列表增删改
  root.querySelectorAll('[data-list-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.listAdd;
      const arr = getByPath(cfgObj, key) || [];
      arr.push('');
      setByPath(cfgObj, key, arr);
      renderConfigForm();
      markCfgDirty();
    });
  });
  root.querySelectorAll('[data-list-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.listDel;
      const arr = getByPath(cfgObj, key) || [];
      arr.splice(+btn.dataset.idx, 1);
      setByPath(cfgObj, key, arr);
      renderConfigForm();
      markCfgDirty();
    });
  });
  root.querySelectorAll('[data-cfg-list]').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = inp.dataset.cfgList;
      const arr = getByPath(cfgObj, key) || [];
      arr[+inp.dataset.idx] = inp.value.trim();
      setByPath(cfgObj, key, arr);
      markCfgDirty();
    });
  });

  // 数组表增删改
  root.querySelectorAll('[data-tbl-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tblAdd;
      const sub = btn.dataset.sub;
      if (!Array.isArray(cfgObj[key])) cfgObj[key] = [];
      const item = {};
      item[sub] = '';
      cfgObj[key].push(item);
      renderConfigForm();
      markCfgDirty();
    });
  });
  root.querySelectorAll('[data-tbl-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tblDel;
      if (Array.isArray(cfgObj[key])) cfgObj[key].splice(+btn.dataset.idx, 1);
      renderConfigForm();
      markCfgDirty();
    });
  });
  root.querySelectorAll('[data-cfg-tbl]').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = inp.dataset.cfgTbl;
      const sub = inp.dataset.sub;
      const i = +inp.dataset.idx;
      if (Array.isArray(cfgObj[key]) && cfgObj[key][i]) {
        cfgObj[key][i][sub] = inp.value.trim();
      }
      markCfgDirty();
    });
  });
}

let cfgDirty = false;
function markCfgDirty() {
  cfgDirty = true;
  const msg = $('cfgMsg');
  if (msg) msg.innerHTML = '<span class="dirty-dot"></span> 有未保存的修改';
}

/** 从原始文本载入配置（唯一真相源） */
function loadCfgFromText(text) {
  cfgObj = parseToml(text);
  if (!cfgObj.flags || typeof cfgObj.flags !== 'object') cfgObj.flags = {};
  if (!cfgObj.network_identity) cfgObj.network_identity = {};
  cfgDirty = false;
  renderConfigForm();

  const raw = $('rawArea');
  if (raw) raw.value = text;
  cfgRawChanged = false;
  updateRawMeta(text);

  const msg = $('cfgMsg');
  if (msg) msg.textContent = '';
}

/** 表单改动 → 生成 TOML 文本 */
function syncCfgToRaw() {
  const text = genToml(cfgObj);
  const raw = $('rawArea');
  if (raw) raw.value = text;
  updateRawMeta(text);
  return text;
}

function updateRawMeta(text) {
  const lines = String(text || '').split('\n').length;
  const msg = $('rawMsg');
  if (msg) {
    msg.innerHTML = `共 <b>${lines}</b> 行 · ${cfgDirty ? '<span style="color:var(--orange)">已修改，未保存</span>' : '未修改'}`;
  }
}

function initConfigUI() {
  // 标签切换
  const tabs = $('cfgTabs');
  if (tabs) {
    tabs.querySelectorAll('.cfg-tab').forEach(b => {
      b.addEventListener('click', () => {
        tabs.querySelectorAll('.cfg-tab').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        const t = b.dataset.t;
        document.querySelectorAll('.cfg-pane').forEach(p => {
          p.classList.toggle('hide', p.dataset.t !== t);
        });
        // 切到原始配置时，把表单改动同步过去
        if (t === 'raw') syncCfgToRaw();
      });
    });
  }

  const rawArea = $('rawArea');
  if (rawArea) {
    rawArea.addEventListener('input', () => {
      cfgRawChanged = true;
      cfgDirty = true;
      updateRawMeta(rawArea.value);
    });
  }

  const copyBtn = $('btnRawCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const v = rawArea ? rawArea.value : '';
      try {
        await navigator.clipboard.writeText(v);
        toast('已复制到剪贴板');
      } catch (_) { toast('复制失败', 'err'); }
    });
  }

  const reloadRaw = $('btnRawReload');
  if (reloadRaw) {
    reloadRaw.addEventListener('click', async () => {
      await reloadConfigFromDisk();
      toast('已重新载入');
    });
  }

  const reloadBtn = $('btnCfgReload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      await reloadConfigFromDisk();
      toast('已重新载入');
    });
  }

  const saveBtn = $('btnCfgSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveConfigText();
    });
  }
}

async function reloadConfigFromDisk() {
  try {
    const j = await api('/api/config_text');
    if (!j.ok) throw new Error('读取失败');
    loadCfgFromText(j.data);
  } catch (e) {
    toast('读取配置失败: ' + e.message, 'err');
  }
}

/** 保存：以原始配置为准；若表单有改动则先合并 */
async function saveConfigText() {
  const raw = $('rawArea');
  let text;

  // 表单改过但没切到原始页 → 用表单生成
  if (cfgDirty && !cfgRawChanged) {
    text = syncCfgToRaw();
  } else {
    text = raw ? raw.value : '';
  }

  try {
    const j = await api('/api/config_text', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!j.ok) throw new Error(j.message || '保存失败');
    toast(j.message || '配置已保存');
    cfgDirty = false;
    cfgRawChanged = false;

    // 重新解析一次，保持表单与文件一致
    loadCfgFromText(text);

    const msg = $('cfgMsg');
    if (msg) msg.textContent = '';
  } catch (e) {
    toast('保存失败: ' + e.message, 'err');
  }
}

/* ============================================================
 * 延迟趋势大图（S6 需求）
 * 小 sparkline 点击后展开，支持 1h/6h/24h 与延迟/丢包切换
 * ============================================================ */

let chartPeer = null;       // 当前查看的节点
let chartRange = 1440;      // 分钟
let chartMetric = 'lat';    // lat | loss
let chartData = [];         // [{t, v}]

/** 打开大图 */
async function openLatencyChart(nodeId, hostname) {
  chartPeer = nodeId;
  const m = $('chartModal');
  if (!m) return;
  const t = $('chartTitle');
  if (t) t.textContent = hostname || '节点';
  m.classList.add('open');
  await loadChartData();
}

async function loadChartData() {
  if (!chartPeer) return;

  // 优先走后端历史；失败则用本地内存缓冲兜底
  let pts = null;
  try {
    const j = await api('/api/latency_history?node=' + encodeURIComponent(chartPeer) +
      '&minutes=' + chartRange);
    if (j.ok && Array.isArray(j.data) && j.data.length) pts = j.data;
  } catch (_) {}

  if (!pts) {
    // 兜底：用前端已有采样
    const hist = latHistory.get(chartPeer) || [];
    pts = hist.map((v, i) => ({ t: Date.now() - (hist.length - i) * 2000, v }));
  }

  chartData = pts.map(p => ({
    t: p.t || p.ts * 1000 || 0,
    v: chartMetric === 'lat' ? (p.v != null ? p.v : p.lat) : (p.loss != null ? p.loss : 0),
  })).filter(p => p.v != null && !isNaN(p.v));

  drawBigChart();
  updateChartStats();
}

function drawBigChart() {
  const svg = $('bigChart');
  if (!svg) return;

  const W = 760, H = 220, L = 44, R = 11, T = 11, B = 26;
  const cw = W - L - R, ch = H - T - B;

  if (!chartData.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle"
      fill="var(--txt-mute)" font-size="12">暂无历史数据（采集一段时间后自动生成）</text>`;
    return;
  }

  const n = chartData.length;
  const vals = chartData.map(d => d.v);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pad = (mx - mn) * 0.12 || 1;
  const y0 = Math.max(0, mn - pad), y1 = mx + pad;
  const X = i => L + (n > 1 ? (i / (n - 1)) * cw : cw / 2);
  const Y = v => T + (1 - (v - y0) / (y1 - y0)) * ch;

  const unit = chartMetric === 'lat' ? 'ms' : '%';
  const col = chartMetric === 'lat' ? 'var(--brand)' : 'var(--red)';

  // 网格 + Y 轴
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + (i / 4) * ch;
    const val = y1 - (i / 4) * (y1 - y0);
    grid += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}"
      stroke="var(--line-soft)" stroke-width="1" ${i === 4 ? '' : 'stroke-dasharray="3 3"'}/>`;
    grid += `<text x="${L - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
      fill="var(--txt-mute)" font-size="9" font-family="Consolas,monospace">${val.toFixed(chartMetric === 'lat' ? 0 : 1)}</text>`;
  }

  // X 轴时间标签
  let xlab = '';
  const t0 = chartData[0].t, t1 = chartData[n - 1].t;
  const fmt = ts => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  for (let i = 0; i <= 4; i++) {
    const x = L + (i / 4) * cw;
    const ts = t0 + (i / 4) * (t1 - t0);
    xlab += `<text x="${x.toFixed(1)}" y="${H - 7}"
      text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}"
      fill="var(--txt-mute)" font-size="9">${i === 4 ? '现在' : fmt(ts)}</text>`;
  }

  // 折线
  const pts = chartData.map((d, i) => [X(i), Y(d.v)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${(W - R).toFixed(1)} ${T + ch} L${L} ${T + ch} Z`;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

  svg.innerHTML = `
    <defs><linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity=".26"/>
      <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#chartGrad)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="1.7"
      stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="${L}" y1="${Y(avg).toFixed(1)}" x2="${W - R}" y2="${Y(avg).toFixed(1)}"
      stroke="var(--orange)" stroke-width="1" stroke-dasharray="4 4" opacity=".75"/>
    <text x="${W - R - 4}" y="${(Y(avg) - 4).toFixed(1)}" text-anchor="end"
      fill="var(--orange)" font-size="8.5" opacity=".9">平均 ${avg.toFixed(1)}</text>
    <line id="chartCross" x1="0" y1="${T}" x2="0" y2="${T + ch}"
      stroke="var(--txt-mute)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
    <circle id="chartDot" cx="0" cy="0" r="3.2" fill="${col}"
      stroke="var(--bg-elev)" stroke-width="1.6" opacity="0"/>
    ${xlab}
    <rect x="${L}" y="${T}" width="${cw}" height="${ch}" fill="transparent" id="chartHit"/>`;

  bindChartHover(svg, W, L, cw, ch, T, X, Y, n, unit);
}

function bindChartHover(svg, W, L, cw, ch, T, X, Y, n, unit) {
  const hit = svg.querySelector('#chartHit');
  const cross = svg.querySelector('#chartCross');
  const dot = svg.querySelector('#chartDot');
  const tip = $('chartTip');
  const tipT = $('chartTipT');
  const tipV = $('chartTipV');
  const tipU = $('chartTipU');
  const wrap = svg.closest('.chart-wrap');
  if (!hit) return;

  hit.addEventListener('mousemove', e => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * W;
    let idx = Math.round((px - L) / cw * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    const d = chartData[idx];
    const x = X(idx), y = Y(d.v);

    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', '1');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', '1');

    if (tip && wrap) {
      const wr = wrap.getBoundingClientRect();
      const scale = wr.width / W;
      const dt = new Date(d.t);
      if (tipT) tipT.textContent =
        `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      if (tipV) tipV.textContent = d.v.toFixed(2);
      if (tipU) tipU.textContent = unit;
      tip.classList.add('show');

      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let tx = x * scale - tw / 2 + 8;
      let ty = y * scale - th - 8;
      tx = Math.max(3, Math.min(wr.width - tw - 3, tx));
      ty = Math.max(3, ty);
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    }
  });

  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    if (tip) tip.classList.remove('show');
  });
}

function updateChartStats() {
  const box = $('chartStats');
  if (!box) return;
  if (!chartData.length) {
    box.innerHTML = `
      <div class="stat min"><div class="k">最小</div><div class="v">—</div></div>
      <div class="stat"><div class="k">平均</div><div class="v">—</div></div>
      <div class="stat max"><div class="k">最大</div><div class="v">—</div></div>
      <div class="stat loss"><div class="k">丢包率</div><div class="v">—</div></div>`;
    return;
  }
  const vals = chartData.map(d => d.v);
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const unit = chartMetric === 'lat' ? ' ms' : '%';

  // 丢包率取当前 peer 的值
  const peer = (lastStatus && (lastStatus.peers || []).find(p => (p.hostname || p.id) === chartPeer)) || {};
  const loss = peer.loss_rate || '—';

  box.innerHTML = `
    <div class="stat min"><div class="k">最小</div><div class="v">${mn.toFixed(2)}${unit}</div></div>
    <div class="stat"><div class="k">平均</div><div class="v">${avg.toFixed(2)}${unit}</div></div>
    <div class="stat max"><div class="k">最大</div><div class="v">${mx.toFixed(2)}${unit}</div></div>
    <div class="stat loss"><div class="k">丢包率</div><div class="v">${esc(loss)}</div></div>`;
}

function initChartUI() {
  const rangeSeg = $('rangeSeg');
  if (rangeSeg) {
    rangeSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', async () => {
        rangeSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        chartRange = +b.dataset.r;
        await loadChartData();
      });
    });
  }

  const metricSeg = $('metricSeg');
  if (metricSeg) {
    metricSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', async () => {
        metricSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        chartMetric = b.dataset.m;
        await loadChartData();
      });
    });
  }

  const csv = $('btnChartCsv');
  if (csv) {
    csv.addEventListener('click', () => {
      if (!chartData.length) { toast('暂无数据可导出', 'err'); return; }
      const rows = [['timestamp', 'time', chartMetric === 'lat' ? 'latency_ms' : 'loss_percent']];
      chartData.forEach(d => {
        const dt = new Date(d.t);
        rows.push([Math.floor(d.t / 1000),
          `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ` +
          `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`,
          d.v.toFixed(3)]);
      });
      const csvText = rows.map(r => r.join(',')).join('\n');
      const blob = new Blob(['\ufeff' + csvText], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${chartPeer || 'node'}-${chartMetric}-${Date.now()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('已导出 CSV');
    });
  }
}

/* ============================================================
 * 节点详情（S7 需求）
 * 按需查询，不进主轮询（否则每 2 秒跑三个 CLI 会拖慢界面）
 * ============================================================ */

let detailPeerId = null;
let detailText = '';

async function openNodeDetail(idxOrId) {
  const m = $('detailModal');
  if (!m) return;

  detailPeerId = idxOrId;
  m.classList.add('open');
  const body = $('detailBody');
  if (body) body.innerHTML = '<div class="detail-loading">正在读取节点信息…</div>';

  let d = null;
  try {
    const j = await api('/api/peer_detail?id=' + encodeURIComponent(idxOrId));
    // 必须校验「有内容」才算成功：
    // 后端未实现该方法时可能返回 {} 或 {ok:true,data:{}}，
    // 若直接采信，renderDetail 会渲染出一堆 "—" 的空壳。
    if (j.ok && j.data && typeof j.data === 'object'
        && (j.data.hostname || j.data.peer_id || j.data.kind)) {
      d = j.data;
    }
  } catch (_) {}

  // 后端不可用 / 返回空时用当前快照兜底
  if (!d) {
    // 快照可能因为刷新时序还没就绪，先主动拉一次，
    // 否则点击详情会偶发「未找到该节点」。
    if (!lastStatus || !(lastStatus.peers || []).length) {
      try {
        const st = await api('/api/status');
        if (st.ok && st.data) lastStatus = st.data;
      } catch (_) {}
    }
    const peers = (lastStatus && lastStatus.peers) || [];
    const key = String(idxOrId);
    const p = typeof idxOrId === 'number' ? peers[idxOrId]
      : peers.find(x => String(x.hostname || '') === key || String(x.id) === key);
    if (!p) {
      if (body) body.innerHTML = '<div class="detail-loading">未找到该节点，可能已离线</div>';
      return;
    }
    d = buildDetailFallback(p, lastStatus);
  }

  renderDetail(d);
}

function buildDetailFallback(p, status) {
  const peers = (status && status.peers) || [];
  const myVer = (peers.find(x => x.kind === 'local') || {}).version || '';
  const lat = parseFloat(p.lat_ms);
  const loss = parseFloat(p.loss_rate);
  const routes = (status && status.routes) || [];
  const route = routes.find(r => r.hostname === p.hostname || r.ipv4 === p.ipv4);

  // 从 peer-center 数据里找该节点的直连邻居（若后端提供）
  const neighbors = (status && status.peer_center || [])
    .filter(n => n.hostname === p.hostname)
    .flatMap(n => n.direct_peers || []);

  return {
    hostname: p.hostname || '—',
    ipv4: p.ipv4 || '',
    cidr: p.cidr || '',
    peer_id: p.id || '',
    kind: p.kind,
    cost: p.cost || '',
    tunnel_proto: p.tunnel_proto || '',
    nat_label: p.nat_label || '',
    version: p.version || '',
    // 与后端 peer_detail 保持同名字段，否则走 fallback 时
    // 本机的 lat/loss/rx/tx 会显示成 "—"，看起来像采集失败
    version_match: !myVer || p.version === myVer || p.kind === 'local',
    my_version: myVer,
    is_self_ref: p.kind === 'local',
    lat, loss,
    rx: p.rx || p.rx_bytes || '',
    tx: p.tx || p.tx_bytes || '',
    route: route || null,
    neighbors,
  };
}

function renderDetail(d) {
  const body = $('detailBody');
  const title = $('detailTitle');
  if (!body) return;
  if (title) title.textContent = d.hostname || '节点';

  const kindTxt = d.kind === 'local' ? '本机' : (d.kind === 'relay' ? `经中转（${d.cost || 'relay'}）` : '直连 (p2p)');
  const kindCol = d.kind === 'local' ? 'var(--brand)' : (d.kind === 'relay' ? 'var(--orange)' : 'var(--green)');

  // 本机自己到自己是「无链路」，lat/loss/流量天然为 "-"。
  // 直接显示 "—" 会被误读成「读不到数据」，所以换成有说明的文字。
  const selfRef = d.kind === 'local' || d.is_self_ref === true;
  const NA = '<span class="na">不适用</span>';

  const latTxt = isNaN(d.lat) ? (selfRef ? NA : '—') : d.lat.toFixed(2) + ' ms';
  const lossTxt = isNaN(d.loss) ? (selfRef ? NA : '—') : d.loss.toFixed(1) + '%';
  const latCol = isNaN(d.lat) ? 'var(--txt-mute)' : (d.lat < 15 ? 'var(--green)' : d.lat < 50 ? 'var(--txt)' : d.lat < 150 ? 'var(--orange)' : 'var(--red)');

  // 版本：优先用后端算好的 version_match；
  // 后端老版本不返回该字段时，退化为前端本地比较，避免恒报不一致。
  const verShort = d.version ? String(d.version).split('-')[0] : '';
  const verMatch = d.version_match !== undefined
    ? !!d.version_match
    : (selfRef || !d.my_version || d.version === d.my_version);
  const verHtml = verShort
    ? `<span class="ver${verMatch ? ' ver-ok' : ' ver-bad'}">${esc(verShort)}${verMatch ? ' ✓' : ' ⚠ 与本机不一致'}</span>`
    : '<span class="muted">—</span>';

  // 流量合计
  const parseBytes = s => {
    const m = String(s || '').match(/^([\d.]+)\s*(B|kB|MB|GB)/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return n * (u === 'GB' ? 1073741824 : u === 'MB' ? 1048576 : u === 'KB' ? 1024 : 1);
  };
  const fmtBytes = b => {
    if (!b) return '—';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(2) + ' kB';
    return b.toFixed(0) + ' B';
  };
  const rxB = parseBytes(d.rx), txB = parseBytes(d.tx);
  const totalB = rxB + txB;

  let neighHtml = '';
  const neighArr = Array.isArray(d.neighbors) ? d.neighbors : [];
  if (neighArr.length) {
    neighHtml = `<div class="d-sec">
      <h4>该节点的直连邻居 <span class="d-sub">共 ${neighArr.length} 个 · 来自 peer-center</span></h4>
      <div class="neigh-list">
        ${neighArr.map(n => {
          const nl = Number(n.latency_ms);
          const nc = isNaN(nl) ? 'var(--txt-mute)'
            : nl < 15 ? 'var(--green)' : nl < 50 ? 'var(--txt)'
            : nl < 150 ? 'var(--orange)' : 'var(--red)';
          return `<div class="neigh">
            <span class="hn">${esc(n.hostname || n.node_id || '—')}</span>
            <span class="muted mono">${esc(n.ipv4 || '无虚拟 IP')}</span>
            <span class="lat" style="color:${nc}">${isNaN(nl) ? '—' : nl + ' ms'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  } else {
    // 整块消失会让用户以为功能没做，这里给明确说明
    neighHtml = `<div class="d-sec">
      <h4>该节点的直连邻居</h4>
      <div class="d-grid">
        <div class="d-field"><div class="v muted">该节点未上报直连邻居信息（可能刚连上，或核心版本不支持 peer-center）</div></div>
      </div>
    </div>`;
  }

  let routeHtml = '';
  if (d.route) {
    const r = d.route;
    // next_hop 的取值是核心内部标记：
    //   Local  → 本机自己
    //   DIRECT → 直连，没有中间跳
    // 直接展示英文标记会让人看不懂，转成中文说明并加颜色区分。
    let hopTxt = '—', hopCls = 'muted';
    const rawHop = String(r.next_hop_hostname || '');
    if (!rawHop || rawHop === 'DIRECT') {
      hopTxt = '直连（无中间跳）';
      hopCls = 'hop-direct';
    } else if (rawHop === 'Local') {
      hopTxt = '本机自身';
      hopCls = 'hop-self';
    } else {
      hopTxt = rawHop;
      hopCls = 'hop-mid';
    }
    routeHtml = `<div class="d-sec">
      <h4>路径</h4>
      <div class="d-grid">
        <div class="d-field"><div class="k">跳数</div><div class="v">${r.path_len != null ? r.path_len + ' 跳' : '—'}</div></div>
        <div class="d-field"><div class="k">路径延迟</div><div class="v">${r.path_latency != null ? Number(r.path_latency).toFixed(2) + ' ms' : '—'}</div></div>
        <div class="d-field"><div class="k">下一跳</div><div class="v ${hopCls}">${esc(hopTxt)}</div></div>
        <div class="d-field"><div class="k">可访问网段</div><div class="v mono">${esc(r.proxy_cidrs || '—')}</div></div>
      </div>
    </div>`;
  }

  body.innerHTML = `
    <div class="d-sec">
      <h4>基本信息</h4>
      <div class="d-grid">
        <div class="d-field"><div class="k">主机名</div><div class="v">${esc(d.hostname || '—')}</div></div>
        <div class="d-field"><div class="k">虚拟 IP</div><div class="v mono">${esc(d.ipv4 || '—')}</div></div>
        <div class="d-field"><div class="k">网段</div><div class="v mono">${esc(d.cidr || '—')}</div></div>
        <div class="d-field"><div class="k">Peer ID</div><div class="v mono">${esc(d.peer_id || '—')}</div></div>
        <div class="d-field"><div class="k">连接方式</div><div class="v" style="color:${kindCol}">${kindTxt}</div></div>
        <div class="d-field"><div class="k">隧道协议</div><div class="v">${esc(d.tunnel_proto || '—')}</div></div>
        <div class="d-field"><div class="k">版本</div><div class="v mono">${verHtml}</div></div>
        <div class="d-field"><div class="k">NAT 类型</div><div class="v">${esc(d.nat_label || '—')}</div></div>
      </div>
    </div>

    <div class="d-sec">
      <h4>连接质量${selfRef ? ' <span class="d-sub">本机不参与链路测量</span>' : ''}</h4>
      <div class="d-grid">
        <div class="d-field"><div class="k">当前延迟</div><div class="v" style="color:${latCol}">${latTxt}</div></div>
        <div class="d-field"><div class="k">丢包率</div><div class="v" style="color:${d.loss > 0 ? 'var(--red)' : 'var(--txt-mute)'}">${lossTxt}</div></div>
        <div class="d-field"><div class="k">近 1 小时平均</div><div class="v">${d.avg1h != null ? d.avg1h.toFixed(2) + ' ms' : (selfRef ? NA : '—')}</div></div>
        <div class="d-field"><div class="k">近 1 小时峰值</div><div class="v">${d.max1h != null ? d.max1h.toFixed(2) + ' ms' : (selfRef ? NA : '—')}</div></div>
      </div>
    </div>

    <div class="d-sec">
      <h4>流量${selfRef ? ' <span class="d-sub">本机收发由各对等节点分别统计</span>' : ''}</h4>
      <div class="d-grid">
        <div class="d-field"><div class="k">接收</div><div class="v mono">${d.rx && d.rx !== '-' ? esc(d.rx) : (selfRef ? NA : '—')}</div></div>
        <div class="d-field"><div class="k">发送</div><div class="v mono">${d.tx && d.tx !== '-' ? esc(d.tx) : (selfRef ? NA : '—')}</div></div>
        <div class="d-field"><div class="k">合计</div><div class="v mono">${totalB ? fmtBytes(totalB) : (selfRef ? NA : '—')}</div></div>
        <div class="d-field"><div class="k">收发比</div><div class="v">${rxB && txB ? '1 : ' + (txB / rxB).toFixed(1) : (selfRef ? NA : '—')}</div></div>
      </div>
    </div>

    ${routeHtml}
    ${neighHtml}

    <div class="d-sec">
      <h4>延迟趋势（近 1 小时）</h4>
      <div class="mini-chart" id="detailMiniChart">
        <svg viewBox="0 0 700 64" preserveAspectRatio="none"
          style="width:100%;height:100%;display:block" id="detailMiniSvg"></svg>
      </div>
    </div>`;

  drawDetailMiniChart(d);

  // 组装纯文本供复制
  detailText = [
    `主机名: ${d.hostname || '—'}`,
    `虚拟 IP: ${d.ipv4 || '—'}`,
    `网段: ${d.cidr || '—'}`,
    `Peer ID: ${d.peer_id || '—'}`,
    `连接方式: ${kindTxt}`,
    `隧道协议: ${d.tunnel_proto || '—'}`,
    `版本: ${d.version || '—'}${d.version_match ? '' : ' (与本机不一致)'}`,
    `NAT 类型: ${d.nat_label || '—'}`,
    `当前延迟: ${latTxt}`,
    `丢包率: ${lossTxt}`,
    `接收: ${d.rx || '—'}`,
    `发送: ${d.tx || '—'}`,
    `合计: ${fmtBytes(totalB)}`,
  ].join('\n');
}

function drawDetailMiniChart(d) {
  const svg = $('detailMiniSvg');
  if (!svg) return;
  const hist = latHistory.get(d.hostname || d.peer_id) || [];

  // 本机没有链路延迟，画趋势没意义，直接说明原因
  if (d.kind === 'local' || d.is_self_ref === true) {
    svg.innerHTML = `<text x="350" y="30" text-anchor="middle" fill="var(--txt-mute)" font-size="10">本机不参与链路延迟测量</text>
      <text x="350" y="46" text-anchor="middle" fill="var(--txt-mute)" font-size="9" opacity=".7">查看对等节点可看到延迟趋势</text>`;
    return;
  }

  if (hist.length < 2) {
    const need = 2 - hist.length;
    svg.innerHTML = `<text x="350" y="30" text-anchor="middle" fill="var(--txt-mute)" font-size="10">采样中，还需约 ${need * 2} 秒</text>
      <text x="350" y="46" text-anchor="middle" fill="var(--txt-mute)" font-size="9" opacity=".7">面板每 2 秒采样一次，点击延迟列的曲线可看 1h / 6h / 24h 长趋势</text>`;
    return;
  }
  const W = 700, H = 64, P = 3;
  const mn = Math.min(...hist), mx = Math.max(...hist);
  const sp = Math.max(mx - mn, 0.01);
  const pts = hist.map((v, i) => [
    P + (i / (hist.length - 1)) * (W - P * 2),
    P + (1 - (v - mn) / sp) * (H - P * 2),
  ]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${W - P} ${H} L${P} ${H} Z`;
  svg.innerHTML = `
    <defs><linearGradient id="miniGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--brand)" stop-opacity=".3"/>
      <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#miniGrad)"/>
    <path d="${line}" fill="none" stroke="var(--brand)" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>`;
}

function initDetailUI() {
  const copy = $('btnDetailCopy');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(detailText);
        toast('已复制节点信息');
      } catch (_) { toast('复制失败', 'err'); }
    });
  }
}

/* ---------------- 主题（设置面板版） ----------------
 *
 * 5 套固定配色 + 跟随系统。
 * 不做自由配色：界面有大量语义色（延迟绿/黄/橙/红、告警橙），
 * 允许自定义主色容易与语义色撞车，用户分不清「主题色还是告警色」。
 * ---------------------------------------------- */

const THEMES = [
  { id: 'dark',     name: '深色',     bg: '#0f1319', accent: '#3b82f6' },
  { id: 'light',    name: '浅色',     bg: '#f5f7fa', accent: '#2563eb' },
  { id: 'midnight', name: '午夜蓝',   bg: '#0b1020', accent: '#6366f1' },
  { id: 'sand',     name: '暖沙',     bg: '#f7f3ec', accent: '#b45309' },
  { id: 'forest',   name: '墨绿',     bg: '#0c1512', accent: '#10b981' },
  { id: 'auto',     name: '跟随系统', bg: 'auto',    accent: '#64748b' },
];

let themeChoice = 'dark';

function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch (_) { return true; }
}

function resolveTheme(choice) {
  if (choice !== 'auto') return choice;
  return systemPrefersDark() ? 'dark' : 'light';
}

function themeIsDark(id) {
  const t = THEMES.find(x => x.id === id);
  if (!t) return true;
  if (t.id === 'auto') return systemPrefersDark();
  return !(t.id === 'light' || t.id === 'sand');
}

function applyTheme(choice) {
  themeChoice = choice;
  const actual = resolveTheme(choice);

  document.documentElement.dataset.theme = actual;
  document.documentElement.style.colorScheme = themeIsDark(actual) ? 'dark' : 'light';

  // 重绘依赖颜色的 SVG
  requestAnimationFrame(() => {
    renderTopo();
    if ($('chartModal') && $('chartModal').classList.contains('open')) drawBigChart();
  });
}

function saveTheme(choice) {
  try { localStorage.setItem(THEME_KEY, choice); } catch (_) {}
}

function renderThemeList() {
  const grid = $('themeGrid');
  if (!grid) return;

  grid.innerHTML = THEMES.map(t => {
    const prev = t.id === 'auto'
      ? `<div class="prev" style="background:linear-gradient(100deg,#0f1319 0 50%,#f5f7fa 50% 100%)"></div>`
      : `<div class="prev"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i></div>`;
    return `<div class="theme-card ${themeChoice === t.id ? 'on' : ''}" data-theme="${t.id}">
      ${prev}
      <div class="nm">${t.name}
        <span class="tick"><svg viewBox="0 0 10 10"><path d="M2 5l2.4 2.4L8 3"/></svg></span>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-theme]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.theme;
      applyTheme(id);
      saveTheme(id);
      renderThemeList();
    });
  });
}

function initTheme() {
  let saved = 'dark';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && THEMES.some(t => t.id === v)) saved = v;
  } catch (_) {}
  applyTheme(saved);
  renderThemeList();

  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (themeChoice === 'auto') applyTheme('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}
}

/* ---------------- 状态渲染 ---------------- */


function renderStatus(d) {
  lastStatus = d;
  const badge = $('connBadge'), text = $('connText');

  if (!BADGE_BUSY) {
    if (d.running) {
      badge.className = 'badge badge-green';
      text.textContent = '运行中';
    } else {
      badge.className = 'badge badge-red';
      text.textContent = '已停止';
    }
  }

  const setDis = (id, dis) => {
    const b = $(id);
    if (!b) return;
    if (b.classList.contains('is-loading')) return;
    b.disabled = dis;
  };
  setDis('btnStart', d.running);
  setDis('btnStop', !d.running);
  setDis('btnRestart', !d.running);

  // 顶部副标题：本机身份
  const n = d.node;
  const sub = $('nodeSub');
  if (sub) {
    if (n) {
      const ip = (n.ipv4_addr || '').split('/')[0];
      const ver = n.version ? 'v' + String(n.version).split('-')[0] : '';
      sub.textContent = [n.hostname, ip, ver].filter(Boolean).join(' · ');
    } else {
      sub.textContent = d.running ? '读取中…' : '核心未运行';
    }
  }

  /* 各模块独立渲染，互不影响
   *
   * 之前是顺序直接调用，任意一个模块抛异常（比如数据字段类型意外）
   * 都会中断后面的全部渲染——曾经因为 renderRoutes 里对字符串调用
   * .map() 抛 TypeError，导致末尾的 topoPeers 赋值被跳过，
   * 表现为「拓扑图永远空白」，而且错误被 refresh 的 try/catch 吞掉，
   * 极难定位。现在每个模块单独 try，一个坏不拖累其他。
   */
  const safeRender = (name, fn) => {
    try { fn(); }
    catch (e) {
      console.error(`[render] ${name} 失败:`, e);
    }
  };

  safeRender('node', () => renderNode(d));
  safeRender('peers', () => renderPeers(d));
  safeRender('proxy', () => renderProxy(d));
  safeRender('routes', () => renderRoutes(d));
  safeRender('forwards', () => renderForwards(d));
  safeRender('active', () => renderActive(d));

  // 拓扑数据（即使上面某个模块失败，这里也会执行）
  safeRender('topo', () => {
    topoPeers = Array.isArray(d.peers) ? d.peers : [];
    renderTopo();
  });
}

/* ---------------- 轮询 ---------------- */

let refreshTimer = null;

async function refresh() {
  try {
    const j = await api('/api/status');
    if (!j.ok) throw new Error(j.error || '未知错误');
    const d = j.data;

    failCount = 0;
    renderStatus(d);

    if (lastRunning !== null && lastRunning !== d.running) {
      toast(d.running ? '核心已启动' : '核心已停止', d.running ? 'ok' : 'err');
      if (currentLogTab === 'core') loadLog(true);
    }
    lastRunning = d.running;
  } catch (e) {
    failCount++;
    if (BADGE_BUSY) return;
    if (failCount >= 3) {
      $('connBadge').className = 'badge badge-red';
      $('connText').textContent = '面板失联';
    } else {
      $('connBadge').className = 'badge badge-gray';
      $('connText').textContent = '重连中…';
    }
  }
}

function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

/* ---------------- 操作 ---------------- */

async function action(path, label, opts = {}) {
  const { btnId, busyTitle, busyDesc } = opts;

  if (btnId) setBtnLoading(btnId, true);
  if (busyTitle) setBusy(true, busyTitle, busyDesc);
  else setBadgeBusy(label + '中…');

  try {
    const j = await api(path, { method: 'POST' });
    if (!j.ok) throw new Error(j.message || `${label}失败`);
    toast(j.message || `${label}成功`, 'ok');
    await refresh();
  } catch (e) {
    toast(`${label}失败: ${e.message}`, 'err');
  } finally {
    if (btnId) setBtnLoading(btnId, false);
    if (busyTitle) setBusy(false);
    else clearBadgeBusy();
    refresh();
  }
}

async function lightAction(btnId, fn, label) {
  setBtnLoading(btnId, true);
  try {
    await fn();
  } catch (e) {
    toast(`${label}失败: ${e.message}`, 'err');
  } finally {
    setBtnLoading(btnId, false);
  }
}

/* ---------------- 日志 ---------------- */

let currentLogTab = 'core';
let currentLogLevel = 'all';
let logRawText = '';

async function loadLog(silent) {
  const view = $('logView');
  if (!view) return;

  const path = currentLogTab === 'app'
    ? '/api/app_log?lines=400'
    : '/api/log?lines=400';

  try {
    const j = await api(path);
    if (!j.ok) throw new Error(j.error || '读取失败');
    logRawText = j.data || '';
    renderLogText();
  } catch (e) {
    if (!silent) {
      view.textContent = '读取日志失败: ' + e.message;
    }
  }
}

function renderLogText() {
  const view = $('logView');
  if (!view) return;

  let lines = String(logRawText || '').split('\n');

  if (currentLogLevel === 'warn') {
    lines = lines.filter(l => /WARN|ERROR|error=|failed/i.test(l));
  } else if (currentLogLevel === 'error') {
    lines = lines.filter(l => /ERROR|error=|failed/i.test(l));
  }

  view.innerHTML = lines.map(l => {
    if (/ERROR|error=|failed/i.test(l)) return `<span class="le">${esc(l)}</span>`;
    if (/WARN/i.test(l)) return `<span class="lw">${esc(l)}</span>`;
    if (/INFO/i.test(l)) return `<span class="li">${esc(l)}</span>`;
    return esc(l);
  }).join('\n');

  const auto = $('cbLogAuto');
  if (auto && auto.checked) view.scrollTop = view.scrollHeight;
}

function initLogUI() {
  const seg = $('logSeg');
  if (seg) {
    seg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        currentLogTab = b.dataset.l;
        const p = $('logPath');
        if (p) {
          p.textContent = currentLogTab === 'app'
            ? 'logs\\console.log'
            : 'logs\\easytier-runtime.log';
        }
        loadLog();
      });
    });
  }

  const lvSeg = $('logLevelSeg');
  if (lvSeg) {
    lvSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        lvSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        currentLogLevel = b.dataset.lv;
        renderLogText();
      });
    });
  }

  const rb = $('btnLogRefresh');
  if (rb) rb.addEventListener('click', () => lightAction('btnLogRefresh', () => loadLog(), '刷新'));

  const dirBtn = $('btnLogDir');
  if (dirBtn) dirBtn.addEventListener('click', () => lightAction('btnLogDir', openDir, '打开目录'));
}

/* ---------------- 设置抽屉 ---------------- */

function openSettings(pane) {
  const d = $('setDrawer');
  if (!d) return;
  d.classList.add('open');
  const btn = $('btnSettings');
  if (btn) btn.classList.add('on');
  if (pane) switchSettingsPane(pane);
  renderThemeList();
  renderModList();
  applyModules();
  syncSettingsUI();
}

function closeSettings() {
  const d = $('setDrawer');
  if (d) d.classList.remove('open');
  const btn = $('btnSettings');
  if (btn) btn.classList.remove('on');
}

function switchSettingsPane(pane) {
  document.querySelectorAll('#setNav .nav-item').forEach(x => {
    x.classList.toggle('on', x.dataset.pane === pane);
  });
  document.querySelectorAll('.pane').forEach(x => {
    x.classList.toggle('on', x.dataset.pane === pane);
  });
  if (pane === 'log') { loadLog(); }
  if (pane === 'config') { reloadConfigFromDisk(); }
}

/** 把设置值同步到开关控件 */
function syncSettingsUI() {
  const map = {
    setStopOnExit: 'stop_core_on_exit',
    setConfirmExit: 'confirm_on_exit',
    setCleanupOrphan: 'cleanup_orphan',
    setMinToTray: 'minimize_to_tray',
    setAutostart: 'autostart',
    setAutostartCore: 'autostart_core',
    setStartMin: 'start_minimized',
  };
  Object.keys(map).forEach(id => {
    const el = $(id);
    if (el) el.checked = !!APP_SETTINGS[map[id]];
  });
}

function initSettingsUI() {
  const btn = $('btnSettings');
  if (btn) btn.addEventListener('click', () => {
    const d = $('setDrawer');
    if (d && d.classList.contains('open')) closeSettings();
    else openSettings('page');
  });

  const close = $('btnSetClose');
  if (close) close.addEventListener('click', closeSettings);

  // 左侧导航
  document.querySelectorAll('#setNav .nav-item').forEach(b => {
    b.addEventListener('click', () => switchSettingsPane(b.dataset.pane));
  });

  // 打开目录
  const od = $('btnOpenDir');
  if (od) od.addEventListener('click', () => lightAction('btnOpenDir', openDir, '打开目录'));

  // 设置开关
  const map = {
    setStopOnExit: 'stop_core_on_exit',
    setConfirmExit: 'confirm_on_exit',
    setCleanupOrphan: 'cleanup_orphan',
    setMinToTray: 'minimize_to_tray',
    setAutostartCore: 'autostart_core',
    setStartMin: 'start_minimized',
  };
  Object.keys(map).forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      saveAppSettings({ [map[id]]: el.checked });
    });
  });

  // 自启开关要调后端
  const autoEl = $('setAutostart');
  if (autoEl) {
    autoEl.addEventListener('change', async () => {
      const on = autoEl.checked;
      try {
        const j = await api('/api/autostart', {
          method: 'POST',
          body: JSON.stringify({ enable: on }),
        });
        if (!j.ok) throw new Error(j.message || '设置失败');
        await saveAppSettings({ autostart: on });
        toast(on ? '已开启开机自启' : '已关闭开机自启', 'ok');
      } catch (e) {
        toast('设置开机自启失败: ' + e.message, 'err');
        autoEl.checked = !on;
      }
    });
  }

  // 孤儿检测 / 清理
  const chk = $('btnCheckOrphan');
  if (chk) {
    chk.addEventListener('click', async () => {
      try {
        const j = await api('/api/orphan_check');
        if (!j.ok) throw new Error('检测失败');
        const n = (j.data.orphans || []).length;
        toast(n > 0 ? `发现 ${n} 个残留核心进程` : '没有发现残留进程', n > 0 ? 'err' : 'ok');
      } catch (e) {
        toast('检测失败: ' + e.message, 'err');
      }
    });
  }
  ['btnCleanOrphan2', 'btnCleanOrphan'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', async () => {
      await runOrphanCleanup(false);
      await refreshOrphanBar();
    });
  });

  // Esc 关闭设置（但不关闭其他已打开的弹窗）
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const d = $('setDrawer');
    if (d && d.classList.contains('open')) {
      const anyModal = ['chartModal', 'detailModal', 'exitModal']
        .some(m => $(m) && $(m).classList.contains('open'));
      if (!anyModal) closeSettings();
    }
  });
}

/* ---------------- 异常明细弹窗 ----------------
 *
 * 表格只在行左侧画一条橙条 + 卡片头显示「N 个异常」，
 * 但用户看不懂「为什么算异常」。这里把每条原因列出来，
 * 并给出可点击的节点名直达详情。
 * ---------------------------------------------- */

/** 求某个节点的全部异常原因（返回空数组代表正常） */
function abnormalReasons(p, myVer) {
  const out = [];
  if (p.kind === 'local') return out;

  const loss = parseFloat(p.loss_rate);
  const lat = parseFloat(p.lat_ms);

  if (!isNaN(loss) && loss >= 5) {
    out.push({
      key: 'loss',
      label: '丢包率偏高',
      value: loss.toFixed(1) + '%',
      limit: '≥ 5%',
      color: loss >= 20 ? 'red' : 'orange',
      desc: '链路不稳定，可能是无线信号弱、NAT 穿透质量差，或对端带宽被占满。'
    });
  }
  if (!isNaN(lat) && lat >= 150) {
    out.push({
      key: 'lat',
      label: '延迟过高',
      value: lat.toFixed(2) + ' ms',
      limit: '≥ 150ms',
      color: lat >= 300 ? 'red' : 'orange',
      desc: '可能走了远距离中转，或本机到对端的路由绕远。'
    });
  }
  if (myVer && p.version && p.version !== myVer) {
    out.push({
      key: 'ver',
      label: '版本与本机不一致',
      value: String(p.version).split('-')[0],
      limit: '本机 ' + String(myVer).split('-')[0],
      color: 'orange',
      desc: '跨大版本组网可能出现协议不兼容，建议升级到同一版本。'
    });
  }
  return out;
}

function openAbnormalList() {
  const m = $('abnModal');
  const body = $('abnBody');
  if (!m || !body) return;

  const peers = (lastStatus && lastStatus.peers) || [];
  const myVer = (peers.find(p => p.kind === 'local') || {}).version || '';

  const bad = peers
    .map(p => ({ p, reasons: abnormalReasons(p, myVer) }))
    .filter(x => x.reasons.length > 0);

  if (!bad.length) {
    body.innerHTML = `<div class="abn-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5L16 9.5"/></svg>
      <div class="t">当前没有异常节点</div>
      <div class="d">所有节点的丢包、延迟、版本都在正常范围内。</div>
    </div>`;
    m.classList.add('open');
    return;
  }

  body.innerHTML = bad.map(({ p, reasons }) => {
    const loss = parseFloat(p.loss_rate);
    const lat = parseFloat(p.lat_ms);
    return `<div class="abn-card">
      <div class="abn-head">
        <span class="abn-name">${esc(p.hostname || '—')}</span>
        <span class="abn-ip mono">${esc(p.ipv4 || '无虚拟 IP')}</span>
        <span class="abn-kind">${p.kind === 'p2p' ? '直连' : '中转'}</span>
        <button class="sm-btn abn-goto" data-goto-pid="${esc(String(p.id == null ? '' : p.id))}"
          data-goto-host="${esc(p.hostname || '')}">查看详情 →</button>
      </div>
      <div class="abn-reasons">
        ${reasons.map(r => `<div class="abn-reason">
          <span class="abn-dot ${r.color}"></span>
          <span class="abn-rl">${esc(r.label)}</span>
          <span class="abn-rv ${r.color}">${esc(r.value)}</span>
          <span class="abn-lim">阈值 ${esc(r.limit)}</span>
          <span class="abn-rd">${esc(r.desc)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');

  // 「查看详情」直接跳到节点详情，形成闭环
  body.querySelectorAll('.abn-goto').forEach(b => {
    b.addEventListener('click', () => {
      m.classList.remove('open');
      openNodeDetail(b.dataset.gotoPid || b.dataset.gotoHost);
    });
  });

  m.classList.add('open');
}

function initAbnormalTag() {
  const tag = $('abnormalTag');
  if (!tag) return;
  tag.addEventListener('click', () => {
    if (tag.style.display === 'none') return;
    openAbnormalList();
  });
}

/* ---------------- 模态框通用关闭 ---------------- */

function initModalClose() {
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.close;
      const m = $(t + 'Modal');
      if (m) m.classList.remove('open');
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    ['chartModal', 'detailModal'].forEach(id => {
      const m = $(id);
      if (m && m.classList.contains('open')) m.classList.remove('open');
    });
  });
}

/* ---------------- 孤儿提示条 ---------------- */

async function refreshOrphanBar() {
  const bar = $('orphanBar');
  if (!bar) return;
  try {
    const j = await api('/api/orphan_check');
    if (!j.ok) return;
    const n = (j.data.orphans || []).length;
    if (n > 0) {
      $('orphanCount').textContent = n;
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  } catch (_) {
    bar.style.display = 'none';
  }
}

/* ---------------- 打开目录 ---------------- */

async function openDir() {
  try {
    const j = await api('/api/open_dir', { method: 'POST' });
    if (j.ok) toast('已打开程序目录');
  } catch (e) {
    toast('打开目录失败: ' + e.message, 'err');
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  // 主题最先应用，避免首屏闪
  initTheme();

  // 页面模块
  loadModules();
  applyModules();
  renderModList();

  // 对等节点表格交互
  initPeerTable();
  initColPanel();
  initPeerSearch();
  renderColList();
  renderPeerHead();

  // 拓扑
  initTopoControls();
  initModalClose();
  initAbnormalTag();
  initChartUI();
  initDetailUI();
  initLogUI();
  initConfigUI();
  initSettingsUI();

  // 应用设置 + 退出确认
  await loadSettings();
  initExitConfirm();
  listenExitRequest();

  // 元信息
  try {
    const j = await api('/api/meta');
    if (j.ok) {
      REFRESH_MS = j.data.refresh_interval_ms || 2000;
      const ph = $('pathHint');
      if (ph) ph.textContent = '配置：' + j.data.config_path;
      const rp = $('rawPath');
      if (rp) rp.textContent = j.data.config_path || '';
      const lp = $('logPath');
      if (lp) lp.textContent = 'logs\\easytier-runtime.log';

      if (j.data.elevated === false) {
        $('permWarning').style.display = 'flex';
      }
      if (j.data.autostart !== undefined) {
        APP_SETTINGS.autostart = !!j.data.autostart;
      }
      syncSettingsUI();
    }
  } catch (_) {}

  // 按钮
  const btnStart = $('btnStart');
  if (btnStart) btnStart.onclick = () => action('/api/start', '启动', {
    btnId: 'btnStart',
    busyTitle: '正在启动核心…',
    busyDesc: '创建虚拟网卡、连接对等节点，通常需要 2~5 秒',
  });

  const btnStop = $('btnStop');
  if (btnStop) btnStop.onclick = () => action('/api/stop', '停止', {
    btnId: 'btnStop',
    busyTitle: '正在停止核心…',
    busyDesc: '清理虚拟网卡并释放端口',
  });

  const btnRestart = $('btnRestart');
  if (btnRestart) btnRestart.onclick = () => action('/api/restart', '重启', {
    btnId: 'btnRestart',
    busyTitle: '正在重启核心…',
    busyDesc: '先停止再重新创建虚拟网卡，约需 4~8 秒',
  });

  const btnRefresh = $('btnRefresh');
  if (btnRefresh) btnRefresh.onclick = () => lightAction('btnRefresh', refresh, '刷新');

  // 首次加载
  await refresh();
  startPolling();

  // 延迟检查孤儿（不阻塞首屏）
  setTimeout(refreshOrphanBar, 1200);

  // 启动时自动连接核心
  //
  // 这个动作已经移到后端 setup 里执行（Rust 侧读取 autostart_core）。
  // 移走的原因：
  //   1) 原先这里用 setTimeout(800ms) 再检查 lastStatus，
  //      首屏状态没回来时这次启动就被丢掉了；
  //   2) start_minimized 生效后窗口可能在托盘，WebView 被节流，
  //      定时器更不可靠；
  //   3) 前后端都做会导致重复启动（虽然 start_core 有幂等判断，
  //      但会多一次无谓的进程扫描）。
  // 这里只在前端做一次「状态兜底刷新」，让界面尽快反映核心已在运行。
  if (APP_SETTINGS.autostart_core) {
    setTimeout(() => { if (!lastStatus || !lastStatus.running) refresh(); }, 3500);
  }
}

document.addEventListener('DOMContentLoaded', init);
