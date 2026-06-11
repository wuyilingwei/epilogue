'use strict';
// 诊断日志：userData/logs/epilogue.log。请求级低频写入（appendFileSync 可接受），
// 写失败静默 —— 日志永不影响主流程。>2MB 轮转为 .old 保留一份。
// 不得记录任何 apiKey / 文件内容正文。
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
let dir = null;
let lineCount = 0;

function logDir() {
  if (!dir) {
    const { app } = require('electron'); // lazy：format 等纯函数可在纯 node 下单测
    dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function logFile() {
  return path.join(logDir(), 'epilogue.log');
}

function format(scope, msg, extra) {
  return `${new Date().toISOString()} [${scope}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(logFile()).size > MAX_BYTES) fs.renameSync(logFile(), `${logFile()}.old`);
  } catch {
    /* 首次运行无文件 */
  }
}

function log(scope, msg, extra) {
  const line = format(scope, msg, extra);
  try {
    if (++lineCount % 100 === 1) rotateIfNeeded(); // 低频检查即可
    fs.appendFileSync(logFile(), line + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
  try {
    if (!require('electron').app?.isPackaged) console.log(line);
  } catch {
    /* 非 electron 环境（单测） */
  }
}

module.exports = { log, format, logFile };
