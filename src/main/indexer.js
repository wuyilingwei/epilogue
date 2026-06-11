'use strict';
// 索引流水线：提取内容 → LLM 摘要+关键词 → 向量化 → 入库
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const settings = require('./settings');
const { kindOf } = require('./extractors'); // extract 本体在 modelHost 子进程执行（032）
const { transcribeMedia } = require('./media');

const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB 以上直接跳过

// 预处理全程本地、零 chat 调用：摘要=内容预览，关键词=文件名分词+内容高频词
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'you', 'your', '的', '了', '和', '是', '在', '我们', '一个', '以及', '或者', '不会', '可以', '没有']);

function localMeta(content, fileName, filePath = '') {
  const summary = (content || '').slice(0, 200);
  const freq = new Map();
  const baseName = fileName.replace(/\.[^.]+$/, '');
  // 文件名词优先计权
  for (const m of baseName.matchAll(/[A-Za-z0-9]{2,}|[一-鿿]{2,}/g)) freq.set(m[0].toLowerCase(), 5);
  // 路径目录名（最后 3 级）也是强归属线索（「回归线/2023-12/xx.docx」的「回归线」）
  const parentDirs = path.dirname(filePath).split(/[\\/]/).filter(Boolean).slice(-3).join(' ');
  for (const m of parentDirs.matchAll(/[A-Za-z0-9]{2,}|[一-鿿]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 3);
  }
  for (const m of (content || '').slice(0, 6000).matchAll(/[A-Za-z][A-Za-z0-9]{2,}|[一-鿿]{2,6}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);
  return { summary, keywords };
}

async function indexFile(filePath, store, onProgress = () => {}, { manual = false, nameOnly = false } = {}) {
  const { log } = require('./log');
  const t0 = Date.now();
  const cfg = settings.get();
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) throw new Error('文件超过 2GB，跳过');

  // 1. 提取文本（media 走 whisper）；nameOnly：只索引文件名，不读内容（云占位文件读内容会触发下载）
  const kind = kindOf(filePath);
  let content = '';
  let transcript = '';
  if (nameOnly) {
    onProgress({ file: fileName, stage: '文件名索引…' });
  } else if (kind === 'media') {
    onProgress({ file: fileName, stage: '转写音视频 (Whisper)…' });
    // 低功耗 + 电池供电：仅对后台/自动任务暂缓重型转写；用户手动发起的不受限
    if (cfg.app.lowPower && !manual) {
      const { powerMonitor } = require('electron');
      if (powerMonitor.isOnBatteryPower()) throw new Error('电池模式下暂缓音视频转写（接通电源后重试）');
    }
    transcript = await transcribeMedia(cfg.providers.transcription, filePath, { sttMaxSeconds: cfg.extraction.sttMaxSeconds });
    content = transcript.slice(0, cfg.extraction.maxChars);
  } else {
    onProgress({ file: fileName, stage: '提取内容…' });
    // 提取在 modelHost 子进程执行（nice 19、崩溃隔离），主进程事件循环不被同步解析阻塞
    const localModels = require('./localModels');
    content = (await localModels.extractRemote(filePath, cfg.extraction)).content;
  }

  // 2. 本地摘要 + 关键词（不调 AI）
  onProgress({ file: fileName, stage: '提取关键词…' });
  const meta = localMeta(content, fileName, filePath);

  // 3. 向量化（embeddings 未配置则留空，检索自动降级关键词匹配）
  let vector = null;
  // 图像：启用图形 embedding 且 CLIP 模型已下载 → 视觉向量（512 维，与 BGE 维度隔离）
  if (kind === 'image' && !nameOnly && cfg.imageEmbed?.enabled) {
    const localModels = require('./localModels');
    if (localModels.status(cfg.imageEmbed.model).downloaded) {
      onProgress({ file: fileName, stage: '图像向量化…' });
      try {
        [vector] = await localModels.imageEmbed([filePath], cfg.imageEmbed.model);
      } catch (e) {
        log('index', `image embed failed: ${fileName}`, { error: String(e.message || e).slice(0, 200) });
        vector = null;
      }
    }
  }
  const network = require('./network');
  const embProviders = llm.localOnlyFilter(cfg.providers.embeddings, cfg.app.avoidCloudOnMetered && network.isMetered());
  // 二进制等非文档文件（无可提取文本）不做 embedding，仅靠文件名+摘要可检索；
  // nameOnly 模式用文件名本身做向量（文件名也能参与语义检索）
  const hasText = Boolean(content || transcript) || nameOnly;
  if (!vector && hasText && llm.embeddingsConfigured(embProviders)) {
    onProgress({ file: fileName, stage: '向量化…' });
    try {
      // 末两级目录名进向量文本：文件夹归属也参与语义检索
      const dirHint = path.dirname(filePath).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
      const text = nameOnly ? `${dirHint}/${fileName}` : `${dirHint}/${fileName}\n${(content || transcript).slice(0, 2000)}`;
      [vector] = await llm.embedF(embProviders, [text]);
    } catch (e) {
      log('index', `embed failed: ${fileName}`, { error: String(e.message || e).slice(0, 200) });
      vector = null;
    }
  }

  // 4. 入库
  const record = store.upsert({
    filePath,
    fileName,
    kind,
    summary: meta.summary || '',
    keywords: meta.keywords || [],
    transcriptPreview: transcript.slice(0, 500),
    vector,
    sizeBytes: stat.size,
    fileMtime: stat.mtimeMs, // 文件日期，供 Library 滑条筛选
    indexedMode: nameOnly ? 'name' : 'full', // name = 仅文件名（云占位等），将来允许读内容时可升级重索
    indexedAt: new Date().toISOString(),
  });
  onProgress({ file: fileName, stage: '完成' });
  log('index', `indexed: ${fileName}`, { kind, sizeBytes: stat.size, hasVector: Boolean(vector), ms: Date.now() - t0 });
  return record;
}

function listFiles(dir, recursive, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) listFiles(p, recursive, acc);
    } else if (entry.isFile()) {
      acc.push(p);
    }
  }
  return acc;
}

// 让出一拍事件循环：提取含同步重操作（adm-zip 等），让步保证进度 IPC 先投递到渲染层再开始干活
const yieldLoop = () => new Promise((r) => setImmediate(r));

async function indexFolder(dir, store, { recursive = true, onProgress = () => {}, manual = false } = {}) {
  const files = listFiles(dir, recursive);
  const results = { ok: 0, failed: 0, errors: [] };
  for (let i = 0; i < files.length; i++) {
    onProgress({ current: i + 1, total: files.length, file: path.basename(files[i]) });
    await yieldLoop();
    try {
      await indexFile(files[i], store, (p) => onProgress({ current: i + 1, total: files.length, ...p }), { manual });
      results.ok++;
    } catch (e) {
      results.failed++;
      results.errors.push({ file: files[i], error: e.message });
    }
  }
  return results;
}

// 增量索引：归类目标 ∪ 清理来源文件夹（未归档文件提前入索引——寻物可覆盖，归类免现场索引开销）。
// 文件名必索；内容/云内容按 perFolder 路径配置（来源未配置默认全文）。每轮限额防独占。
async function indexDestinations(store, { onProgress = () => {}, limit = 50 } = {}) {
  const { log } = require('./log');
  const cfg = settings.get();
  // 清理来源：仅用户启用的条目（无隐式回退——下载/桌面由 seed 添加为未启用，由用户决定）
  const sources = cfg.cleanup.folders.filter((f) => f.enabled !== false).map((f) => f.path);
  const roots = [...new Set([...cfg.destinations, ...sources])].filter(Boolean);
  if (!roots.length) return { ok: 0, failed: 0 };
  const cloudRoots = (cfg.recordedFolders || []).map((f) => f.path).filter(Boolean);
  const isCloud = (p) => cloudRoots.some((root) => p === root || p.startsWith(root + path.sep));
  const perFolder = cfg.destIndex.perFolder || {};
  const results = { ok: 0, failed: 0 };
  let budget = limit;
  for (const dest of roots) {
    const pf = perFolder[dest] || {};
    const contentAllowed = pf.content !== false; // 内容索引按目标文件夹单独控制（缺省开）
    const cloudAllowed = pf.cloud === true; // 云同步文件内容索引按文件夹单独控制（缺省关）
    let files = [];
    try {
      files = listFiles(dest, true);
    } catch {
      continue; // 目标不存在/无权限，跳过
    }
    for (const f of files) {
      if (budget <= 0) {
        log('destIndex', 'budget exhausted, resuming next pass', results);
        return results;
      }
      const wantFull = contentAllowed && (!isCloud(f) || cloudAllowed);
      const existing = store.get(f);
      if (existing && !(existing.indexedMode === 'name' && wantFull)) continue; // 已满足（或无需升级），跳过
      budget--;
      try {
        await indexFile(f, store, onProgress, { nameOnly: !wantFull });
        results.ok++;
      } catch (e) {
        results.failed++;
        log('destIndex', `failed: ${path.basename(f)}`, { error: String(e.message || e).slice(0, 120) });
      }
      await yieldLoop();
    }
  }
  if (results.ok || results.failed) log('destIndex', 'pass done', results);
  return results;
}

module.exports = { indexFile, indexFolder, indexDestinations, listFiles, yieldLoop, localMeta };
