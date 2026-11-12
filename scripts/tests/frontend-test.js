// v1.1.1 全功能前端测试
// 目标：把每个可交互路径都点一遍，捕获所有运行时错误
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const dir = __dirname;

let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const mock = fs.readFileSync(path.join(dir, 'mock.js'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

html = html.replace(/<script src="mock\.js"><\/script>\s*/g, '');
html = html.replace(/<script src="app\.js"><\/script>/, `<script>${mock}</script>\n<script>${app}</script>`);
html = html.replace(/<link[^>]*style\.css[^>]*>/g, '');
html = html.replace(/<script src="(probe2|geom|verify|verify2|verify3|repro|repro2|dbg\d?|fullrun|verify_cfg)\.js"><\/script>\s*/g, '');

const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errs.push('jsdomError: ' + e.message.slice(0, 160)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ').slice(0, 160)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/',
  pretendToBeVisual: true, virtualConsole: vc,
});
const w = dom.window, d = w.document;
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function chk(section, name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(`[${section}] ${name}${extra ? ' — ' + extra : ''}`); console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function click(el) { if (el) { el.click(); return true; } return false; }

(async () => {
  await new Promise(res => {
    if (d.readyState === 'complete') return res();
    w.addEventListener('load', res);
    setTimeout(res, 4000);
  });
  await wait(4000);

  // ============ 1. 主界面基础渲染 ============
  console.log('\n=== 1. 主界面渲染 ===');
  chk('主界面', '对等节点表有行', d.querySelectorAll('#peerBody tr.row-click').length > 0,
      `${d.querySelectorAll('#peerBody tr.row-click').length} 行`);
  chk('主界面', '节点计数已更新', /^\d+ 个$/.test(d.getElementById('peerCount').textContent),
      d.getElementById('peerCount').textContent);
  chk('主界面', '异常标签显示', d.getElementById('abnormalTag').style.display !== 'none',
      d.getElementById('abnormalTag').textContent);
  chk('主界面', '表头有排序列', d.querySelectorAll('#peerHead th[data-sort]').length > 0,
      `${d.querySelectorAll('#peerHead th[data-sort]').length} 列`);
  chk('主界面', '本机行存在', !!d.querySelector('#peerBody tr.local-row'));

  // 7 个模块卡片
  const mods = ['node','peers','topo','proxy','routes','forwards','active'];
  const missing = mods.filter(m => !d.querySelector(`[data-mod="${m}"]`));
  chk('主界面', '7 个模块卡片齐全', missing.length === 0, missing.length ? '缺: ' + missing : '');

  // ============ 2. 表格交互 ============
  console.log('\n=== 2. 表格交互 ===');
  // 排序
  const th = d.querySelector('#peerHead th[data-key]');
  if (th) {
    click(th); await wait(300);
    const sorted1 = d.querySelectorAll('#peerBody tr.row-click').length;
    click(th); await wait(300);
    chk('表格', '点击表头排序不报错', sorted1 > 0, `行数 ${sorted1}`);
  }
  // 搜索
  const search = d.getElementById('searchInput');
  if (search) {
    search.value = 'node-b';   // 对应 mock 数据里的主机名
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(400);
    const filtered = d.querySelectorAll('#peerBody tr.row-click').length;
    chk('表格', '搜索过滤生效', filtered >= 1 && filtered < 6, `过滤后 ${filtered} 行`);
    // 清空
    search.value = '';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(400);
    chk('表格', '清空搜索恢复', d.querySelectorAll('#peerBody tr.row-click').length === 6,
        `${d.querySelectorAll('#peerBody tr.row-click').length} 行`);
  } else {
    chk('表格', '搜索框存在', false, '未找到 #searchInput');
  }

  // 列设置面板
  const btnCol = d.getElementById('btnCol');
  if (btnCol) {
    click(btnCol); await wait(500);
    const panel = d.getElementById('colPanel');
    chk('表格', '列设置面板打开', panel && panel.classList.contains('open'));
    const items = d.querySelectorAll('#colList .col-item');
    chk('表格', '列项目已渲染', items.length > 0, `${items.length} 项`);
    // 点勾选
    const toggle = d.querySelector('#colList [data-toggle]');
    if (toggle) { click(toggle); await wait(400);
      chk('表格', '勾选列不报错', true); }
    click(btnCol); await wait(300);
  } else chk('表格', '列设置按钮存在', false);

  // ============ 3. 节点详情 ============
  console.log('\n=== 3. 节点详情 ===');
  const firstRow = d.querySelector('#peerBody tr.row-click');
  click(firstRow); await wait(1200);
  const detailModal = d.getElementById('detailModal');
  chk('详情', '弹窗打开', detailModal && detailModal.classList.contains('open'));
  const dbody = d.getElementById('detailBody');
  if (dbody) {
    const t = dbody.textContent;
    chk('详情', '已渲染内容', t.length > 100, `${t.length} 字符`);
    chk('详情', '有基本信息', t.includes('主机名'));
    chk('详情', '有连接质量', t.includes('连接质量'));
    chk('详情', '有流量', t.includes('流量'));
    chk('详情', '有直连邻居', t.includes('直连邻居'));
    chk('详情', '有延迟趋势', t.includes('延迟趋势'));
    chk('详情', '本机语义化', t.includes('不适用') || t.includes('本机不参与'));
  }
  // 关闭
  const closeBtn = detailModal ? detailModal.querySelector('[data-close="detail"]') : null;
  click(closeBtn); await wait(300);
  chk('详情', '可正常关闭', !detailModal.classList.contains('open'));

  // ============ 4. 延迟大图 ============
  console.log('\n=== 4. 延迟大图 ===');
  const spark = d.querySelector('#peerBody .spark-hit');
  chk('大图', 'sparkline 热区存在', !!spark);
  if (spark) {
    click(spark); await wait(1500);
    const chart = d.getElementById('chartModal');
    chk('大图', '大图弹窗打开', chart && chart.classList.contains('open'));
    const svg = d.getElementById('bigChart');
    chk('大图', '图表已绘制', svg && svg.innerHTML.length > 50, svg ? `${svg.innerHTML.length} 字符` : '无');
    // 切 6h / 24h
    const segBtns = d.querySelectorAll('#rangeSeg button');
    if (segBtns.length) {
      click(segBtns[Math.min(1, segBtns.length - 1)]); await wait(1200);
      chk('大图', '切换时间范围不报错', true, `${segBtns.length} 个按钮`);
    }
    const stats = d.querySelectorAll('.stat-row .stat');
    chk('大图', '统计块已生成', stats.length >= 4, `${stats.length} 个`);
    const c = chart ? chart.querySelector('[data-close="chart"]') : null;
    click(c); await wait(300);
  }

  // ============ 5. 异常明细 ============
  console.log('\n=== 5. 异常明细 ===');
  const abnTag = d.getElementById('abnormalTag');
  if (abnTag && abnTag.style.display !== 'none') {
    click(abnTag); await wait(500);
    const am = d.getElementById('abnModal');
    chk('异常', '弹窗打开', am && am.classList.contains('open'));
    const ab = d.getElementById('abnBody');
    chk('异常', '有异常卡片', ab && ab.querySelectorAll('.abn-card').length > 0,
        ab ? `${ab.querySelectorAll('.abn-card').length} 张` : '');
    chk('异常', '有原因条目', ab && ab.querySelectorAll('.abn-reason').length > 0,
        ab ? `${ab.querySelectorAll('.abn-reason').length} 条` : '');
    // 点「查看详情」
    const goto = ab ? ab.querySelector('.abn-goto') : null;
    if (goto) {
      click(goto); await wait(1200);
      chk('异常', '跳转详情成功', d.getElementById('detailModal').classList.contains('open'));
      const dc = d.querySelector('#detailModal [data-close="detail"]');
      click(dc); await wait(300);
    }
    if (am) am.classList.remove('open');
  } else {
    console.log('  （无异常节点，跳过）');
  }

  // ============ 6. 拓扑图 ============
  console.log('\n=== 6. 拓扑图 ===');
  const topo = d.getElementById('topoSvg');
  chk('拓扑', '画布存在', !!topo);
  if (topo) {
    const nodes = topo.querySelectorAll('.topo-node');
    const edges = topo.querySelectorAll('.topo-edge');
    chk('拓扑', '节点已绘制', nodes.length > 0, `${nodes.length} 个`);
    chk('拓扑', '连线已绘制', edges.length > 0, `${edges.length} 条`);
    // 切视图
    const viewBtns = d.querySelectorAll('#topoViewSeg button');
    if (viewBtns.length > 1) {
      click(viewBtns[1]); await wait(600);
      chk('拓扑', '切换视图不报错', topo.querySelectorAll('.topo-node').length > 0,
          `${topo.querySelectorAll('.topo-node').length} 节点`);
      click(viewBtns[0]); await wait(600);
    }
    // 布局切换
    const layoutBtns = d.querySelectorAll('#topoLayoutSeg button');
    if (layoutBtns.length > 1) {
      click(layoutBtns[0]); await wait(600);
      chk('拓扑', '切换布局不报错', topo.querySelectorAll('.topo-node').length > 0);
    }
  }

  // ============ 7. 设置面板 ============
  console.log('\n=== 7. 设置面板 ===');
  const btnSet = d.getElementById('btnSettings');
  click(btnSet); await wait(500);
  const drawer = d.getElementById('setDrawer');
  chk('设置', '抽屉打开', drawer && drawer.classList.contains('open'));

  for (const pane of ['theme','page','behavior','config','log']) {
    const nav = d.querySelector(`.nav-item[data-pane="${pane}"]`);
    if (!nav) { chk('设置', `分区 ${pane} 存在`, false); continue; }
    click(nav); await wait(700);
    const active = d.querySelector('.pane.on');
    chk('设置', `分区 ${pane} 可切换`, active && active.dataset.pane === pane,
        active ? `内容 ${active.innerHTML.length} 字符` : '');
  }

  // 主题切换
  d.querySelector('.nav-item[data-pane="theme"]').click(); await wait(500);
  const themeCards = d.querySelectorAll('#themeGrid .theme-card');
  chk('设置', '主题卡片已渲染', themeCards.length === 6, `${themeCards.length} 张`);
  if (themeCards.length > 1) {
    click(themeCards[1]); await wait(400);
    chk('设置', '切换主题不报错', d.documentElement.dataset.theme !== undefined,
        `当前 ${d.documentElement.dataset.theme}`);
    click(themeCards[0]); await wait(300);
  }

  // 页面模块设置
  d.querySelector('.nav-item[data-pane="page"]').click(); await wait(500);
  const modItems = d.querySelectorAll('#modList .mod-item');
  chk('设置', '模块列表已渲染', modItems.length === 7, `${modItems.length} 项`);
  if (modItems.length) {
    const cb = modItems[0].querySelector('.mod-cb');
    if (cb) { click(cb); await wait(400); chk('设置', '模块显隐切换不报错', true); click(cb); await wait(300); }
  }

  // 启动与退出开关
  d.querySelector('.nav-item[data-pane="behavior"]').click(); await wait(500);
  const switches = d.querySelectorAll('.pane.on .switch input');
  chk('设置', '7 个开关齐全', switches.length === 7, `${switches.length} 个`);
  if (switches.length) {
    const s0 = switches[0];
    const before = s0.checked;
    s0.checked = !before;
    s0.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(500);
    chk('设置', '切换开关不报错', true, `${before} → ${s0.checked}`);
    // 还原
    s0.checked = before;
    s0.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(300);
  }

  // 配置页 5 标签
  d.querySelector('.nav-item[data-pane="config"]').click(); await wait(1200);
  const cfgTabs = d.querySelectorAll('.cfg-tab');
  chk('设置', '配置标签 5 个', cfgTabs.length === 5, `${cfgTabs.length} 个`);
  for (const t of ['basic','network','pf','adv','raw']) {
    const tab = d.querySelector(`.cfg-tab[data-t="${t}"]`);
    if (!tab) { chk('设置', `配置标签 ${t}`, false); continue; }
    click(tab); await wait(600);
    const pane = d.querySelector(`.cfg-pane[data-t="${t}"]`);
    chk('设置', `配置标签 ${t} 有内容`, pane && pane.innerHTML.length > 50,
        pane ? `${pane.innerHTML.length} 字符` : '');
  }
  const toastEl = d.getElementById('toast');
  chk('设置', '配置页无错误提示', !toastEl.textContent.trim(), toastEl.textContent.trim() || '(空)');

  // 日志页
  d.querySelector('.nav-item[data-pane="log"]').click(); await wait(800);
  const logView = d.querySelector('.log-view');
  chk('设置', '日志有内容', logView && logView.textContent.length > 10,
      logView ? `${logView.textContent.length} 字符` : '无');

  // 关闭设置
  click(d.getElementById('btnSetClose')); await wait(300);
  chk('设置', '可关闭', !drawer.classList.contains('open'));

  // ============ 8. 退出确认 ============
  console.log('\n=== 8. 退出确认 ===');
  if (typeof w.openExitConfirm === 'function') {
    w.openExitConfirm();
    await wait(400);
    const em = d.getElementById('exitModal');
    chk('退出', '确认框打开', em && em.classList.contains('open'));
    const opts = d.querySelectorAll('#exitModal .confirm-opt');
    chk('退出', '有选项', opts.length >= 2, `${opts.length} 个`);
    if (em) em.classList.remove('open');
  } else {
    chk('退出', 'openExitConfirm 可调用', false);
  }

  // ============ 9. 运行时错误 ============
  console.log('\n=== 9. 运行时错误 ===');
  // 过滤掉 jsdom 的 CSS 加载报错（我们移除了 link）
  const real = errs.filter(e => !/Could not load|Not implemented|css/i.test(e));
  chk('错误', '无运行时错误', real.length === 0, real.slice(0, 2).join(' | '));

  console.log('\n' + '='.repeat(56));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (failures.length) {
    console.log('\n失败项:');
    failures.forEach(f => console.log('  ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n脚本异常: ' + e.message);
  console.log(e.stack);
  process.exit(1);
});
