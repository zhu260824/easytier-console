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

/* ---------------- 渲染：对等节点 ---------------- */
/* 列顺序：主机名 / 虚拟IP / 连接方式 / 延迟 / 丢包 / 隧道 / 接收 / 发送 / NAT类型 */

function renderPeers(d) {
  const tb = $('peerBody');
  const peers = d.peers || [];
  $('peerCount').textContent = peers.length + ' 个';

  if (!peers.length) {
    tb.innerHTML = `<tr><td colspan="10" class="empty">${
      d.running ? (d.peers_error ? '采集失败: ' + esc(d.peers_error) : '暂无对等节点') : '核心未运行'
    }</td></tr>`;
    return;
  }

  // 版本一致性检查：以本机版本为基准，不同的节点标红提示。
  // 版本不一致是 EasyTier 组网里很常见的故障源（协议不兼容会导致连不上或频繁重连）。
  const myVer = (peers.find(p => p.kind === 'local') || {}).version || '';

  tb.innerHTML = peers.map(p => {
    const costCls = p.kind === 'p2p' ? 'cost-p2p'
                  : p.kind === 'relay' ? 'cost-relay'
                  : 'cost-local';
    const costLabel = p.kind === 'local' ? '本机'
                    : p.kind === 'p2p' ? '直连'
                    : p.cost;

    let latCls = 'loss-zero', latTxt = p.lat_ms;
    const lat = parseFloat(p.lat_ms);
    if (!isNaN(lat)) {
      latCls = lat < 15 ? 'lat-good' : lat < 50 ? 'lat-mid' : lat < 150 ? 'lat-bad' : 'lat-verybad';
      latTxt = lat.toFixed(1) + ' ms';
    }

    let lossCls = 'loss-zero', lossTxt = p.loss_rate;
    const loss = parseFloat(p.loss_rate);
    if (!isNaN(loss)) {
      lossCls = loss === 0 ? 'loss-zero' : loss < 5 ? 'loss-bad' : 'loss-worse';
    }

    // 版本显示：只取主版本号部分（2.7.0），commit 后缀太长会撑破表格
    const verFull = p.version || '';
    const verShort = verFull ? verFull.split('-')[0] : '';
    const verMismatch = !!(myVer && verFull && verFull !== myVer && p.kind !== 'local');
    const verTip = verFull
      ? `完整版本: ${verFull}${verMismatch ? '\n与本机(' + myVer + ')不一致，可能影响互通' : ''}`
      : '该节点未上报版本';
    const verHtml = verShort
      ? `<span class="ver${verMismatch ? ' ver-diff' : ''}" title="${esc(verTip)}">${esc(verShort)}${verMismatch ? ' ⚠' : ''}</span>`
      : '<span class="muted">—</span>';

    return `<tr>
      <td class="hostname">${esc(p.hostname || '—')}</td>
      <td class="mono">${esc(p.ipv4 || '—')}</td>
      <td><span class="cost-cell ${costCls}"><i class="cost-dot"></i>${esc(costLabel)}</span></td>
      <td class="num ${latCls}">${esc(latTxt || '—')}</td>
      <td class="num ${lossCls}">${esc(lossTxt || '—')}</td>
      <td>${p.tunnel_proto ? `<span class="proto">${esc(p.tunnel_proto)}</span>` : '—'}</td>
      <td class="num muted small">${esc(p.rx || '—')}</td>
      <td class="num muted small">${esc(p.tx || '—')}</td>
      <td class="small">${esc(p.nat_label || '—')}</td>
      <td class="small">${verHtml}</td>
    </tr>`;
  }).join('');
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
