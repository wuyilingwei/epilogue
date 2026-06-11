'use strict';
// 本机模型客户端：实际推理在 modelHost.js（utilityProcess 子进程）中执行，
// OOM/崩溃只损失子进程，主应用自动重启它。status/remove 为纯文件操作，留在主进程。
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

// 转码精度 → whisper 模型映射（默认推荐低）
const WHISPER_QUALITY = {
  low: 'Xenova/whisper-tiny',
  high: 'Xenova/whisper-small',
};
const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';

function cacheDir() {
  return path.join(app.getPath('userData'), 'models');
}

/* ---------- 子进程管理 ---------- */
let child = null;
let seq = 0;
const pending = new Map(); // id -> {resolve, reject}
const progressListeners = new Set();

function ensureChild() {
  if (child) return child;
  const settings = require('./settings');
  child = utilityProcess.fork(path.join(__dirname, 'modelHost.js'), [], {
    serviceName: 'epilogue-models',
    env: {
      ...process.env,
      EPILOGUE_MODELS_DIR: cacheDir(),
      EPILOGUE_HF_MIRROR: settings.get().app.hfMirror || '',
      EPILOGUE_IMG_DEVICE: settings.get().imageEmbed?.device || 'auto',
    },
  });
  child.on('message', (msg) => {
    if (msg.hostlog) {
      require('./log').log('models', msg.hostlog.msg, msg.hostlog.extra);
      return;
    }
    if (msg.progress) {
      for (const cb of progressListeners) cb(msg.progress);
      return;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    }
  });
  child.on('exit', () => {
    child = null;
    // 子进程意外退出（大概率推理 OOM）：拒绝所有挂起调用，下次调用自动重启
    require('./log').log('models', 'host exited', { pendingCalls: pending.size });
    for (const p of pending.values()) p.reject(new Error('模型进程已退出（可能内存不足），将自动重启，请重试'));
    pending.clear();
  });
  return child;
}

function call(op, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ensureChild().postMessage({ id, op, args });
  });
}

// 设置（镜像）变更或删除模型后重启子进程，释放其内存中的 pipeline
function restartHost() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    child = null;
  }
}

// 托盘纯保活（046）：关窗时若子进程空闲则关停，释放其缓存的模型内存；下次调用自动拉起。
// 忙（Solo/定时任务推理中）则跳过，不打断。
function idleShutdown() {
  if (!child || pending.size > 0) return;
  restartHost();
  require('./log').log('models', 'host shut down (tray idle)');
}

/* ---------- 支持文件状态/删除（纯 fs，主进程） ---------- */
function modelDirs(model) {
  return [path.join(cacheDir(), model), path.join(cacheDir(), `models--${model.replace('/', '--')}`)];
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

// 目录内（递归）是否存在 onnx 模型文件：transformers.js 整文件写盘，下载中断只会缺 onnx 大文件，
// 已写入的 config/tokenizer 均完整 —— 仅凭目录存在判「已下载」会把半截下载误判为就绪
function dirHasOnnx(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dirHasOnnx(p)) return true;
    } else if (e.name.endsWith('.onnx')) {
      return true;
    }
  }
  return false;
}

function status(model) {
  for (const dir of modelDirs(model)) {
    try {
      if (fs.statSync(dir).isDirectory() && dirHasOnnx(dir)) return { downloaded: true, sizeBytes: dirSize(dir) };
    } catch {
      /* 不存在，试下一个 */
    }
  }
  return { downloaded: false, sizeBytes: 0 };
}

function remove(model) {
  // 子进程空闲才重启释放内存；忙（他人正在下载/推理）时仅从其缓存剔除该 pipeline，不打断进行中的调用
  if (pending.size === 0) {
    restartHost();
  } else {
    call('unload', model).catch(() => {});
  }
  for (const dir of modelDirs(model)) fs.rmSync(dir, { recursive: true, force: true });
  return status(model);
}

/* ---------- 推理/下载（子进程） ---------- */
async function download(task, model, onProgress) {
  const { log } = require('./log');
  log('models', `download start: ${model}`, { task });
  const t0 = Date.now();
  if (onProgress) progressListeners.add(onProgress);
  try {
    await call('download', task, model);
    log('models', `download done: ${model}`, { ms: Date.now() - t0 });
  } catch (e) {
    log('models', `download failed: ${model}`, { error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 });
    throw e;
  } finally {
    if (onProgress) progressListeners.delete(onProgress);
  }
  return status(model);
}

function embed(texts, model = DEFAULT_EMBED_MODEL) {
  return call('embed', texts, model);
}

function transcribe(model, filePath, maxSeconds = 300) {
  return call('transcribe', model || WHISPER_QUALITY.low, filePath, maxSeconds);
}

// 内容提取走子进程（nice 19 + 崩溃隔离），主进程不再被 adm-zip 等同步重活阻塞
function extractRemote(filePath, opts) {
  return call('extract', filePath, opts);
}

// 图形 embedding（CLIP，子进程推理）
function imageEmbed(filePaths, model) {
  return call('imageEmbed', filePaths, model);
}
function clipTextEmbed(texts, model) {
  return call('clipTextEmbed', texts, model);
}

module.exports = {
  status, download, remove, embed, transcribe, extractRemote, imageEmbed, clipTextEmbed,
  restartHost, idleShutdown, dirHasOnnx, WHISPER_QUALITY, DEFAULT_EMBED_MODEL,
};
