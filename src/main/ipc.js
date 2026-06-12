'use strict';
// 所有 IPC handler 注册。重模块（llm/vectorstore/indexer/classifier/stale）handler 内 lazy require ——
// 托盘静默启动不加载（044 轻量化）。
const { ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const settings = require('./settings');

const lazy = {
  get llm() { return require('./llm'); },
  get indexer() { return require('./indexer'); },
  get classifier() { return require('./classifier'); },
  get stale() { return require('./stale'); },
};

let store;

function getStore() {
  if (!store) {
    const { VectorStore } = require('./vectorstore');
    store = new VectorStore(path.join(app.getPath('userData'), 'index.json'));
  }
  return store;
}

// 托盘驻留不持数据（044）：窗口关闭时落盘并卸载，GUI 重开 / 定时任务到点经 getStore() 惰性重建
function unloadStore() {
  if (!store) return;
  store.flush();
  require('./log').log('app', 'store unloaded (tray idle)', { records: store.stats().total });
  store = null;
}

// 寻物三模式：keyword 纯关键字 / match embedding 匹配度（只出命中与分数）/ ai 检索 + LLM 总结
async function ask(question, mode = 'ai') {
  const cfg = settings.get();
  const s = getStore();
  const network = require('./network');
  // 计费网络时只用本机 embedding
  const embProviders = lazy.llm.localOnlyFilter(cfg.providers.embeddings, cfg.app.avoidCloudOnMetered && network.isMetered());
  let hits = [];
  let usedVector = false;
  const wantVector = mode !== 'keyword';
  if (wantVector && lazy.llm.embeddingsConfigured(embProviders)) {
    try {
      const [qv] = await lazy.llm.embedF(embProviders, [question]);
      hits = s.searchByVector(qv, 8);
      usedVector = hits.length > 0;
    } catch {
      /* embedding 失败 → 退回关键词 */
    }
  }
  // 图形 embedding：CLIP 文本向量检索图片向量（512 维只配图片记录），与文本命中合并去重
  if (wantVector && cfg.imageEmbed?.enabled) {
    try {
      const localModels = require('./localModels');
      if (localModels.status(cfg.imageEmbed.model).downloaded) {
        const [iv] = await localModels.clipTextEmbed([question], cfg.imageEmbed.model);
        const imgHits = s.searchByVector(iv, 8).filter((h) => !hits.some((x) => x.record.filePath === h.record.filePath));
        hits = [...hits, ...imgHits].slice(0, 10);
        usedVector = usedVector || imgHits.length > 0;
      }
    } catch {
      /* CLIP 检索失败不影响文本检索结果 */
    }
  }
  if (!hits.length) hits = s.searchByKeywords(question, 8);
  const usedMode = usedVector ? 'vector' : 'keyword';
  if (!hits.length) return { answer: null, hits: [], mode: usedMode };

  // keyword / match 模式不调 LLM，直接返回命中列表
  if (mode !== 'ai') {
    return { answer: null, hits: hits.map((h) => ({ ...h.record, vector: undefined, score: h.score })), mode: usedMode };
  }

  let answer = '';
  try {
    const today = new Date().toISOString().slice(0, 10);
    answer = await lazy.llm.chatF(cfg.providers.chat, [
      {
        role: 'system',
        content:
          `今天是 ${today}。用户在找自己之前存放的文件。候选文件带 modified（修改日期）——` +
          '「去年」「上个月」等相对时间请以今天为基准换算后比对。' +
          '根据候选文件列表回答文件在哪里（给出完整路径），说明为什么是它（路径中的文件夹名也是有效线索）；' +
          '若候选都不像，直说没找到并给最接近的。用用户提问的语言回答，简洁。',
      },
      {
        role: 'user',
        content: `问题: ${question}\n候选文件:\n${JSON.stringify(
          hits.map((h) => ({
            path: h.record.filePath,
            modified: h.record.fileMtime ? new Date(h.record.fileMtime).toISOString().slice(0, 10) : undefined,
            summary: h.record.summary,
            keywords: h.record.keywords,
            score: +h.score.toFixed(3),
          })),
          null,
          1
        )}`,
      },
    ]);
  } catch (e) {
    answer = `（LLM 总结失败: ${e.message.slice(0, 160)}，以下为原始检索结果）`;
  }
  return { answer, hits: hits.map((h) => ({ ...h.record, vector: undefined, score: h.score })), mode: usedMode };
}

function register(getWindow, hooks = {}) {
  const progress = (channel) => (p) => getWindow()?.webContents.send(channel, p);

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const cfg = settings.set(patch);
    hooks.onSettingsChanged?.(cfg); // 应用开机启动、重排定时扫描等
    return cfg;
  });

  ipcMain.handle('folders:detect', () => {
    const detected = require('./specialFolders').detect();
    // 记录到配置（去重合并）
    const recorded = settings.get().recordedFolders;
    const merged = [...recorded];
    for (const f of detected) if (!merged.some((r) => r.path === f.path)) merged.push(f);
    settings.set({ recordedFolders: merged });
    settings.seedCleanupFolders(); // 下载/桌面 → 清理列表（未启用，由用户决定）
    return merged;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('index:folder', (_e, dir, recursive) =>
    lazy.indexer.indexFolder(dir, getStore(), { recursive, onProgress: progress('index:progress'), manual: true })
  );
  ipcMain.handle('index:files', async (_e, filePaths) => {
    const results = { ok: 0, failed: 0, errors: [] };
    for (let i = 0; i < filePaths.length; i++) {
      progress('index:progress')({ current: i + 1, total: filePaths.length, file: path.basename(filePaths[i]) });
      await lazy.indexer.yieldLoop(); // 进度先投递再干活（提取含同步重操作）
      try {
        await lazy.indexer.indexFile(
          filePaths[i],
          getStore(),
          (p) => progress('index:progress')({ current: i + 1, total: filePaths.length, ...p }),
          { manual: true }
        );
        results.ok++;
      } catch (e) {
        results.failed++;
        results.errors.push({ file: filePaths[i], error: e.message });
      }
    }
    return results;
  });

  ipcMain.handle('store:stats', () => getStore().stats());
  // 列表瘦身：vector / transcriptPreview 渲染层用不到，不进 IPC
  const { hasVec } = require('./vectorstore');
  ipcMain.handle('store:list', () =>
    getStore().all().map((r) => ({ ...r, vector: undefined, transcriptPreview: undefined, hasVector: hasVec(r) }))
  );
  // 总览「最近索引」专用：主进程排序+切片，避免全量传输
  ipcMain.handle('store:recent', (_e, n = 8) =>
    [...getStore().all()]
      .sort((a, b) => (b.indexedAt || '').localeCompare(a.indexedAt || ''))
      .slice(0, n)
      .map((r) => ({ filePath: r.filePath, fileName: r.fileName, kind: r.kind, summary: r.summary }))
  );
  ipcMain.handle('store:remove', (_e, filePath) => getStore().remove(filePath));

  ipcMain.handle('search:ask', (_e, question, mode) => ask(question, mode));

  // 手动触发归类目标额外索引（跑完为止，不设上限；定时 pass 仍限 50/轮）
  ipcMain.handle('dest:index', () =>
    lazy.indexer.indexDestinations(getStore(), { onProgress: progress('index:progress'), limit: Number.MAX_SAFE_INTEGER })
  );

  // 内置助手对话（history: [{role, content}]）
  ipcMain.handle('assistant:chat', (_e, history) => {
    const assistant = require('./assistant');
    return assistant.chatTurn(Array.isArray(history) ? history : [], hooks);
  });

  // 本机模型支持文件：状态 / 手动下载（带进度推送）/ 删除
  ipcMain.handle('model:status', (_e, model) => {
    const localModels = require('./localModels');
    return localModels.status(model);
  });
  ipcMain.handle('model:download', (_e, task, model) => {
    const localModels = require('./localModels');
    return localModels.download(task, model, (p) => progress('model:progress')(p));
  });
  ipcMain.handle('model:delete', (_e, model) => {
    const localModels = require('./localModels');
    return localModels.remove(model);
  });

  // 临时指定文件夹扫描
  ipcMain.handle('stale:scan', (_e, dirs, days) => {
    const cfg = settings.get();
    return lazy.stale.scan(dirs, days ?? cfg.staleDays);
  });
  // 按 cleanup 配置扫描全部清理文件夹（每文件夹独立天数/规则）
  ipcMain.handle('cleanup:scan', () => lazy.stale.scanCleanup(settings.get()));
  ipcMain.handle('power:status', () => {
    const { powerMonitor } = require('electron');
    return { onBattery: powerMonitor.isOnBatteryPower() };
  });
  // 渲染层上报网络是否按流量计费（navigator.connection best-effort）
  ipcMain.handle('network:report', (_e, metered) => {
    require('./network').setMetered(metered);
  });

  // items: 字符串路径 或 {filePath, rules}（cleanup 文件夹的单独规则）
  ipcMain.handle('classify:suggest', async (_e, items) => {
    const s = getStore();
    const norm = items.map((i) => (typeof i === 'string' ? { filePath: i } : i));
    const records = [];
    const failed = []; // 单文件索引失败不阻塞整批：以「无目标+原因」行返回
    for (let i = 0; i < norm.length; i++) {
      let r = s.get(norm[i].filePath);
      if (!r) {
        progress('index:progress')({ current: i + 1, total: norm.length, file: path.basename(norm[i].filePath), stage: '先索引…' });
        await lazy.indexer.yieldLoop(); // 进度先投递再干活
        try {
          r = await lazy.indexer.indexFile(
            norm[i].filePath,
            s,
            (p) => progress('index:progress')({ current: i + 1, total: norm.length, ...p }),
            { manual: true } // 手动归类不受电池暂缓限制
          );
        } catch (e) {
          require('./log').log('classify', `index failed, skipped: ${path.basename(norm[i].filePath)}`, { error: String(e.message || e).slice(0, 200) });
          failed.push({ filePath: norm[i].filePath, fileName: path.basename(norm[i].filePath), move: false, reason: `索引失败：${e.message}` });
          continue;
        }
      }
      records.push({ ...r, rulesOverride: norm[i].rules || null });
    }
    // AI 归类阶段也推进度（替代渲染层干等「分析文件内容…」）
    const out = records.length ? await lazy.classifier.suggest(records, (p) => progress('index:progress')(p)) : [];
    return [...out, ...failed];
  });
  ipcMain.handle('classify:apply', (_e, moves) => lazy.classifier.applyMoves(moves, getStore()));

  // provider 连通性测试（渲染层传行内当前值，未保存的 Key 也能测）
  ipcMain.handle('provider:test', (_e, type, provider) => lazy.llm.testProvider(type, provider));

  ipcMain.handle('models:list', async (_e, which) => {
    const cfg = settings.get();
    const first = (cfg.providers[which] || []).find((p) => lazy.llm.usable(p));
    if (!first) throw new Error('该类型没有可用 provider');
    return lazy.llm.listModels(first);
  });

  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

  // 关于页：版本信息（047，对齐 ../IRIS 方案）
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }));

  // 内置文档（048：打包后用户无项目文件，条款/许可证全文随包内置查看；051：条款为纯文本零渲染）
  const DOCS = { terms: 'TERMS.txt', license: 'LICENSE' };
  ipcMain.handle('app:doc', (_e, name) => {
    const file = DOCS[name];
    if (!file) throw new Error('unknown doc');
    return require('fs').readFileSync(path.join(app.getAppPath(), file), 'utf8');
  });

  // 诊断日志：在文件管理器中定位 userData/logs/epilogue.log
  ipcMain.handle('log:reveal', () => {
    const { log, logFile } = require('./log');
    log('app', 'log revealed by user');
    shell.showItemInFolder(logFile());
  });

  // 存储占用：索引 / 日志 / 模型 / 应用本体
  const fs = require('fs');
  function dirSizeSafe(dir) {
    let total = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        total += e.isDirectory() ? dirSizeSafe(p) : fs.statSync(p).size;
      }
    } catch {
      /* 目录不存在/无权限 */
    }
    return total;
  }
  ipcMain.handle('storage:stats', () => {
    const s = getStore();
    const userData = app.getPath('userData');
    let indexBytes = 0;
    for (const f of ['index.json', 'vectors.bin']) {
      try {
        indexBytes += fs.statSync(path.join(userData, f)).size;
      } catch {
        /* 尚未建库 */
      }
    }
    // 应用本体：打包后取安装目录（mac 为 .app 根）；开发模式不遍历 node_modules，标记 dev。
    // 安装目录数万文件、同步遍历昂贵且运行期不变 —— 模块级缓存只算一次（042：启动期重复遍历曾把主进程堆顶到上限）
    let appBytes = null;
    if (app.isPackaged) {
      if (register.appBytesCache === undefined) {
        const root = process.platform === 'darwin' ? path.resolve(app.getPath('exe'), '..', '..', '..') : path.dirname(app.getPath('exe'));
        register.appBytesCache = dirSizeSafe(root);
      }
      appBytes = register.appBytesCache;
    }
    return {
      index: { bytes: indexBytes, total: s.stats().total, byKind: s.kindStats(), path: path.join(userData, 'index.json') },
      logs: { bytes: dirSizeSafe(path.join(userData, 'logs')), path: path.join(userData, 'logs') },
      models: { bytes: dirSizeSafe(path.join(userData, 'models')), path: path.join(userData, 'models') },
      app: { bytes: appBytes },
    };
  });
  // 按文件类型清理索引记录（不动原文件，重新索引可恢复）
  ipcMain.handle('storage:cleanKind', (_e, kind) => {
    const removed = getStore().removeKind(String(kind));
    getStore().flush();
    require('./log').log('app', `index records cleaned by kind: ${kind}`, { removed });
    return removed;
  });
  ipcMain.handle('log:clear', () => {
    const { logFile, log } = require('./log');
    for (const f of [logFile(), `${logFile()}.old`]) fs.rmSync(f, { force: true });
    log('app', 'log cleared by user');
  });
}

// ask/getStore 供 assistant 复用；flushStore 供退出前落盘（向量库写盘已防抖）；unloadStore 托盘卸载（044）
module.exports = { register, ask, getStore, unloadStore, flushStore: () => store?.flush() };
