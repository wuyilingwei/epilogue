'use strict';
// 定期扫描过期文件。电池供电时间隔 ×3；发现结果发系统通知（点击打开窗口）。
const { powerMonitor, Notification } = require('electron');
const settings = require('./settings');
const stale = require('./stale');
const { makeT } = require('../shared/locales');

let timer = null;
let openWindow = () => {};
let getWindow = () => null;
let lastFound = [];

function onBattery() {
  try {
    return powerMonitor.isOnBatteryPower();
  } catch {
    return false;
  }
}

function intervalMs() {
  const cfg = settings.get();
  let hours = Math.max(0.25, cfg.cleanup.scanIntervalHours || 6);
  if (cfg.app.lowPower && onBattery()) hours *= 3; // 电池模式放缓
  return hours * 3600 * 1000;
}

function notify(body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Epilogue', body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function notifyFound(found, cfg) {
  const t = makeT(cfg.language);
  getWindow()?.webContents.send('stale:auto', found);
  notify(t('notif_found', { n: found.length }), () => openWindow('organize'));
}

// Solo 模式：索引缺失记录 → AI 建议 → 自动执行移动/回收站（无需审批，仅定时触发时走此路径）
async function soloProcess(found) {
  const { log } = require('./log');
  const store = require('./ipc').getStore();
  const indexer = require('./indexer');
  const classifier = require('./classifier');
  const records = [];
  for (const f of found) {
    let r = store.get(f.filePath);
    if (!r) {
      try {
        r = await indexer.indexFile(f.filePath, store); // manual:false —— 沿用电池暂缓等后台约束
      } catch (e) {
        log('solo', `index failed: ${f.fileName}`, { error: String(e.message || e).slice(0, 120) });
        continue;
      }
    }
    records.push({ ...r, rulesOverride: f.rulesOverride || null });
  }
  if (!records.length) return 0;
  const suggestions = await classifier.suggest(records);
  const moves = suggestions
    .filter((s) => s.trash === true || (s.move !== false && s.destination))
    .map((s) => ({ filePath: s.filePath, destination: s.destination, subfolder: s.subfolder || '', trash: s.trash === true }));
  if (!moves.length) return 0;
  const results = await classifier.applyMoves(moves, store);
  const ok = results.filter((r) => r.newPath || r.trashed).length;
  log('solo', `auto-filed ${ok}/${moves.length}`, { trashed: results.filter((r) => r.trashed).length });
  return ok;
}

function tick(auto = false) {
  const cfg = settings.get();
  if (!cfg.cleanup.autoScan) return [];
  // 归类目标额外索引：定时顺带跑一轮（限额内增量），失败只记日志
  if (auto && cfg.destIndex?.enabled) {
    const indexer = require('./indexer');
    indexer
      .indexDestinations(require('./ipc').getStore())
      .catch((e) => require('./log').log('destIndex', 'pass failed', { error: String(e.message || e).slice(0, 160) }));
  }
  const found = stale.scanCleanup(cfg);
  lastFound = found;
  if (!found.length) return found;
  if (auto && cfg.cleanup.soloMode) {
    // fire-and-forget：tick 保持同步返回；solo 完成后通知结果，失败回退原「待整理」通知
    soloProcess(found)
      .then((n) => {
        if (n > 0) notify(makeT(settings.get().language)('notif_solo', { n }), () => openWindow('dashboard'));
      })
      .catch((e) => {
        require('./log').log('solo', 'failed, falling back to notify', { error: String(e.message || e).slice(0, 200) });
        notifyFound(found, settings.get());
      });
    return found;
  }
  notifyFound(found, cfg);
  return found;
}

function arm() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      tick(true); // 定时触发：Solo 模式生效；托盘手动扫描仍走审批流
    } catch {
      /* 扫描失败不致命，下轮再试 */
    }
    arm();
  }, intervalMs());
}

function start(opts) {
  openWindow = opts.openWindow;
  getWindow = opts.getWindow;
  // 电源状态切换时重排计时器
  powerMonitor.on('on-battery', arm);
  powerMonitor.on('on-ac', arm);
  arm();
}

// 设置变更后重排
function restart() {
  arm();
}

module.exports = { start, restart, tick, onBattery, getLastFound: () => lastFound };
