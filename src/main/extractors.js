'use strict';
// 文本内容提取：压缩包 / Office / PDF / 纯文本
const fs = require('fs');
const path = require('path');

const MAX_CHARS = 12000; // 送入 LLM 的内容上限（默认，可被 extraction 配置覆盖）
const HEAD_CHARS = 3000; // 「只读开头」模式的上限

// 提取上限：adm-zip / readFileSync 为同步操作，超大文件会阻塞主进程事件循环（进度 IPC 投递不出，UI 形同卡死）
const LIMITS = {
  archiveBytes: 100 * 1024 * 1024, // 超过则跳过压缩包内容解析，仅按文件名归类
  pdfBytes: 50 * 1024 * 1024, // 超过则跳过 PDF 解析
  textHeadBytes: 256 * 1024, // 文本类只读开头（maxChars 12000 字符绰绰有余）
};

const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html', '.yml', '.yaml', '.ini']);
const ARCHIVE_EXTS = new Set(['.zip', '.epub', '.jar']);
const MEDIA_EXTS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.mpeg', '.mpg']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function kindOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (ext === '.pdf') return 'pdf';
  if (MEDIA_EXTS.has(ext)) return 'media';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'other';
}

function clip(text, max = MAX_CHARS) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 只读文件开头 N 字节（utf8 尾部多字节截断由 toString 容忍，clip 后无碍）
function readHead(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ZIP 文件名编码：规范默认本地编码（中文 Windows = GBK），仅 flag bit 11（EFS）置位才保证 UTF-8。
// adm-zip 一律按 UTF-8 解码 → GBK 名字成乱码。按 EFS → 合法 UTF-8 → GBK 的顺序解码。
function decodeEntryName(entry) {
  if (entry.header.flags & 0x800) return entry.entryName; // EFS：显式 UTF-8
  const raw = entry.rawEntryName;
  if (!Buffer.isBuffer(raw)) return entry.entryName;
  const utf8 = raw.toString('utf8');
  if (!utf8.includes('�')) return utf8; // 无 flag 但实为合法 UTF-8（macOS 归档常见）
  try {
    return new TextDecoder('gbk').decode(raw); // Node/Electron 内置 full-ICU
  } catch {
    return utf8;
  }
}

function extractArchive(filePath) {
  if (fs.statSync(filePath).size > LIMITS.archiveBytes) {
    // adm-zip 是同步 API，超大包解析会阻塞主进程 —— 跳过内容，仍可按文件名归类/检索
    return `压缩包过大（>${Math.round(LIMITS.archiveBytes / 1048576)}MB），已跳过内容识别，仅按文件名归类。`;
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const names = entries.filter((e) => !e.isDirectory).map((e) => decodeEntryName(e));
  // 顺带读取压缩包内的小文本文件，丰富语义
  let inlineText = '';
  for (const e of entries) {
    if (e.isDirectory || inlineText.length > 4000) continue;
    const name = decodeEntryName(e);
    const ext = path.extname(name).toLowerCase();
    if (TEXT_EXTS.has(ext) && e.header.size < 64 * 1024) {
      try {
        inlineText += `\n--- ${name} ---\n${e.getData().toString('utf8').slice(0, 2000)}`;
      } catch {
        /* 加密或损坏的条目，跳过 */
      }
    }
  }
  return clip(`压缩包内容清单(${names.length} 个文件): ${names.slice(0, 300).join(', ')}\n${inlineText}`);
}

async function extractOffice(filePath, opts) {
  const { parseOfficeAsync } = require('officeparser');
  const text = await parseOfficeAsync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  // Excel 识别模式：headers = 仅表头与前几行
  if (['.xlsx', '.ods'].includes(ext) && opts.xlsxMode === 'headers') {
    return clip(text.split('\n').slice(0, 40).join('\n'), opts.maxChars);
  }
  // Word/PPT 读取模式：head = 只读开头
  if (opts.officeMode === 'head') return clip(text, Math.min(HEAD_CHARS, opts.maxChars));
  return clip(text, opts.maxChars);
}

async function extractPdf(filePath, opts) {
  if (fs.statSync(filePath).size > LIMITS.pdfBytes) return ''; // 异常巨型 PDF：跳过，凭文件名检索
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(fs.readFileSync(filePath), { max: opts.pdfMaxPages });
  return clip(data.text, opts.maxChars);
}

function extractText(filePath, opts) {
  // 不整读：.csv/.log/.json 可达 GB 级，readFileSync 整读 + utf8 解码会阻塞主进程分钟级
  return clip(readHead(filePath, LIMITS.textHeadBytes), opts.maxChars);
}

const DEFAULT_OPTS = { officeMode: 'full', xlsxMode: 'full', pdfMaxPages: 30, maxChars: MAX_CHARS };

// 返回 {kind, content}；media 类型由 media.js 单独处理。opts 来自 settings.extraction。
async function extract(filePath, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const kind = kindOf(filePath);
  switch (kind) {
    case 'archive':
      return { kind, content: clip(extractArchive(filePath), o.maxChars) };
    case 'office':
      return { kind, content: await extractOffice(filePath, o) };
    case 'pdf':
      return { kind, content: await extractPdf(filePath, o) };
    case 'text':
      return { kind, content: extractText(filePath, o) };
    default:
      return { kind, content: '' };
  }
}

module.exports = { extract, kindOf, MEDIA_EXTS, MAX_CHARS, LIMITS, decodeEntryName };
