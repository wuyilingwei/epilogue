'use strict';
// 过期文件扫描：找出 Downloads 等文件夹里长期未动的文件，供 AI 归类清理
const fs = require('fs');
const path = require('path');
const { kindOf } = require('./extractors');

const SKIP = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

function scanDir(dir, cutoff, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // 无权限或已消失
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isFile()) {
      try {
        const st = fs.statSync(p);
        // 取访问/修改两者较近者作为“最后被动过”的时间
        const lastTouched = Math.max(st.mtimeMs, st.atimeMs);
        if (lastTouched < cutoff) {
          acc.push({
            filePath: p,
            fileName: e.name,
            sizeBytes: st.size,
            mtime: st.mtimeMs,
            ageDays: Math.floor((Date.now() - lastTouched) / 86400000),
            kind: kindOf(p),
            sourceDir: dir,
          });
        }
      } catch {
        /* 跳过坏文件 */
      }
    }
    // 不递归子目录：过期清理聚焦散落在文件夹顶层的下载产物
  }
  return acc;
}

// dirs: 要扫描的文件夹列表；days: 多少天未动视为过期
function scan(dirs, days) {
  const cutoff = Date.now() - days * 86400000;
  const acc = [];
  for (const dir of dirs) scanDir(dir, cutoff, acc);
  return acc.sort((a, b) => b.ageDays - a.ageDays);
}

// 按 cleanup 配置扫描：每个文件夹可覆盖 staleDays；只扫用户启用的条目（无隐式回退——
// 下载/桌面 由 seedCleanupFolders 识别添加为未启用条目，启用与否由用户决定）
function scanCleanup(cfg) {
  return cfg.cleanup.folders
    .filter((f) => f.enabled !== false)
    .flatMap((f) => scan([f.path], f.staleDays ?? cfg.staleDays).map((x) => ({ ...x, cleanupFolder: f.path, rulesOverride: f.rules || null })));
}

module.exports = { scan, scanCleanup };
