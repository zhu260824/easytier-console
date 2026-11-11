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
  const loss = parseFloat(p.loss_rate);
  const lat = parseFloat(p.lat_ms);
  if (!isNaN(loss) && loss >= 5) return true;
  if (!isNaN(lat) && lat >= 150) return true;
  if (myVer && p.version && p.version !== myVer) return true;
  return false;
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
          const spark = (!isLocal && !isNaN(lat)) ? sparkSVG(hist, latColor(lat)) : '';
          return `<td class="num ${cls}">
            <span class="lat-cell">
              <span class="lat-val">${esc(txt || '—')}</span>${spark}
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

    return `<tr class="${rowCls}">${cells}</tr>`;
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
    const cell = e.target.closest('.ip-cell');
    if (!cell) return;
    const ip = cell.dataset.ip;
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      const old = cell.innerHTML;
      cell.innerHTML = '<span style="color:var(--green);font-weight:600">已复制</span>';
      setTimeout(() => { cell.innerHTML = old; }, 1000);
    } catch (_) {
      toast('复制失败，请手动选择', 'err');
    }
  });
}

/* ---------------- 主题 ---------------- */

/* ---------------- 主题 ----------------
 *
 * 5 套固定配色 + 1 个「跟随系统」。
 *
 * 为什么不做自由配色（色轮/自定义）：
 *   这个界面有大量语义色（延迟绿/黄/橙/红、告警橙、状态绿）。
 *   一旦允许用户自定义主色，很容易选出与语义色撞车的主色，
 *   用户就分不清「这是主题色还是告警色」。所以只提供
 *   经过调校、语义色仍然可辨的几套预设。
 * ------------------------------------------ */

const THEMES = [
  { id: 'dark',     name: '深色',     dark: true,  bg: '#0f1319', accent: '#3b82f6' },
  { id: 'light',    name: '浅色',     dark: false, bg: '#f5f7fa', accent: '#2563eb' },
  { id: 'midnight', name: '午夜蓝',   dark: true,  bg: '#0b1020', accent: '#6366f1' },
  { id: 'sand',     name: '暖沙',     dark: false, bg: '#f7f3ec', accent: '#b45309' },
  { id: 'forest',   name: '墨绿',     dark: true,  bg: '#0c1512', accent: '#10b981' },
  { id: 'auto',     name: '跟随系统', dark: null,  bg: 'auto',    accent: '#64748b' },
];

const SUN_ICO = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICO = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
const AUTO_ICO = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 010 18" fill="currentColor" stroke="none" opacity=".55"/></svg>';
const TICK_ICO = '<svg viewBox="0 0 10 10"><path d="M2 5l2.4 2.4L8 3"/></svg>';

let themeChoice = 'dark';   // 用户选择（可能是 auto）

/** 系统是否偏好深色 */
function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (_) {
    return true;
  }
}

/** 把「用户选择」解析成实际生效的主题 id */
function resolveTheme(choice) {
  if (choice !== 'auto') return choice;
  return systemPrefersDark() ? 'dark' : 'light';
}

/** 应用主题（choice 是用户选择，含 auto） */
function applyTheme(choice) {
  themeChoice = choice;
  const actual = resolveTheme(choice);

  document.documentElement.dataset.theme = actual;
  // 告诉浏览器这是深色还是浅色，影响原生控件与滚动条
  document.documentElement.style.colorScheme =
    (THEMES.find(t => t.id === actual) || {}).dark ? 'dark' : 'light';

  // 按钮图标：跟随实际生效主题，auto 时显示自动图标
  const ico = $('themeIco');
  if (ico) {
    if (choice === 'auto') ico.innerHTML = AUTO_ICO;
    else ico.innerHTML = actual === 'light' || actual === 'sand' ? SUN_ICO : MOON_ICO;
  }

  const btn = $('btnTheme');
  if (btn) {
    const cur = THEMES.find(t => t.id === choice) || { name: '深色' };
    btn.title = '主题：' + cur.name;
  }
}

function saveTheme(choice) {
  try { localStorage.setItem(THEME_KEY, choice); } catch (_) {}
}

/** 渲染主题列表（含配色小样） */
function renderThemeList() {
  const box = $('themeList');
  if (!box) return;

  box.innerHTML = THEMES.map(t => {
    let preview;
    if (t.id === 'auto') {
      // 自动：左深右浅的斜分块
      preview = `<span class="sw-preview" style="background:linear-gradient(100deg,#0f1319 0 50%,#f5f7fa 50% 100%)"></span>`;
    } else {
      preview = `<span class="sw-preview">
        <i style="background:${t.bg}"></i>
        <i style="background:${t.accent}"></i>
      </span>`;
    }
    return `<div class="theme-item ${themeChoice === t.id ? 'on' : ''}" data-theme-id="${t.id}">
      ${preview}
      <span class="tn">${t.name}</span>
      <span class="tick">${TICK_ICO}</span>
    </div>`;
  }).join('');
}

function initTheme() {
  let saved = 'dark';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && THEMES.some(t => t.id === v)) saved = v;
    else if (v === 'light' || v === 'dark') saved = v;
  } catch (_) {}

  applyTheme(saved);
  renderThemeList();

  const btn = $('btnTheme');
  const panel = $('themePanel');
  if (!btn || !panel) return;

  const setOpen = (on) => {
    panel.classList.toggle('open', on);
    btn.classList.toggle('on', on);
    if (on) renderThemeList();
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!panel.classList.contains('open'));
  });

  // 选择主题
  panel.addEventListener('click', (e) => {
    const item = e.target.closest('[data-theme-id]');
    if (!item) return;
    const id = item.dataset.themeId;
    applyTheme(id);
    saveTheme(id);
    renderThemeList();
    setOpen(false);
  });

  // 点外部 / Esc 关闭
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
  });

  // 选「跟随系统」时，系统主题变化要实时生效
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (themeChoice === 'auto') applyTheme('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}
}

/* ---------------- 渲染：子网代理 ---------------- */

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
    const cidrs = (r.proxy_cidrs || []).length
      ? `<div class="route-cidrs">${r.proxy_cidrs.map(c => `<span class="route-cidr">${esc(c)}</span>`).join('')}</div>`
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

function renderStatus(d) {
  const badge = $('connBadge'), text = $('connText');

  // 若当前处于「操作中」，不要被轮询结果覆盖，
  // 否则用户点了启动、界面又跳回「已停止」，看起来像没反应
  if (!BADGE_BUSY) {
    if (d.running) {
      badge.className = 'badge badge-green';
      text.textContent = '运行中';
    } else {
      badge.className = 'badge badge-red';
      text.textContent = '已停止';
    }
  }

  // 按钮可用性：loading 中的按钮保持 disabled，不要被状态刷新覆盖
  const setDis = (id, dis) => {
    const b = $(id);
    if (!b) return;
    if (b.classList.contains('is-loading')) return;  // 正在进行操作，别动
    b.disabled = dis;
  };
  setDis('btnStart', d.running);
  setDis('btnStop', !d.running);
  setDis('btnRestart', !d.running);

  renderNode(d);
  renderPeers(d);
  renderProxy(d);
  renderRoutes(d);
  renderForwards(d);
  renderActive(d);
}

/* ---------------- 轮询 ---------------- */

async function refresh() {
  try {
    const j = await api('/api/status');
    if (!j.ok) throw new Error(j.error || '未知错误');
    const d = j.data;

    failCount = 0;
    renderStatus(d);

    if (lastRunning !== null && lastRunning !== d.running) {
      toast(d.running ? '核心已启动' : '核心已停止', d.running ? 'ok' : 'err');
      if (drawerMode === 'log') loadLog();
    }
    lastRunning = d.running;
  } catch (e) {
    failCount++;
    // 操作进行中不要被失联提示覆盖
    if (BADGE_BUSY) return;
    // 连续 3 次失败才显示失联，避免偶发抖动
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
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}

/* ---------------- 操作 ---------------- */

/**
 * 执行一个动作命令（启动/停止/重启）
 *
 * @param path    接口路径
 * @param label   动作名（"启动"）
 * @param opts    { btnId, busyTitle, busyDesc }
 *                btnId     - 哪个按钮显示内联转圈
 *                busyTitle - 遮罩标题（不传则不显示遮罩）
 *                busyDesc  - 遮罩副标题
 */
async function action(path, label, opts = {}) {
  const { btnId, busyTitle, busyDesc } = opts;

  // ---- 进入 loading 态 ----
  if (btnId) setBtnLoading(btnId, true);
  if (busyTitle) setBusy(true, busyTitle, busyDesc);
  setBadgeBusy(label + '中…');
  // 暂停轮询，避免请求进行中又被定时刷新覆盖状态
  if (timer) { clearInterval(timer); timer = null; }

  try {
    const j = await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });

    // 成功但消息里带「清理了 N 个残留网卡」时，用 info 风格提示
    const msg = j.message || (label + (j.ok ? '成功' : '失败'));
    toast(msg, j.ok ? 'ok' : 'err');

    // ---- 退出 loading 态 ----
    setBusy(false);
    if (btnId) setBtnLoading(btnId, false);
    clearBadgeBusy();

    // 立即刷新一次，让界面数据跟上
    await refresh();
    startPolling();
  } catch (e) {
    setBusy(false);
    if (btnId) setBtnLoading(btnId, false);
    clearBadgeBusy();
    toast(label + '失败: ' + (e.message || e), 'err');
    // 出错也要恢复轮询，否则界面就"死"了
    await refresh().catch(() => {});
    startPolling();
  }
}

/** 包装一个轻量操作（只在按钮上转圈，不遮挡界面） */
async function lightAction(btnId, fn, label) {
  setBtnLoading(btnId, true);
  try {
    await fn();
  } catch (e) {
    toast((label || '操作') + '失败: ' + (e.message || e), 'err');
  } finally {
    setBtnLoading(btnId, false);
  }
}

/* ---------------- 抽屉 / 弹窗 ---------------- */

function openDrawer(title, mode) {
  $('drawerTitle').textContent = title;
  drawerMode = mode;
  $('drawer').classList.add('open');
  $('overlay').classList.add('show');
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  drawerMode = null;
  if (!$('modal').classList.contains('open')) {
    $('overlay').classList.remove('show');
  }
}

/**
 * 把日志里的 UTC 时间戳转成本地时间显示
 *
 * easytier-core 输出的格式是 `2026-11-10T03:01:52.556Z`（UTC），
 * 直接展示会让人误以为时间不对。这里替换成 `2026-11-10 11:01:52.556`。
 */
function localizeTimestamps(text) {
  return text.replace(
    /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z/g,
    (m, Y, Mo, D, h, mi, s, ms) => {
      const d = new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s, ms ? +ms : 0));
      if (isNaN(d.getTime())) return m;
      const p2 = (n) => String(n).padStart(2, '0');
      const p3 = (n) => String(n).padStart(3, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
             `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
    }
  );
}

async function loadLog() {
  const el = $('drawerBody');
  // 首次打开（内容为空）时显示加载提示，避免一片空白
  const isEmpty = !el.textContent || el.textContent.trim() === '';
  if (isEmpty) {
    el.textContent = '正在读取日志…';
  }
  try {
    const j = await api('/api/log?lines=400');
    const raw = j.data || '(空)';
    el.textContent = localizeTimestamps(raw);
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.textContent = '读取失败: ' + (e.message || e);
  }
}

async function openConfig() {
  try {
    const j = await api('/api/config_text');
    $('cfgText').value = j.data;
    $('cfgMsg').textContent = '';
    $('modal').classList.add('open');
    $('overlay').classList.add('show');
  } catch (e) {
    toast('读取配置失败: ' + e.message, 'err');
  }
}

function closeConfig() {
  $('modal').classList.remove('open');
  if (!$('drawer').classList.contains('open')) {
    $('overlay').classList.remove('show');
  }
}

async function saveConfig() {
  const text = $('cfgText').value;
  $('cfgMsg').textContent = '校验中…';
  setBtnLoading('btnCfgSave', true);
  try {
    const j = await api('/api/config_text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    $('cfgMsg').textContent = j.message;
    toast(j.message, 'ok');
    // 稍等片刻再关弹窗，让用户看到「已保存」
    setTimeout(() => {
      closeConfig();
      refresh().catch(() => {});
    }, 600);
  } catch (e) {
    $('cfgMsg').textContent = '校验失败';
    toast((e.message || String(e)).slice(0, 300), 'err');
  } finally {
    setBtnLoading('btnCfgSave', false);
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  // 主题要最先应用，避免首屏闪一下深色
  initTheme();

  // 对等节点表格的交互（排序 / 列设置 / 搜索 / 复制）
  initPeerTable();
  initColPanel();
  initPeerSearch();
  renderColList();
  renderPeerHead();

  try {
    const j = await api('/api/meta');
    if (j.ok) {
      REFRESH_MS = j.data.refresh_interval_ms || 2000;
      $('pathHint').textContent = '配置：' + j.data.config_path;
      // 开机自启当前状态
      $('chkAutostart').checked = !!j.data.autostart;
      // 权限提示：非管理员时显示警告条
      if (j.data.elevated === false) {
        $('permWarning').style.display = 'flex';
      }
    }
  } catch { /* 忽略 */ }

  $('btnStart').onclick = () => action('/api/start', '启动', {
    btnId: 'btnStart',
    busyTitle: '正在启动核心…',
    busyDesc: '创建虚拟网卡、连接对等节点，通常需要 2~5 秒'
  });

  $('btnStop').onclick = () => action('/api/stop', '停止', {
    btnId: 'btnStop',
    busyTitle: '正在停止核心…',
    busyDesc: '清理虚拟网卡并释放端口'
  });

  $('btnRestart').onclick = () => action('/api/restart', '重启', {
    btnId: 'btnRestart',
    busyTitle: '正在重启核心…',
    busyDesc: '先停止再重新创建虚拟网卡，约需 4~8 秒'
  });

  // 刷新：只转圈，不遮挡界面
  $('btnRefresh').onclick = () => lightAction('btnRefresh', refresh, '刷新');

  $('btnLog').onclick = () => { openDrawer('运行日志', 'log'); loadLog(); };
  $('btnCfg').onclick = openConfig;

  // 打开目录：只转圈（系统对话框可能卡一两秒）
  $('btnOpenDir').onclick = () => lightAction('btnOpenDir', openDir, '打开目录');

  // 开机自启开关
  $('chkAutostart').onchange = async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    setBadgeBusy(on ? '正在开启自启…' : '正在关闭自启…');
    // 操作期间暂停轮询，避免徽章被刷新打断
    if (timer) { clearInterval(timer); timer = null; }
    try {
      if (!IS_TAURI) throw new Error('该功能仅在桌面版可用');
      const msg = await invokeCmd('set_autostart', { enable: on });
      toast(msg.split('\n')[0], 'ok');
      e.target.checked = on;
    } catch (err) {
      toast('设置失败: ' + (err.message || err), 'err');
      e.target.checked = !on;   // 回滚
    } finally {
      e.target.disabled = false;
      // 先解除徽章的 busy 锁，再刷新——否则 renderStatus 的守卫
      // 会把这次刷新跳过，徽章就永久卡在「正在开启自启…」
      clearBadgeBusy();
      await refresh().catch(() => {});
      startPolling();
    }
  };

  $('btnDrawerClose').onclick = closeDrawer;
  $('btnDrawerRefresh').onclick = () => {
    if (drawerMode === 'log') lightAction('btnDrawerRefresh', loadLog, '刷新日志');
  };
  $('btnModalClose').onclick = closeConfig;

  $('btnCfgSave').onclick = saveConfig;
  $('overlay').onclick = () => { closeDrawer(); closeConfig(); };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer(); closeConfig(); }
  });

  await refresh();
  startPolling();
}

/* ---------------- 打开程序目录 ---------------- */

async function openDir() {
  if (!IS_TAURI) {
    toast('该功能仅在桌面版可用', 'err');
    return;
  }
  try {
    await invokeCmd('open_dir');
  } catch (e) {
    toast('打开目录失败: ' + (e.message || e), 'err');
  }
}

init();
