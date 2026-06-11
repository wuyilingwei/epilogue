'use strict';
// AI 归类：按用户自然语言习惯规则，为文件给出目标文件夹建议并执行移动
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const settings = require('./settings');

const BATCH_SIZE = 8; // 每次 LLM 请求最多归类的文件数（小批 prompt 小、免费通道响应快）
const BATCH_HARD = 24; // 单批硬上限：成套内容整组同批可超 BATCH_SIZE，但不超过此值（防 prompt 爆炸）
const EXPLORE_ROUNDS = 2; // 智能体目录探索轮数上限（之后强制产出结果）

// 安全列目录：仅允许 destinations 内的路径（防模型幻觉/越权路径），单层，隐藏项过滤
function listDirSafe(reqPath, destinations) {
  const resolved = path.resolve(String(reqPath));
  const inside = destinations.some((d) => {
    const root = path.resolve(d);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!inside) return { path: reqPath, error: '路径不在目标文件夹内' };
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    return {
      path: resolved,
      dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 50),
      files: entries.filter((e) => e.isFile()).map((e) => e.name).slice(0, 15),
    };
  } catch (e) {
    return { path: reqPath, error: String(e.message || e).slice(0, 100) };
  }
}

// 目标现有结构概览：2 层子目录树（仅目录名，本地生成零 LLM 成本），给模型多层 subfolder 的基础认知
function destTree(destinations, depth = 2) {
  const walk = (dir, d) => {
    if (d <= 0) return {};
    try {
      const subs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .slice(0, 30);
      const node = {};
      for (const s of subs) node[s.name] = walk(path.join(dir, s.name), d - 1);
      return node;
    } catch {
      return {};
    }
  };
  const tree = {};
  for (const d of destinations) tree[d] = walk(d, depth);
  return tree;
}

// 本地成套预检测（零 LLM 成本）：识别同目录的课件系列/便携式程序/音视频组等，返回 filePath → 套标签
function detectSets(records) {
  const byDir = new Map();
  for (const r of records) {
    const dir = path.dirname(r.filePath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  const SUPPORT_EXTS = new Set(['.dll', '.so', '.dylib', '.ini', '.cfg', '.dat', '.pak', '.json', '.xml', '.bin']);
  const sets = new Map();
  for (const [dir, group] of byDir) {
    if (group.length < 3) continue;
    // 便携式程序：可执行文件 + ≥2 个支撑文件 → 整目录一套
    const exts = group.map((r) => path.extname(r.fileName).toLowerCase());
    const hasExec = exts.some((e) => ['.exe', '.app', '.bat', '.cmd', '.sh'].includes(e));
    const supportN = exts.filter((e) => SUPPORT_EXTS.has(e)).length;
    if (hasExec && supportN >= 2) {
      for (const r of group) sets.set(r.filePath, `便携程序:${path.basename(dir)}`);
      continue;
    }
    // 序号系列：去尾部序号标记（数字/SxxExx/EP n/第N课·集·讲·章·节）后共同词干 ≥3 → 一套
    // 覆盖：课件 lecture01-12、剧集 S01E03、专辑音轨 01-12、相机连号 IMG_0001
    const stems = new Map();
    for (const r of group) {
      const stem = r.fileName
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/(?:s\d{1,2}\s*e\d{1,3}|ep?\.?\s*\d{1,4}|第\s*\d+\s*[集课讲章节期]|[\s_\-.(（[]*\d{1,4}[)）\]]*)\s*$/i, '')
        .replace(/[\s_\-.]+$/, '')
        .trim();
      if (stem.length < 2) continue;
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push(r);
    }
    for (const [stem, members] of stems) {
      if (members.length >= 3) for (const r of members) sets.set(r.filePath, `系列:${stem}`);
    }
  }
  return sets;
}

// records 可带 rulesOverride（cleanup 文件夹单独规则）；按规则分组分别请求
async function suggest(records, onProgress = () => {}) {
  const { log } = require('./log');
  const cfg = settings.get();
  if (!cfg.destinations.length) throw new Error('尚未设置归类目标文件夹');
  const groups = new Map();
  for (const r of records) {
    const rules = (r.rulesOverride || cfg.rules || '').trim();
    if (!rules) throw new Error('尚未设置归类习惯（请在设置中用自然语言描述，或给该清理文件夹配置单独规则）');
    if (!groups.has(rules)) groups.set(rules, []);
    groups.get(rules).push(r);
  }
  log('classify', `suggest start: ${records.length} file(s) in ${groups.size} group(s)`);
  const out = [];
  let firstErr = null;
  let gi = 0;
  for (const [rules, group] of groups) {
    gi++;
    const sets = detectSets(group); // 本地成套预检测，标签注入 prompt
    // 目录感知分批：同目录（同套）文件同批 —— 顺序切批会把一套拆散到不同请求，模型看不到全套。
    // 整组装批（可超 BATCH_SIZE，硬上限 BATCH_HARD），装不下开新批。
    const byDir = new Map();
    for (const r of group) {
      const d = path.dirname(r.filePath);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(r);
    }
    const batches = [];
    let cur = [];
    for (const dirGroup of byDir.values()) {
      const chunks = [];
      for (let i = 0; i < dirGroup.length; i += BATCH_HARD) chunks.push(dirGroup.slice(i, i + BATCH_HARD));
      for (const chunk of chunks) {
        if (cur.length && cur.length + chunk.length > BATCH_SIZE) {
          batches.push(cur);
          cur = [];
        }
        cur.push(...chunk);
      }
    }
    if (cur.length) batches.push(cur);
    for (let b = 0; b < batches.length; b++) {
      onProgress({ stage: `AI 归类中 ${gi}/${groups.size} · 批 ${b + 1}/${batches.length}（${batches[b].length} 个文件）…` });
      const t0 = Date.now();
      try {
        out.push(...(await suggestGroup(cfg, rules, batches[b], sets)));
        log('classify', `group ${gi}/${groups.size} batch ${b + 1}/${batches.length} done`, { files: batches[b].length, ms: Date.now() - t0 });
      } catch (e) {
        firstErr = firstErr || e;
        log('classify', `group ${gi}/${groups.size} batch ${b + 1}/${batches.length} failed`, { error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 });
      }
    }
  }
  if (!out.length && firstErr) throw firstErr; // 全军覆没才报错；部分成功返回已得建议
  return out;
}

async function suggestGroup(cfg, rules, records, sets = new Map()) {
  // 通用归类标准：在用户习惯之外注入的判断基线（用户习惯优先）
  const trashEnabled = cfg.cleanup.allowTrash === true;
  const sys =
    '你是文件整理助手。用户用自然语言描述了 TA 的归类习惯，以用户习惯为最高优先；以下通用标准作为补充判断基线：\n' +
    '- 文件名中的日期、版本号、项目名、语义词是强归类信号；扩展名指示文件性质。\n' +
    '- 截图/录屏/导出报表等按时间组织；文档按主题或项目组织；安装包（dmg/pkg/exe/msi/iso）通常已安装完毕、价值低。\n' +
    '- 同一目录（sourceDir 相同）下文件名相似的文件很可能属于同一整体——同名不同扩展（视频+字幕、数据+说明）、' +
    '分卷（part1/part2、.z01/.zip）、同一项目配套文件——应给出**相同的 destination 与 subfolder**，整体归档。\n' +
    '- **成套内容整体归档**：课件/讲座系列（共同前缀+序号、第N课）、剧集与专辑（SxxExx、音轨序号）、' +
    '便携式软件目录（可执行文件+dll/资源/配置——整套一起移，缺一不可运行）、相机照片连号——同套所有文件给出' +
    '相同的 destination 与 subfolder（子文件夹可用套件名，如 "课件/操作系统"）。文件的 "set" 字段是本地预检测的' +
    '疑似成套标签，优先参考；无标签也可自行判断成套。\n' +
    '- 不确定、规则未覆盖、或文件疑似正在使用 → move:false，宁可不动。\n' +
    '对每个文件先决定 **移动(move:true) 或 不移动(move:false)**：符合习惯且有把握才移动；' +
    '移动时从“可用目标文件夹”中选择最符合习惯的一个（可附加子文件夹相对路径）。\n' +
    (trashEnabled
      ? '可额外输出 "trash": true 表示移入系统回收站——仅限**明显无价值的临时文件**（已装完的安装包、重复下载副本、' +
        '损坏的部分下载如 .crdownload/.part、空文件），且高度确信时才用；trash 时 destination 置 null。拿不准就不要 trash。\n'
      : '') +
    '「目标现有结构概览」给出了各目标文件夹的 2 层子目录树——优先归入**已存在**的合适子文件夹（保持用户既有组织），' +
    `需要查看更深层时可先只输出 {"explore": ["目标内绝对路径", …]}（≤6 个路径，最多 ${EXPLORE_ROUNDS} 轮），` +
    '我会返回其子目录与示例文件；之后必须输出最终结果。subfolder 支持多层相对路径（如 "2026/发票/差旅"）。\n' +
    '最终输出 JSON：{"items": [{"filePath": "原路径", "move": true或false, "destination": "目标文件夹绝对路径或null", ' +
    '"subfolder": "可多层的子路径，可为空字符串", "reason": "一句话理由"' +
    (trashEnabled ? ', "trash": 可选布尔' : '') +
    '}]}。只输出 JSON。';
  const user = JSON.stringify(
    {
      用户归类习惯: rules,
      可用目标文件夹: cfg.destinations,
      目标现有结构概览: destTree(cfg.destinations),
      待归类文件: records.map((r) => ({
        filePath: r.filePath,
        fileName: r.fileName,
        sourceDir: path.dirname(r.filePath),
        kind: r.kind,
        summary: r.summary,
        keywords: r.keywords,
        set: sets.get(r.filePath) || undefined,
      })),
    },
    null,
    1
  );
  // 智能体循环：模型可先 explore 查看更深层目录，再给最终归类（多层嵌套目标结构友好）
  const { log } = require('./log');
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
  for (let round = 0; ; round++) {
    const out = await llm.chatJsonF(cfg.providers.chat, msgs);
    if (Array.isArray(out.explore) && out.explore.length && round < EXPLORE_ROUNDS) {
      const listings = out.explore.slice(0, 6).map((p) => listDirSafe(p, cfg.destinations));
      log('classify', `explore round ${round + 1}`, { paths: listings.map((l) => l.path) });
      msgs.push({ role: 'assistant', content: JSON.stringify(out) });
      msgs.push({
        role: 'user',
        content: `[目录内容]\n${JSON.stringify(listings)}\n据此继续：${round + 1 < EXPLORE_ROUNDS ? '可再 explore 一轮，或' : '现在必须'}输出最终 {"items": [...]}。`,
      });
      continue;
    }
    // trash 开关未开时强制剥除（防模型越权输出）
    return (out.items || []).filter((i) => i && i.filePath).map((i) => (trashEnabled ? i : { ...i, trash: undefined }));
  }
}

function uniqueDest(dir, fileName) {
  let candidate = path.join(dir, fileName);
  const { name, ext } = path.parse(fileName);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${name} (${n})${ext}`);
  return candidate;
}

// moves: [{filePath, destination, subfolder, trash?}] → 实际移动/移入回收站，返回 [{filePath, newPath?, trashed?, error?}]
async function applyMoves(moves, store) {
  const { log } = require('./log');
  const results = [];
  for (const m of moves) {
    try {
      if (m.trash === true) {
        const { shell } = require('electron');
        await shell.trashItem(m.filePath); // 系统回收站/废纸篓，可随时找回
        store.remove(m.filePath);
        log('classify', `trashed: ${path.basename(m.filePath)}`);
        results.push({ filePath: m.filePath, trashed: true });
        continue;
      }
      const destDir = m.subfolder ? path.join(m.destination, m.subfolder) : m.destination;
      fs.mkdirSync(destDir, { recursive: true });
      const newPath = uniqueDest(destDir, path.basename(m.filePath));
      try {
        fs.renameSync(m.filePath, newPath);
      } catch (e) {
        if (e.code === 'EXDEV') {
          // 跨设备（如移入云盘挂载）：复制后删除
          fs.copyFileSync(m.filePath, newPath);
          fs.rmSync(m.filePath);
        } else {
          throw e;
        }
      }
      store.updatePath(m.filePath, newPath);
      results.push({ filePath: m.filePath, newPath });
    } catch (e) {
      results.push({ filePath: m.filePath, error: e.message });
    }
  }
  // 归档计数（总览统计「已归档文件」）
  const ok = results.filter((r) => r.newPath).length;
  if (ok) settings.set({ stats: { archivedCount: (settings.get().stats.archivedCount || 0) + ok } });
  return results;
}

module.exports = { suggest, applyMoves, detectSets, listDirSafe, destTree };
