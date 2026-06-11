'use strict';
const api = window.epologue;
const $ = (sel) => document.querySelector(sel);

// 跨平台：Windows 反斜杠 / POSIX 斜杠都能取文件名
const basename = (p) => (p || '').split(/[\\/]/).pop();
const fmtSize = (n) => (n > 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('darwin');

let currentSettings = null;
let libraryCache = [];
let staleFiles = [];
let suggestions = [];
let t = window.EpilogueI18n.makeT('zh');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

/* ---------- i18n ---------- */
function applyI18n() {
  const lang = currentSettings?.language || 'zh';
  t = window.EpilogueI18n.makeT(lang);
  document.documentElement.lang = lang;
  document.body.classList.toggle('lang-en', lang === 'en'); // 英文界面隐藏中文副标题（050）
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
}

/* ---------- 导航 ---------- */
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'dashboard') refreshDashboard();
  if (view === 'ask') refreshLibrary(); // 索引库已并入寻物
  if (view === 'settings') renderStorage(); // 存储统计惰性加载（042：启动即遍历安装目录曾致主进程内存膨胀）
}
for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
}
api.onViewOpen((view) => switchView(view));

api.onAutoScan((found) => {
  staleFiles = found;
  renderStale();
  $('#organizeHint').textContent = t('auto_found_n', { n: found.length });
});

function fileItem(r, extra = '') {
  return `<li>
    <span class="badge">${esc(r.kind || '?')}</span>
    <div class="item-main">
      <div class="item-title">${esc(r.fileName)}</div>
      <div class="item-sub">${esc(r.summary || r.filePath)}</div>
    </div>
    ${extra}
    <button class="link-btn" data-reveal="${esc(r.filePath)}">${t('locate')}</button>
  </li>`;
}

document.body.addEventListener('click', (e) => {
  const reveal = e.target.closest('[data-reveal]');
  if (reveal) api.reveal(reveal.dataset.reveal);
});

/* ---------- 总览：英雄搜索 + 统计 ---------- */
$('#heroSearch').addEventListener('input', (e) => {
  if (e.isComposing) return; // 输入法组合期间不跳转/抢焦点（否则输入法状态闪烁）
  const v = $('#heroSearch').value;
  if (!v) return;
  // 开始输入即动画切换到 Recall，携带已输入内容并续接光标
  $('#heroSearch').value = '';
  switchView('ask');
  const ask = $('#askInput');
  ask.value = v;
  ask.focus();
  ask.setSelectionRange(v.length, v.length);
});

async function refreshDashboard() {
  const [stats, st] = await Promise.all([api.storeStats(), api.getSettings()]);
  currentSettings = st;
  $('#statArchived').textContent = st.stats.archivedCount || 0;
  $('#statTracked').textContent = stats.total;
  const days = st.stats.firstRunAt ? Math.max(1, Math.ceil((Date.now() - st.stats.firstRunAt) / 86400000)) : 1;
  $('#statDays').textContent = days;
  $('#sidebarStats').textContent = `${stats.total} FILES · ${stats.withVector} VEC`;

  // 主进程侧排序+切片，避免全量索引库进 IPC
  const recent = await api.storeRecent(8);
  $('#recentList').innerHTML = recent.map((r) => fileItem(r)).join('') || `<li class="empty">${t('empty_recent')}</li>`;
}

/* ---------- 计费网络上报（best-effort：蜂窝/省流模式视为计费） ---------- */
function reportNetwork() {
  const c = navigator.connection;
  api.reportNetwork(Boolean(c && (c.type === 'cellular' || c.saveData)));
}
navigator.connection?.addEventListener?.('change', reportNetwork);

/* ---------- 进度 ---------- */
api.onIndexProgress((p) => {
  for (const sel of ['#indexProgress', '#organizeProgress']) {
    const box = $(sel);
    if (!box.classList.contains('hidden')) {
      box.querySelector('.progress-text').textContent = `[${p.current ?? '·'}/${p.total ?? '·'}] ${p.file ?? ''} ${p.stage ?? ''}`;
    }
  }
});

/* ---------- 索引库（含日期滑条筛选） ---------- */
let dateRange = { min: 0, max: Date.now() };

async function refreshLibrary() {
  libraryCache = await api.storeList();
  const times = libraryCache.map((r) => r.fileMtime || Date.parse(r.indexedAt) || Date.now());
  dateRange.min = times.length ? Math.min(...times) : 0;
  dateRange.max = times.length ? Math.max(...times) : Date.now();
  renderLibrary();
}

function sliderToTime(v) {
  return dateRange.min + ((dateRange.max - dateRange.min) * v) / 100;
}

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const LIB_PAGE = 400; // 大库渲染上限：首批 400 行，点击「显示更多」翻页式追加
let libraryLimit = LIB_PAGE;

function renderLibrary() {
  const q = $('#libraryFilter').value.trim().toLowerCase();
  let from = sliderToTime(+$('#dateFrom').value);
  let to = sliderToTime(+$('#dateTo').value);
  if (from > to) [from, to] = [to, from];
  $('#dateFromLabel').textContent = libraryCache.length ? fmtDate(from) : '—';
  $('#dateToLabel').textContent = libraryCache.length ? fmtDate(to) : '—';

  const rows = libraryCache.filter((r) => {
    const tm = r.fileMtime || Date.parse(r.indexedAt) || 0;
    if (tm < from - 86400000 || tm > to + 86400000) return false;
    return !q || r.fileName.toLowerCase().includes(q) || (r.summary || '').toLowerCase().includes(q) || (r.keywords || []).join(' ').toLowerCase().includes(q);
  });
  const shown = rows.slice(0, libraryLimit);
  const more = rows.length - shown.length;
  $('#libraryList').innerHTML =
    (shown
      .map((r) =>
        fileItem(
          r,
          `${r.hasVector ? '<span class="badge ok">vec</span>' : ''}<button class="link-btn danger" data-remove="${esc(r.filePath)}">${t('remove')}</button>`
        )
      )
      .join('') || `<li class="empty">${t('lib_empty')}</li>`) +
    (more > 0 ? `<li class="empty"><button class="link-btn" id="btnLibMore">${t('lib_more', { n: more })}</button></li>` : '');
}

// 筛选防抖：每击键全量重建 DOM 在大库下卡顿
let libFilterTimer = null;
function renderLibraryDebounced() {
  libraryLimit = LIB_PAGE; // 条件变化重置翻页
  clearTimeout(libFilterTimer);
  libFilterTimer = setTimeout(renderLibrary, 120);
}
$('#libraryFilter').addEventListener('input', renderLibraryDebounced);
$('#dateFrom').addEventListener('input', renderLibraryDebounced);
$('#dateTo').addEventListener('input', renderLibraryDebounced);
$('#libraryList').addEventListener('click', async (e) => {
  if (e.target.closest('#btnLibMore')) {
    libraryLimit += LIB_PAGE;
    renderLibrary();
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    await api.storeRemove(rm.dataset.remove);
    refreshLibrary();
  }
});

async function runIndex(fn) {
  const box = $('#indexProgress');
  box.classList.remove('hidden', 'done');
  box.querySelector('.progress-text').textContent = t('started');
  try {
    const r = await fn();
    box.classList.add('done');
    box.querySelector('.progress-text').innerHTML =
      `<span class="ok">${t('done_ok_fail', { ok: r.ok, fail: r.failed })}</span>` +
      (r.errors.length ? `<br>${r.errors.slice(0, 5).map((x) => esc(`${basename(x.file)}: ${x.error}`)).join('<br>')}` : '');
  } catch (e) {
    box.classList.add('done');
    box.querySelector('.progress-text').innerHTML = `<span class="err">${esc(t('err', { msg: e.message }))}</span>`;
  }
  refreshLibrary();
  refreshDashboard();
}

$('#btnIndexFolder').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir) runIndex(() => api.indexFolder(dir, $('#recursiveCheck').checked));
});
$('#btnIndexFiles').addEventListener('click', async () => {
  const files = await api.pickFiles();
  if (files.length) runIndex(() => api.indexFiles(files));
});

/* ---------- 寻物：三模式（关键字 / 匹配度 / AI 搜索） ---------- */
function renderSearchSeg() {
  document.querySelectorAll('#searchModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === (currentSettings.searchMode || 'ai')));
}
$('#searchModeSeg').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  currentSettings = await api.setSettings({ searchMode: btn.dataset.mode });
  renderSearchSeg();
});

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim();
  if (!q) return;
  $('#askStatus').classList.remove('hidden');
  $('#answerPanel').classList.add('hidden');
  try {
    const r = await api.ask(q, currentSettings.searchMode || 'ai');
    $('#searchMode').textContent = r.mode === 'vector' ? t('mode_vector') : t('mode_keyword');
    if (!r.hits.length) {
      $('#answerText').textContent = t('no_results');
      $('#answerText').classList.remove('hidden');
    } else if (r.answer) {
      $('#answerText').textContent = r.answer;
      $('#answerText').classList.remove('hidden');
    } else {
      $('#answerText').classList.add('hidden'); // 关键字/匹配度模式：只看命中与分数
    }
    $('#hitList').innerHTML = r.hits.map((h) => fileItem(h, `<span class="badge gold">${(h.score * 100).toFixed(0)}%</span>`)).join('');
  } catch (err) {
    $('#searchMode').textContent = '';
    $('#answerText').textContent = t('err', { msg: err.message });
    $('#answerText').classList.remove('hidden');
    $('#hitList').innerHTML = '';
  }
  $('#answerPanel').classList.remove('hidden');
  $('#askStatus').classList.add('hidden');
});

/* ---------- 助手：对话 + 自我维护的指导方案 ---------- */
let chatHistory = []; // {role, content, events?, error?} —— 只存内存，窗口关闭即释放
let chatBusy = false;

function eventBadge(ev) {
  const key = { settings_updated: 'ev_settings', search: 'ev_search' }[ev.type];
  return key ? `<span class="badge gold">${esc(t(key, { detail: ev.detail || '' }))}</span>` : '';
}

function renderChat() {
  const msgs = chatHistory.length
    ? chatHistory
    : [{ role: 'assistant', content: t('chat_welcome'), welcome: true }];
  $('#chatLog').innerHTML = msgs
    .map(
      (m) => `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}${m.error ? ' error' : ''}${m.welcome ? ' welcome' : ''}">
        <div class="msg-role">${m.role === 'user' ? 'YOU' : 'EPILOGUE'}</div>
        <div class="msg-body">${esc(m.content)}</div>
        ${m.events?.length ? `<div class="msg-events">${m.events.map(eventBadge).join('')}</div>` : ''}
      </div>`
    )
    .join('');
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  $('#chatThinking').classList.toggle('hidden', !chatBusy);
  $('#chatSend').disabled = chatBusy;
}

async function sendChat() {
  const text = $('#chatInput').value.trim();
  if (!text || chatBusy) return;
  $('#chatInput').value = '';
  $('#chatInput').style.height = 'auto';
  chatHistory.push({ role: 'user', content: text });
  chatBusy = true;
  renderChat();
  try {
    // 只送 role/content，截最近条目由主进程负责
    const r = await api.assistantChat(chatHistory.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })));
    chatHistory.push({ role: 'assistant', content: r.reply, events: r.events });
    // 助手改了设置 → 同步整个界面（语言可能都变了）
    if (r.events.some((ev) => ev.type === 'settings_updated')) {
      currentSettings = await api.getSettings();
      applyI18n();
      loadSettingsForm(currentSettings);
    }
  } catch (e) {
    chatHistory.push({ role: 'assistant', content: t('err', { msg: e.message }), error: true });
  }
  chatBusy = false;
  renderChat();
}

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    // isComposing：输入法选词回车不误发送
    e.preventDefault();
    sendChat();
  }
});
$('#btnChatClear').addEventListener('click', () => {
  chatHistory = [];
  renderChat();
});

// 聊天输入：禁止拖动改为自适应高度（上限 140px，发送后复位）
function autosizeChatInput() {
  const el = $('#chatInput');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}
$('#chatInput').addEventListener('input', autosizeChatInput);

/* ---------- 清理：多文件夹配置 ---------- */
// 与归类目标列表同款行式布局（badge + 路径 + 行内配置 + 移除）
function renderCleanupFolders() {
  const folders = currentSettings.cleanup.folders;
  $('#cleanupFolderList').innerHTML =
    folders
      .map(
        (f, i) => `<li>
          <span class="badge">src</span>
          <div class="item-main"><div class="item-title">${esc(f.path)}</div></div>
          <label class="check" style="flex-shrink:0"><span>${t('th_days')}</span>
            <input type="number" min="1" class="days-input" data-cf-days="${i}" value="${f.staleDays ?? ''}" placeholder="${currentSettings.staleDays}" />
          </label>
          <input type="text" class="cf-rules" data-cf-rules="${i}" value="${esc(f.rules ?? '')}" placeholder="${t('th_rules')} · ${t('ph_inherit')}" />
          <label class="check" style="flex-shrink:0" title="${t('cf_enabled_title')}">
            <input type="checkbox" data-cf-en="${i}" ${f.enabled !== false ? 'checked' : ''} /><span>${t('enabled_label')}</span>
          </label>
          <button class="link-btn danger" data-cf-rm="${i}">${t('remove')}</button>
        </li>`
      )
      .join('') || `<li class="empty">${t('cf_empty')}</li>`;
}

$('#cleanupFolderList').addEventListener('input', (e) => {
  const days = e.target.closest('[data-cf-days]');
  const rules = e.target.closest('[data-cf-rules]');
  const en = e.target.closest('[data-cf-en]');
  if (days) currentSettings.cleanup.folders[+days.dataset.cfDays].staleDays = days.value ? Math.max(1, parseInt(days.value, 10)) : null;
  if (rules) currentSettings.cleanup.folders[+rules.dataset.cfRules].rules = rules.value.trim() || null;
  if (en) currentSettings.cleanup.folders[+en.dataset.cfEn].enabled = en.checked;
  scheduleAutoSave('cleanup');
});
$('#cleanupFolderList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-cf-rm]');
  if (rm) {
    currentSettings.cleanup.folders.splice(+rm.dataset.cfRm, 1);
    renderCleanupFolders();
    autoSaveNow('cleanup');
  }
});
$('#btnAddCleanupFolder').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir && !currentSettings.cleanup.folders.some((f) => f.path === dir)) {
    currentSettings.cleanup.folders.push({ path: dir, staleDays: null, rules: null, enabled: true });
    renderCleanupFolders();
    autoSaveNow('cleanup');
  }
});

/* ---------- 清理：扫描与建议 ---------- */
async function runStaleScan(promise) {
  $('#organizeHint').textContent = t('scanning');
  staleFiles = await promise;
  $('#organizeHint').textContent = staleFiles.length ? t('found_n', { n: staleFiles.length }) : t('none_found');
  renderStale();
}

function renderStale() {
  $('#stalePanel').classList.toggle('hidden', !staleFiles.length);
  $('#suggestPanel').classList.add('hidden');
  $('#moveResultPanel').classList.add('hidden');
  $('#staleTable tbody').innerHTML = staleFiles
    .map(
      (f, i) => `<tr>
        <td><input type="checkbox" data-stale="${i}" checked /></td>
        <td><div class="item-title">${esc(f.fileName)}</div></td>
        <td><span class="badge warn">${f.ageDays}d</span></td>
        <td class="mono">${fmtSize(f.sizeBytes)}</td>
        <td class="mono">${esc(basename(f.sourceDir))}</td>
      </tr>`
    )
    .join('');
}

$('#btnScanStale').addEventListener('click', () => runStaleScan(api.scanCleanup()));
$('#btnScanDir').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir) runStaleScan(api.scanStale([dir], null));
});
$('#staleAll').addEventListener('change', (e) => {
  document.querySelectorAll('#staleTable input[type=checkbox]').forEach((c) => (c.checked = e.target.checked));
});

async function suggestFor(items) {
  if (!items.length) return;
  $('#organizeProgress').classList.remove('hidden', 'done');
  $('#organizeProgress .progress-text').textContent = t('analyzing');
  $('#suggestPanel').classList.add('hidden');
  $('#moveResultPanel').classList.add('hidden');
  try {
    suggestions = await api.classifySuggest(items);
    renderSuggestions();
    $('#organizeHint').textContent = t('suggest_done', { n: suggestions.length });
  } catch (e) {
    $('#organizeHint').textContent = t('err', { msg: e.message });
  }
  $('#organizeProgress').classList.add('hidden');
}

$('#btnSuggestStale').addEventListener('click', () => {
  const picked = [...document.querySelectorAll('#staleTable input:checked')].map((c) => {
    const f = staleFiles[+c.dataset.stale];
    return { filePath: f.filePath, rules: f.rulesOverride || null };
  });
  $('#stalePanel').classList.add('hidden');
  suggestFor(picked);
});

$('#btnPickOrganize').addEventListener('click', async () => {
  const files = await api.pickFiles();
  if (files.length) suggestFor(files.map((p) => ({ filePath: p })));
});

function renderSuggestions() {
  $('#suggestTable tbody').innerHTML = suggestions
    .map((s, i) => {
      const trash = s.trash === true;
      const dest = !trash && s.move !== false && s.destination ? `${s.destination}${s.subfolder ? '/' + s.subfolder : ''}` : null;
      const destCell = trash
        ? `<span class="badge warn">${t('dest_trash')}</span>`
        : dest
          ? `<span class="dest-path">${esc(dest)}</span>`
          : `<span class="no-dest">${t('no_dest')}</span>`;
      return `<tr>
        <td><input type="checkbox" data-i="${i}" ${dest || trash ? 'checked' : 'disabled'} /></td>
        <td>${esc(basename(s.filePath))}</td>
        <td>${destCell}</td>
        <td class="reason">${esc(s.reason || '')}</td>
      </tr>`;
    })
    .join('');
  $('#suggestPanel').classList.remove('hidden');
}

$('#btnApplyMoves').addEventListener('click', async () => {
  const picked = [...document.querySelectorAll('#suggestTable input:checked')].map((c) => suggestions[+c.dataset.i]);
  if (!picked.length) return;
  const results = await api.classifyApply(
    picked.map((s) => ({ filePath: s.filePath, destination: s.destination, subfolder: s.subfolder || '', trash: s.trash === true }))
  );
  $('#moveResultList').innerHTML = results
    .map((r) =>
      r.error
        ? `<li><span class="err">✗</span><div class="item-main"><div class="item-title">${esc(basename(r.filePath))}</div><div class="item-sub err">${esc(r.error)}</div></div></li>`
        : r.trashed
          ? `<li><span class="ok">✓</span><div class="item-main"><div class="item-title">${esc(basename(r.filePath))}</div><div class="item-sub">${t('result_trashed')}</div></div></li>`
          : `<li><span class="ok">✓</span><div class="item-main"><div class="item-title">${esc(basename(r.newPath))}</div><div class="item-sub">${esc(r.newPath)}</div></div><button class="link-btn" data-reveal="${esc(r.newPath)}">${t('locate')}</button></li>`
    )
    .join('');
  $('#moveResultPanel').classList.remove('hidden');
  $('#suggestPanel').classList.add('hidden');
  refreshDashboard();
});

/* ---------- 设置：选项卡 ---------- */
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
  });
}

/* ---------- 设置：Provider 灾备列表 ---------- */
const PROVIDER_TYPES = ['chat', 'embeddings', 'transcription'];

const LOCAL_TASK = { transcription: 'automatic-speech-recognition', embeddings: 'feature-extraction' };

// 下载速度统计：进度事件按网络 chunk 高频到达，瞬时速度噪声极大 →
// 500ms 采样窗口（窗口内沿用上次值，避免数值与文本格式闪动）+ EMA 平滑
const dlStats = new Map(); // model -> {lastLoaded, lastTime, speed}
function speedOf(p) {
  const now = performance.now();
  let s = dlStats.get(p.model);
  if (!s) {
    dlStats.set(p.model, { lastLoaded: p.loaded, lastTime: now, speed: null });
    return null;
  }
  const dt = now - s.lastTime;
  if (dt >= 500) {
    const delta = p.loaded - s.lastLoaded;
    if (delta > 0) {
      const inst = (delta / dt) * 1000;
      s.speed = s.speed === null ? inst : s.speed * 0.6 + inst * 0.4;
    }
    s.lastLoaded = p.loaded;
    s.lastTime = now;
  }
  return s.speed ? s.speed | 0 : null;
}

// 行布局：拖动手柄 | 内容 | …… | 启用（右侧）| ✕ 删除（最右，内置/本机无）
function renderProviders(type) {
  const list = currentSettings.providers[type];
  $(`#providers-${type}`).innerHTML = list
    .map((p, i) => {
      const locked = p.keyless || p.type === 'local'; // 内置免费/本机 锁定不可编辑（无 tag）
      const enableBox = `<label class="check enable-box" title="${t('enabled_label')}"><input type="checkbox" data-p-en="${type}.${i}" ${p.enabled !== false ? 'checked' : ''} /></label>`;
      const xBtn = locked ? '<span class="x-spacer"></span>' : `<button class="x-btn" data-p-rm="${type}.${i}" title="${t('remove')}">✕</button>`;
      if (p.type === 'local') {
        // 本机 embedding：模型名 + 支持文件状态 + 下载/删除 + 进度条
        return `<div class="provider-row local-row" draggable="true" data-drag="${type}.${i}">
          <span class="drag-handle">⠿</span>
          <span class="model-name">${esc(p.name)} · ${esc(p.model)}</span>
          <span class="badge" data-model-status="${esc(p.model)}">…</span>
          <button class="mini-btn hidden" data-model-dl="${type}.${i}">${t('model_download')}</button>
          <button class="mini-btn danger hidden" data-model-del="${type}.${i}">${t('model_delete')}</button>
          <span class="spacer"></span>
          <div class="bar hidden" data-model-bar="${esc(p.model)}"><div class="bar-fill"></div></div>
          ${enableBox}${xBtn}
        </div>`;
      }
      // 云端转写无轻量测试手段（需上传音频）→ 空占位保持列对齐
      const testBtn =
        type === 'transcription'
          ? '<span class="x-spacer"></span>'
          : `<button class="mini-btn" data-p-test="${type}.${i}">${t('prov_test')}</button>`;
      return `<div class="provider-row" draggable="true" data-drag="${type}.${i}">
        <span class="drag-handle">⠿</span>
        <input type="text" data-p="${type}.${i}.name" value="${esc(p.name || '')}" placeholder="${t('ph_name')}" ${locked ? 'disabled' : ''} />
        <input type="text" data-p="${type}.${i}.baseUrl" value="${esc(p.baseUrl || '')}" placeholder="${t('ph_baseurl')}" ${locked ? 'disabled' : ''} />
        <input type="password" data-p="${type}.${i}.apiKey" value="${esc(p.apiKey || '')}" placeholder="${p.keyless ? t('ph_keyless') : t('ph_apikey')}" ${locked && p.baseUrl?.includes('pollinations') ? 'disabled' : ''} />
        <input type="text" data-p="${type}.${i}.model" value="${esc(p.model || '')}" placeholder="${t('ph_model')}" ${locked ? 'disabled' : ''} />
        ${testBtn}${enableBox}${xBtn}
      </div>`;
    })
    .join('');
  refreshModelStatuses(type);
}

async function refreshModelStatuses(type) {
  for (const [i, p] of currentSettings.providers[type].entries()) {
    if (p.type !== 'local') continue;
    const el = document.querySelector(`[data-model-status="${CSS.escape(p.model)}"]`);
    if (!el) continue;
    const s = await api.modelStatus(p.model);
    el.textContent = s.downloaded ? t('model_ready', { size: fmtSize(s.sizeBytes) }) : t('model_absent');
    el.classList.toggle('ok', s.downloaded);
    // 未下载→显示下载按钮；已下载→显示删除按钮
    document.querySelector(`[data-model-dl="${type}.${i}"]`)?.classList.toggle('hidden', s.downloaded);
    document.querySelector(`[data-model-del="${type}.${i}"]`)?.classList.toggle('hidden', !s.downloaded);
  }
}

// 模型下载进度推送：状态文字（百分比+速度）+ 进度条；percent=null（尚有文件大小未知）→ 流动条
function setBar(bar, percent) {
  if (!bar) return;
  const indeterminate = percent === null || percent === undefined;
  bar.classList.toggle('hidden', !indeterminate && percent >= 100);
  bar.classList.toggle('indeterminate', indeterminate);
  bar.querySelector('.bar-fill').style.width = indeterminate ? '' : `${percent}%`;
}
api.onModelProgress((p) => {
  if (p.percent >= 100) dlStats.delete(p.model); // 收口清速度状态，下次下载不沿用旧值
  const speed = speedOf(p);
  const speedTxt = speed ? ` · ${fmtSize(speed)}/s` : '';
  const text =
    p.percent === null
      ? `${t('model_init')} ${fmtSize(p.loaded)}${speedTxt}` // 总大小未知阶段：报字节
      : speed
        ? t('model_speed', { p: p.percent, speed: fmtSize(speed) })
        : t('model_downloading', { p: p.percent });
  const el = document.querySelector(`[data-model-status="${CSS.escape(p.model)}"]`);
  if (el) el.textContent = text;
  setBar(document.querySelector(`[data-model-bar="${CSS.escape(p.model)}"]`), p.percent);
});

document.body.addEventListener('change', (e) => {
  const en = e.target.closest('[data-p-en]');
  if (en) {
    const [type, i] = en.dataset.pEn.split('.');
    currentSettings.providers[type][+i].enabled = en.checked;
  }
});

document.body.addEventListener('click', async (e) => {
  const dl = e.target.closest('[data-model-dl]');
  if (dl) {
    const [type, i] = dl.dataset.modelDl.split('.');
    const p = currentSettings.providers[type][+i];
    dl.disabled = true;
    dl.classList.add('hidden');
    // 即时反馈：首个真实进度事件到来前（连镜像/解析清单）就显示状态 + 流动条
    const st = document.querySelector(`[data-model-status="${CSS.escape(p.model)}"]`);
    if (st) st.textContent = t('model_init');
    const bar = document.querySelector(`[data-model-bar="${CSS.escape(p.model)}"]`);
    setBar(bar, null);
    try {
      await api.modelDownload(LOCAL_TASK[type], p.model);
    } catch (err) {
      $('#saveHint').textContent = t('err', { msg: err.message });
      setBar(bar, 100); // 失败收起进度条，状态由 refreshModelStatuses 复原
    }
    dl.disabled = false;
    refreshModelStatuses(type);
  }
  const del = e.target.closest('[data-model-del]');
  if (del) {
    const [type, i] = del.dataset.modelDel.split('.');
    await api.modelDelete(currentSettings.providers[type][+i].model);
    refreshModelStatuses(type);
  }
  // provider 连通测试：用行内当前编辑值（未保存的 Key 也能测）
  const tst = e.target.closest('[data-p-test]');
  if (tst) {
    const [type, i] = tst.dataset.pTest.split('.');
    const p = currentSettings.providers[type][+i];
    tst.disabled = true;
    tst.classList.remove('ok', 'err');
    tst.textContent = '…';
    try {
      const r = await api.providerTest(type, { ...p });
      tst.textContent = t('test_ok', { ms: r.ms });
      tst.classList.add('ok');
    } catch (err) {
      tst.textContent = t('test_fail');
      tst.classList.add('err');
      $('#saveHint').textContent = t('err', { msg: err.message.replace(/^.*provider:test.*?:\s*/, '').slice(0, 200) });
    }
    tst.disabled = false;
    setTimeout(() => {
      tst.textContent = t('prov_test');
      tst.classList.remove('ok', 'err');
    }, 5000);
  }
});

/* ---------- Provider 拖动排序 ---------- */
let dragSrc = null;
document.body.addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-drag]');
  if (row) {
    dragSrc = row.dataset.drag;
    row.classList.add('dragging');
  }
});
document.body.addEventListener('dragover', (e) => {
  if (e.target.closest('[data-drag]')) e.preventDefault();
});
document.body.addEventListener('drop', (e) => {
  const row = e.target.closest('[data-drag]');
  if (!row || !dragSrc) return;
  e.preventDefault();
  const [srcType, srcI] = dragSrc.split('.');
  const [dstType, dstI] = row.dataset.drag.split('.');
  if (srcType === dstType && srcI !== dstI) {
    const list = currentSettings.providers[srcType];
    const [moved] = list.splice(+srcI, 1);
    list.splice(+dstI, 0, moved);
    renderProviders(srcType);
    autoSaveNow('settings');
  }
  dragSrc = null;
});
document.body.addEventListener('dragend', () => {
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  dragSrc = null;
});

/* ---------- 图形 Embedding（多方案模型列表，按需下载，下载后方可启用） ---------- */
const IMG_MODELS = window.EpilogueImageModels.IMAGE_MODELS;
function imgModel() {
  return currentSettings.imageEmbed?.model || window.EpilogueImageModels.DEFAULT_IMAGE_MODEL;
}

function renderImgModels() {
  const cur = imgModel();
  $('#imgModelList').innerHTML = IMG_MODELS.map(
    (m) => `<div class="provider-row local-row">
      <label class="check" style="flex-shrink:0">
        <input type="radio" name="imgModelPick" data-img-pick="${esc(m.id)}" ${m.id === cur ? 'checked' : ''} />
        <span class="model-name"><strong>${esc(m.label)}</strong></span>
      </label>
      <span class="hint">${esc(t(m.descKey))} · ${esc(m.size)}</span>
      <span class="badge" data-model-status="${esc(m.id)}">…</span>
      <button class="mini-btn hidden" data-img-dl="${esc(m.id)}">${t('model_download')}</button>
      <button class="mini-btn danger hidden" data-img-del="${esc(m.id)}">${t('model_delete')}</button>
      <span class="spacer"></span>
      <div class="bar hidden" data-model-bar="${esc(m.id)}"><div class="bar-fill"></div></div>
    </div>`
  ).join('');
  refreshImgStatuses();
}

async function refreshImgStatuses() {
  let curReady = false;
  for (const m of IMG_MODELS) {
    const s = await api.modelStatus(m.id);
    const el = document.querySelector(`[data-model-status="${CSS.escape(m.id)}"]`);
    if (el) {
      el.textContent = s.downloaded ? t('model_ready', { size: fmtSize(s.sizeBytes) }) : t('model_absent');
      el.classList.toggle('ok', s.downloaded);
    }
    document.querySelector(`[data-img-dl="${CSS.escape(m.id)}"]`)?.classList.toggle('hidden', s.downloaded);
    document.querySelector(`[data-img-del="${CSS.escape(m.id)}"]`)?.classList.toggle('hidden', !s.downloaded);
    if (m.id === imgModel()) curReady = s.downloaded;
  }
  $('#imgEnabled').disabled = !curReady; // 所选模型下载后方可启用
  $('#imgEnabled').checked = curReady && currentSettings.imageEmbed?.enabled === true;
  $('#imgGpu').checked = (currentSettings.imageEmbed?.device || 'auto') !== 'cpu';
}

$('#imgModelList').addEventListener('click', async (e) => {
  const dl = e.target.closest('[data-img-dl]');
  if (dl) {
    const id = dl.dataset.imgDl;
    dl.disabled = true;
    dl.classList.add('hidden');
    const st = document.querySelector(`[data-model-status="${CSS.escape(id)}"]`);
    if (st) st.textContent = t('model_init');
    setBar(document.querySelector(`[data-model-bar="${CSS.escape(id)}"]`), null);
    try {
      await api.modelDownload('clip-image', id);
    } catch (err) {
      $('#saveHint').textContent = t('err', { msg: err.message.slice(0, 160) });
      setBar(document.querySelector(`[data-model-bar="${CSS.escape(id)}"]`), 100);
    }
    dl.disabled = false;
    refreshImgStatuses();
  }
  const del = e.target.closest('[data-img-del]');
  if (del) {
    await api.modelDelete(del.dataset.imgDel);
    if (del.dataset.imgDel === imgModel()) currentSettings = await api.setSettings({ imageEmbed: { enabled: false } });
    refreshImgStatuses();
  }
});
$('#imgModelList').addEventListener('change', async (e) => {
  const pick = e.target.closest('[data-img-pick]');
  if (pick) {
    currentSettings = await api.setSettings({ imageEmbed: { model: pick.dataset.imgPick } });
    refreshImgStatuses();
    flashSaved('settings');
  }
});
$('#imgEnabled').addEventListener('change', async () => {
  currentSettings = await api.setSettings({ imageEmbed: { enabled: $('#imgEnabled').checked } });
  flashSaved('settings');
});
$('#imgGpu').addEventListener('change', async () => {
  // 设置变更触发模型子进程重启（applyAppSettings），新 device 经 env 生效
  currentSettings = await api.setSettings({ imageEmbed: { device: $('#imgGpu').checked ? 'auto' : 'cpu' } });
  flashSaved('settings');
});

document.body.addEventListener('input', (e) => {
  const bind = e.target.closest('[data-p]');
  if (bind) {
    const [type, i, key] = bind.dataset.p.split('.');
    currentSettings.providers[type][+i][key] = bind.value.trim();
  }
});
document.body.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-p-rm]');
  if (rm) {
    const [type, i] = rm.dataset.pRm.split('.');
    currentSettings.providers[type].splice(+i, 1);
    renderProviders(type);
    autoSaveNow('settings');
  }
  const add = e.target.closest('[data-add-provider]');
  if (add) {
    const type = add.dataset.addProvider;
    currentSettings.providers[type].push({ name: '', baseUrl: '', apiKey: '', model: '' });
    renderProviders(type);
    autoSaveNow('settings');
  }
});

/* ---------- 设置：表单 ---------- */
function loadSettingsForm(st) {
  PROVIDER_TYPES.forEach(renderProviders);
  $('#rulesInput').value = st.rules || '';
  $('#prefLanguage').value = st.language || 'zh';
  $('#prefLogin').checked = st.app.launchAtLogin;
  $('#prefTray').checked = st.app.trayKeepAlive;
  $('#prefLowPower').checked = st.app.lowPower;
  $('#prefMetered').checked = st.app.avoidCloudOnMetered;
  $('#prefAutoScan').checked = st.cleanup.autoScan;
  $('#prefInterval').value = st.cleanup.scanIntervalHours;
  $('#staleDaysGlobal').value = st.staleDays;
  $('#extOfficeMode').value = st.extraction.officeMode;
  $('#extXlsxMode').value = st.extraction.xlsxMode;
  $('#extPdfPages').value = st.extraction.pdfMaxPages;
  $('#extMaxChars').value = st.extraction.maxChars;
  $('#extSttSecs').value = st.extraction.sttMaxSeconds;
  $('#prefSolo').checked = st.cleanup.soloMode === true;
  $('#prefTrash').checked = st.cleanup.allowTrash === true;
  renderDestList(st.destinations);
  renderCleanupFolders();
  renderSearchSeg();
  renderChat();
  renderImgModels();
  api.powerStatus().then((p) => {
    $('#powerBadge').textContent = p.onBattery ? t('on_battery') : t('on_ac');
  });
}

/* ---------- 存储占用（索引 / 日志 / 模型 / 本体）与按类型清理 ---------- */
async function renderStorage() {
  const s = await api.storageStats();
  const row = (badge, title, bytes, actions = '') => `<li>
    <span class="badge">${badge}</span>
    <div class="item-main"><div class="item-title">${title}</div></div>
    <span class="mono">${bytes === null ? t('sto_dev') : fmtSize(bytes)}</span>
    ${actions}
  </li>`;
  const kindRows = Object.entries(s.index.byKind)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(
      ([kind, v]) => `<li style="padding-left:1.6rem">
        <span class="badge">${esc(kind)}</span>
        <div class="item-main"><div class="item-sub">${t('records_n', { n: v.count })}</div></div>
        <span class="mono">${fmtSize(v.bytes)}</span>
        <button class="mini-btn danger" data-sto-clean="${esc(kind)}">${t('sto_clean')}</button>
      </li>`
    )
    .join('');
  $('#stoList').innerHTML =
    row('idx', `${t('sto_index')}（${t('records_n', { n: s.index.total })}）`, s.index.bytes, `<button class="mini-btn" data-reveal="${esc(s.index.path)}">${t('locate')}</button>`) +
    kindRows +
    row('log', t('sto_logs'), s.logs.bytes, `<button class="mini-btn" id="stoLogOpen">${t('locate')}</button><button class="mini-btn danger" id="stoLogClear">${t('sto_log_clear')}</button>`) +
    row('mdl', t('sto_models'), s.models.bytes, `<button class="mini-btn" data-reveal="${esc(s.models.path)}">${t('locate')}</button>`) +
    row('app', t('sto_app'), s.app.bytes);
}

$('#btnStoRefresh').addEventListener('click', renderStorage);
$('#stoList').addEventListener('click', async (e) => {
  if (e.target.closest('#stoLogOpen')) return api.revealLog();
  if (e.target.closest('#stoLogClear')) {
    await api.clearLog();
    return renderStorage();
  }
  const clean = e.target.closest('[data-sto-clean]');
  if (clean) {
    const n = await api.storageCleanKind(clean.dataset.stoClean);
    $('#saveHint').textContent = t('sto_cleaned', { n, kind: clean.dataset.stoClean });
    renderStorage();
    refreshLibrary();
    refreshDashboard();
  }
});

// 语言即时切换
$('#prefLanguage').addEventListener('change', async () => {
  currentSettings = await api.setSettings({ language: $('#prefLanguage').value });
  applyI18n();
  loadSettingsForm(currentSettings);
  refreshDashboard();
});

function renderDestList(dests) {
  const perFolder = currentSettings.destIndex?.perFolder || {};
  $('#destList').innerHTML =
    dests
      .map((d, i) => {
        const pf = perFolder[d] || {};
        return `<li>
          <span class="badge">dest</span>
          <div class="item-main"><div class="item-title">${esc(d)}</div></div>
          <label class="check" style="flex-shrink:0" title="${t('dest_content_title')}">
            <input type="checkbox" data-dest-opt="content.${i}" ${pf.content !== false ? 'checked' : ''} /><span>${t('dest_content_label')}</span>
          </label>
          <label class="check" style="flex-shrink:0" title="${t('dest_cloud_title')}">
            <input type="checkbox" data-dest-opt="cloud.${i}" ${pf.cloud === true ? 'checked' : ''} /><span>${t('dest_cloud_short')}</span>
          </label>
          <button class="link-btn danger" data-dest-rm="${i}">${t('remove')}</button>
        </li>`;
      })
      .join('') || `<li class="empty">${t('dest_empty')}</li>`;
}

// 每个目标文件夹的「索引内容 / 云内容」单独开关（文件名索引始终随全局开关）
$('#destList').addEventListener('change', (e) => {
  const box = e.target.closest('[data-dest-opt]');
  if (!box) return;
  const [key, i] = box.dataset.destOpt.split('.');
  const dest = currentSettings.destinations[+i];
  if (!currentSettings.destIndex) currentSettings.destIndex = { enabled: true, perFolder: {} };
  if (!currentSettings.destIndex.perFolder) currentSettings.destIndex.perFolder = {};
  const pf = currentSettings.destIndex.perFolder[dest] || {};
  pf[key] = box.checked;
  currentSettings.destIndex.perFolder[dest] = pf;
  autoSaveNow('cleanup');
});

$('#destList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-dest-rm]');
  if (rm) {
    const [removed] = currentSettings.destinations.splice(+rm.dataset.destRm, 1);
    if (removed && currentSettings.destIndex?.perFolder) delete currentSettings.destIndex.perFolder[removed];
    renderDestList(currentSettings.destinations);
    autoSaveNow('cleanup');
  }
});

$('#btnAddDest').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir && !currentSettings.destinations.includes(dir)) {
    currentSettings.destinations.push(dir);
    renderDestList(currentSettings.destinations);
    autoSaveNow('cleanup');
  }
});

// 手动「立即索引」（目标 + 清理来源）走索引进度行
$('#btnIndexDest').addEventListener('click', async () => {
  const box = $('#organizeProgress');
  box.classList.remove('hidden', 'done');
  box.querySelector('.progress-text').textContent = t('started');
  try {
    const r = await api.indexDestinations();
    box.classList.add('done');
    box.querySelector('.progress-text').innerHTML = `<span class="ok">${t('dest_indexed_n', { ok: r.ok, fail: r.failed })}</span>`;
  } catch (e) {
    box.classList.add('done');
    box.querySelector('.progress-text').innerHTML = `<span class="err">${esc(t('err', { msg: e.message }))}</span>`;
  }
  refreshDashboard();
});

/* ---------- 自动保存：所有改动点击/输入即存（防抖） ---------- */
function collectSettingsPatch() {
  return {
    providers: currentSettings.providers,
    rules: $('#rulesInput').value,
    destinations: currentSettings.destinations,
    destIndex: {
      perFolder: currentSettings.destIndex?.perFolder || {},
    },
    language: $('#prefLanguage').value,
    staleDays: Math.max(1, parseInt($('#staleDaysGlobal').value, 10) || 30),
    cleanup: {
      folders: currentSettings.cleanup.folders,
      autoScan: $('#prefAutoScan').checked,
      scanIntervalHours: Math.max(1, parseInt($('#prefInterval').value, 10) || 6),
      soloMode: $('#prefSolo').checked,
      allowTrash: $('#prefTrash').checked,
    },
    app: {
      launchAtLogin: $('#prefLogin').checked,
      trayKeepAlive: $('#prefTray').checked,
      lowPower: $('#prefLowPower').checked,
      avoidCloudOnMetered: $('#prefMetered').checked,
    },
    extraction: {
      officeMode: $('#extOfficeMode').value,
      xlsxMode: $('#extXlsxMode').value,
      pdfMaxPages: Math.max(1, parseInt($('#extPdfPages').value, 10) || 30),
      maxChars: Math.max(500, parseInt($('#extMaxChars').value, 10) || 12000),
      sttMaxSeconds: Math.max(30, parseInt($('#extSttSecs').value, 10) || 300),
    },
  };
}

let saveTimer = null;
let flashTimer = null;
function flashSaved(target) {
  const el = target === 'cleanup' ? $('#organizeHint') : $('#saveHint');
  el.textContent = t('autosaved');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.textContent = ''), 2000);
}
async function autoSaveNow(target) {
  clearTimeout(saveTimer);
  currentSettings = await api.setSettings(collectSettingsPatch());
  flashSaved(target);
}
function scheduleAutoSave(target) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => autoSaveNow(target), 600);
}

// 设置页任何输入/勾选即存（语言有专属处理器，跳过避免重复）
$('#view-settings').addEventListener('input', (e) => {
  if (e.target.id === 'prefLanguage') return;
  scheduleAutoSave('settings');
});
// 清理页配置区即存
$('#rulesInput').addEventListener('input', () => scheduleAutoSave('cleanup'));

/* ---------- ToS（首次启动 + 设置-关于内随时查看，051：纯文本 TERMS.txt 全文零渲染） ---------- */
async function loadDoc(name) {
  $('#docTitle').textContent = t(name === 'terms' ? 'tos_title' : 'license_title'); // 浮层标题随内容（050）
  $('#docText').textContent = await api.appDoc(name);
  document.querySelector('#tosOverlay .tos-body').scrollTop = 0;
}
async function maybeShowTos() {
  if (currentSettings.tosAccepted) return;
  await loadDoc('terms');
  $('#tosOverlay').classList.remove('hidden');
  $('#tosAccept').addEventListener('click', async () => {
    currentSettings = await api.setSettings({ tosAccepted: true });
    $('#tosOverlay').classList.add('hidden');
  });
  $('#tosDecline').addEventListener('click', () => window.close());
}

/* ---------- 关于（047，对齐 ../IRIS：logo + 版本 + ToS 内置查看） ---------- */
api.appVersion().then((v) => {
  $('#aboutVersion').textContent = `v${v.version} · Electron ${v.electron}`;
});
function openDocOverlay() {
  // 查看模式：只显示「关闭」，不出现同意/拒绝
  $('#tosAccept').classList.add('hidden');
  $('#tosDecline').classList.add('hidden');
  $('#tosClose').classList.remove('hidden');
  $('#tosOverlay').classList.remove('hidden');
}
$('#btnViewTos').addEventListener('click', async () => {
  await loadDoc('terms');
  openDocOverlay();
});
$('#btnViewLicense').addEventListener('click', async () => {
  await loadDoc('license'); // GPL-3.0 全文随包内置
  openDocOverlay();
});
$('#tosClose').addEventListener('click', () => {
  $('#tosOverlay').classList.add('hidden');
  $('#tosAccept').classList.remove('hidden');
  $('#tosDecline').classList.remove('hidden');
  $('#tosClose').classList.add('hidden');
});

/* ---------- 启动 ---------- */
(async function init() {
  currentSettings = await api.getSettings();
  applyI18n();
  maybeShowTos();
  loadSettingsForm(currentSettings);
  reportNetwork();
  // 云盘等特殊文件夹后台静默检测记录（清理回退目标依赖 Downloads/Desktop）
  if (!currentSettings.recordedFolders.length) currentSettings.recordedFolders = await api.detectFolders();
  await refreshDashboard();
  await refreshLibrary();
})();
