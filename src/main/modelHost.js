'use strict';
// 模型宿主子进程（utilityProcess）：ONNX 推理、模型下载、ffmpeg 解码全在这里跑。
// 即使推理 OOM 崩溃也只损失本进程，主应用无感。不得 require('electron') 主模块。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MODELS_DIR = process.env.EPILOGUE_MODELS_DIR;
const MIRROR = process.env.EPILOGUE_HF_MIRROR || '';

try {
  os.setPriority(19); // 推理进程整体最低优先级
} catch {
  /* 平台不支持 */
}

const { createAggregator } = require('../shared/progressAggregate');

const pipelines = new Map();
const clips = new Map(); // CLIP 组件缓存：model -> {processor, vision, tokenizer, text, RawImage}
const dlProgress = createAggregator();
let envApplied = false;

async function tf() {
  const m = await import('@huggingface/transformers');
  if (!envApplied) {
    m.env.cacheDir = MODELS_DIR;
    if (MIRROR) m.env.remoteHost = MIRROR;
    // 至少为系统保留一个核：numThreads ≤ min(2, cores-1)
    if (m.env.backends?.onnx?.wasm) m.env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(2, os.cpus().length - 1));
    envApplied = true;
  }
  return m;
}

function report(progress) {
  process.parentPort.postMessage({ progress });
}

// 子进程内不可用 log.js（依赖 electron app）→ 经父进程转写诊断日志
function hostlog(msg, extra) {
  try {
    process.parentPort.postMessage({ hostlog: { msg, extra } });
  } catch {
    /* 父进程已退出 */
  }
}

// GPU 加速：平台候选 EP（win32→dml / linux→cuda；darwin 无 node 端可靠 EP）。
// 加载失败永久回退 CPU（进程内记忆），不会让功能被不支持的 EP 卡死。
let gpuFailed = false;
function pickDevice() {
  if ((process.env.EPILOGUE_IMG_DEVICE || 'auto') === 'cpu' || gpuFailed) return null;
  if (process.platform === 'win32') return 'dml';
  if (process.platform === 'linux') return 'cuda';
  return null;
}

async function getPipeline(task, model) {
  const key = `${task}:${model}`;
  if (!pipelines.has(key)) {
    pipelines.set(
      key,
      (async () => {
        const { pipeline } = await tf();
        const pipe = await pipeline(task, model, {
          dtype: 'q8',
          device: 'cpu',
          // 关闭 ONNX 内存池：BFCArena 指数 Extend 正是 OOM 崩溃点（crash 2026-06-10）
          session_options: { enableCpuMemArena: false, enableMemPattern: false },
          progress_callback: (p) => {
            // 文件级进度 → 聚合为整体进度；percent=null 表示尚有文件 total 未知（UI 显示字节+流动条）
            if (p.status === 'initiate') {
              dlProgress.initiate(model, p.file);
            } else if (p.status === 'progress') {
              report(dlProgress.update(model, { file: p.file, loaded: p.loaded || 0, total: p.total || 0 }));
            }
          },
        });
        const fin = dlProgress.done(model);
        if (fin.total) report(fin); // 实际发生过下载才收口 100%（纯缓存加载不上报）
        return pipe;
      })().catch((e) => {
        pipelines.delete(key); // 失败不缓存，允许重试
        dlProgress.clear(model); // 聚合状态清零，重试从头算
        throw e;
      })
    );
  }
  return pipelines.get(key);
}

// CLIP 系图形 embedding：优先分离双塔（OpenAI CLIP 有 vision_model/text_model.onnx）；
// 失败回退统一 model.onnx（Chinese-CLIP 等）—— 取单侧向量时给 dummy 对侧输入，从输出取所需 embeds。
async function getClip(model) {
  if (!clips.has(model)) {
    clips.set(
      model,
      (async () => {
        const m = await tf();
        const progress_callback = (p) => {
          if (p.status === 'initiate') dlProgress.initiate(model, p.file);
          else if (p.status === 'progress') report(dlProgress.update(model, { file: p.file, loaded: p.loaded || 0, total: p.total || 0 }));
        };
        const session_options = { enableCpuMemArena: false, enableMemPattern: false };
        const load = async (device) => {
          const opts = { dtype: 'q8', session_options, progress_callback, ...(device ? { device } : { device: 'cpu' }) };
          const [processor, tokenizer] = await Promise.all([
            m.AutoProcessor.from_pretrained(model, opts),
            m.AutoTokenizer.from_pretrained(model, { progress_callback }),
          ]);
          try {
            const [vision, text] = await Promise.all([
              m.CLIPVisionModelWithProjection.from_pretrained(model, opts),
              m.CLIPTextModelWithProjection.from_pretrained(model, opts),
            ]);
            return { processor, tokenizer, vision, text, unified: null, RawImage: m.RawImage };
          } catch {
            const unified = await m.AutoModel.from_pretrained(model, opts);
            hostlog(`clip unified-model path: ${model}`);
            return { processor, tokenizer, vision: null, text: null, unified, RawImage: m.RawImage };
          }
        };
        let comp;
        const device = pickDevice();
        try {
          comp = await load(device);
          if (device) hostlog(`clip loaded on ${device}: ${model}`);
        } catch (e) {
          if (!device) throw e;
          gpuFailed = true; // GPU EP 不可用：永久回退 CPU
          hostlog(`gpu device ${device} failed, falling back to cpu`, { error: String(e.message || e).slice(0, 160) });
          comp = await load(null);
        }
        const fin = dlProgress.done(model);
        if (fin.total) report(fin);
        return comp;
      })().catch((e) => {
        clips.delete(model); // 失败不缓存，允许重试
        dlProgress.clear(model);
        throw e;
      })
    );
  }
  return clips.get(model);
}

function l2norm(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  const n = Math.sqrt(s) || 1;
  return Array.from(data, (v) => v / n);
}

function ffmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

// 任意音视频 → 16kHz 单声道 f32 PCM；maxSeconds 限制只解码开头一段
function decodeToPcm(input, maxSeconds) {
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg 不可用，无法解码音频');
  const out = path.join(os.tmpdir(), `epilogue_pcm_${process.hrtime.bigint()}.f32`);
  const limit = maxSeconds > 0 ? ['-t', String(maxSeconds)] : [];
  return new Promise((resolve, reject) => {
    const child = execFile(
      ff,
      ['-y', '-i', input, ...limit, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', out],
      { timeout: 10 * 60 * 1000 },
      (err) => {
        if (err) return reject(new Error(`ffmpeg 解码失败: ${err.message}`));
        try {
          const buf = fs.readFileSync(out);
          resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        } catch (e) {
          reject(e);
        } finally {
          fs.rmSync(out, { force: true });
        }
      }
    );
    try {
      os.setPriority(child.pid, 19);
    } catch {
      /* 平台不支持 */
    }
  });
}

const handlers = {
  // 下载支持文件 = 构建一次 pipeline / CLIP 组件（进度聚合与 100% 收口在构建函数内）
  async download(task, model) {
    if (task === 'clip-image') await getClip(model);
    else await getPipeline(task, model);
    return true;
  },
  // 仅从缓存剔除该模型的 pipeline（删除模型时子进程忙 → 不能重启打断他人下载，用这个代替）
  async unload(model) {
    for (const key of pipelines.keys()) {
      if (key.endsWith(`:${model}`)) pipelines.delete(key);
    }
    clips.delete(model);
    return true;
  },
  // 图像 → CLIP 视觉向量（L2 归一）；统一模型路径给 dummy 单字文本，取输出 image_embeds
  async imageEmbed(filePaths, model) {
    const c = await getClip(model);
    const out = [];
    for (const p of filePaths) {
      const img = await c.RawImage.read(p);
      const pixel = await c.processor(img);
      let image_embeds;
      if (c.vision) ({ image_embeds } = await c.vision(pixel));
      else ({ image_embeds } = await c.unified({ ...c.tokenizer(['一'], { padding: true, truncation: true }), ...pixel }));
      out.push(l2norm(image_embeds.data));
    }
    return out;
  },
  // 查询文本 → CLIP 文本向量（与图像同空间，搜图用；不能复用 BGE）；统一模型路径给 dummy 8×8 灰图
  async clipTextEmbed(texts, model) {
    const c = await getClip(model);
    const inputs = c.tokenizer(texts, { padding: true, truncation: true });
    let text_embeds;
    if (c.text) {
      ({ text_embeds } = await c.text(inputs));
    } else {
      const dummy = new c.RawImage(new Uint8ClampedArray(8 * 8 * 3).fill(128), 8, 8, 3);
      const pixel = await c.processor(dummy);
      ({ text_embeds } = await c.unified({ ...inputs, ...pixel }));
    }
    const dim = text_embeds.dims[text_embeds.dims.length - 1];
    const res = [];
    for (let i = 0; i < texts.length; i++) res.push(l2norm(text_embeds.data.slice(i * dim, (i + 1) * dim)));
    return res;
  },
  async embed(texts, model) {
    const pipe = await getPipeline('feature-extraction', model);
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  },
  async transcribe(model, filePath, maxSeconds) {
    const pipe = await getPipeline('automatic-speech-recognition', model);
    const audio = await decodeToPcm(filePath, maxSeconds);
    const out = await pipe(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
    return (out.text || '').trim();
  },
  // 内容提取（adm-zip 同步解析等重活）：在本低优先级子进程执行，主进程事件循环零阻塞
  async extract(filePath, opts) {
    const { extract } = require('./extractors'); // extractors 零 electron 依赖
    return extract(filePath, opts);
  },
};

process.parentPort.on('message', async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await handlers[op](...args);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
