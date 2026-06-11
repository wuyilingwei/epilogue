'use strict';
// 音视频转写：默认本机 Whisper（离线、不上传）；可配置 OpenAI-compatible 云端作灾备。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const llm = require('./llm');

const UPLOAD_LIMIT = 24 * 1024 * 1024; // 云端转写接口限制 25MB，留余量
const DIRECT_OK = new Set(['.mp3', '.m4a', '.wav', '.webm', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.flac']);

function ffmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

function toAudio(input) {
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg 不可用，且文件无法直接上传转写（过大或格式不支持）');
  const out = path.join(os.tmpdir(), `epologue_${Date.now()}.mp3`);
  return new Promise((resolve, reject) => {
    const child = execFile(
      ff,
      ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out],
      { timeout: 10 * 60 * 1000 },
      (err) => (err ? reject(new Error(`ffmpeg 抽取音轨失败: ${err.message}`)) : resolve(out))
    );
    try {
      os.setPriority(child.pid, 19); // 重活给最低优先级，别抢前台
    } catch {
      /* 平台不支持则忽略 */
    }
  });
}

// 云端 OpenAI-compatible 转写
async function transcribeApi(provider, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const size = fs.statSync(filePath).size;
  let uploadPath = filePath;
  let temp = null;
  if (!DIRECT_OK.has(ext) || size > UPLOAD_LIMIT) {
    temp = await toAudio(filePath);
    uploadPath = temp;
    if (fs.statSync(temp).size > UPLOAD_LIMIT) {
      fs.rmSync(temp, { force: true });
      throw new Error('音轨压缩后仍超过 24MB 上传限制（音频过长）');
    }
  }
  try {
    return await llm.transcribe(provider, uploadPath);
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}

// providers 数组灾备：type==='local' 走本机 whisper（utilityProcess 子进程隔离），其余走 API
// opts.sttMaxSeconds：本机转写只跑开头 N 秒（默认 5 分钟）
function transcribeMedia(providers, filePath, opts = {}) {
  return llm.withFailover(providers, (p) => {
    if (p.type === 'local') {
      const localModels = require('./localModels'); // 懒加载
      return localModels.transcribe(p.model, filePath, opts.sttMaxSeconds ?? 300);
    }
    return transcribeApi(p, filePath);
  });
}

module.exports = { transcribeMedia };
