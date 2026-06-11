'use strict';
// 配置存储：userData/settings.json（v2：provider 数组灾备 + cleanup 多文件夹 + 应用偏好）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 内置免费 provider：Pollinations 免 Key 可直接用；OpenRouter / OpenCode Zen 填 Key 后启用（免费额度，注册取 Key）
const BUILTIN_CHAT = [
  { name: 'Pollinations 内置免费', baseUrl: 'https://text.pollinations.ai/openai', apiKey: '', model: 'openai', keyless: true },
  { name: 'OpenRouter Free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'OpenCode Zen Free', baseUrl: 'https://opencode.ai/zen/v1', apiKey: '', model: 'deepseek-v4-flash-free' },
];

const DEFAULTS = {
  version: 2,
  // 每类按数组顺序灾备：前一个失败自动尝试下一个
  providers: {
    chat: BUILTIN_CHAT,
    // 默认本机 BGE 中文 embedding（免费、离线、大陆可用——经 hf-mirror 下载）；可追加云端 API 作灾备
    embeddings: [
      { name: '本机 BGE 中文', type: 'local', model: 'Xenova/bge-small-zh-v1.5', keyless: true },
      { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'text-embedding-3-small' },
    ],
    // 默认两条本机 Whisper（离线，音频不出本机）：低精度启用、高精度按需勾选；可「添加」云端 OpenAI-compatible 转写作灾备
    transcription: [
      { name: '本机 Whisper 低精度', type: 'local', model: 'Xenova/whisper-tiny', keyless: true },
      { name: '本机 Whisper 高精度', type: 'local', model: 'Xenova/whisper-small', keyless: true, enabled: false },
    ],
  },
  // 全局归类习惯（cleanup 文件夹可单独覆盖）
  rules: '',
  destinations: [],
  // 归类目标的额外索引：文件名必索；内容/云内容索引按目标文件夹单独控制
  // perFolder: { [path]: { content: bool(缺省 true), cloud: bool(缺省 false——读云占位文件会触发下载) } }
  destIndex: { enabled: true, perFolder: {} },
  recordedFolders: [],
  // 全局过期天数
  staleDays: 30,
  cleanup: {
    // {path, staleDays: null|number, rules: null|string, enabled?: bool(缺省 true)} —— null/空 = 沿用全局
    folders: [],
    seeded: false, // 是否已自动添加过 下载/桌面（识别并添加但不启用——决定权在用户；删除后不复活）
    autoScan: true,
    scanIntervalHours: 6,
    soloMode: false, // 定时扫描后自动执行 AI 归类与移动（无需审批）—— 仅可由用户手动开启
    allowTrash: false, // 允许 AI 将明显无价值的临时文件移入系统回收站 —— 仅可由用户手动开启
  },
  app: {
    launchAtLogin: false,
    trayKeepAlive: true, // 关闭窗口驻留托盘而非退出
    lowPower: true, // 低占用：禁硬件加速、低进程优先级、电池模式降速并跳过转写
    hfMirror: 'https://hf-mirror.com', // 本机模型下载镜像（大陆可用），置空走 huggingface.co
    avoidCloudOnMetered: true, // 按流量计费网络时避免使用云 embedding（whisper 本就仅本机）
  },
  // 寻物默认模式：keyword 关键字 / match embedding 匹配度 / ai AI 搜索
  searchMode: 'ai',
  // 图形 embedding：本机 CLIP 系（按需下载，下载后方可启用）；默认中文优化 Chinese-CLIP；
  // device: 'auto'（按平台尝试 GPU，失败回退 CPU）| 'cpu'
  imageEmbed: { enabled: false, model: 'Xenova/chinese-clip-vit-base-patch16', device: 'auto' },
  // 内容提取策略（设置-提取 选项卡）
  extraction: {
    officeMode: 'full', // full | head —— Word/PPT 完整读取或只读开头
    xlsxMode: 'full', // full | headers —— Excel 全部内容或仅表头+前几行
    pdfMaxPages: 30,
    maxChars: 12000, // 送入 LLM 的字符上限
    sttMaxSeconds: 300, // 本地转写默认只跑前 5 分钟
  },
  stats: {
    firstRunAt: null, // 首次运行时间（计算「已陪伴天数」）
    archivedCount: 0, // 已归档（执行移动）的文件数
  },
  language: 'zh',
  tosAccepted: false, // 首次启动展示服务条款，同意后置 true
};

let cached = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// v1（单 provider 对象）→ v2（数组）。无 Key 的旧条目直接丢弃，让内置默认值生效。
function migrate(parsed) {
  if (parsed.providers) {
    for (const k of ['chat', 'embeddings', 'transcription']) {
      const v = parsed.providers[k];
      if (v && !Array.isArray(v)) {
        parsed.providers[k] = v.apiKey ? [{ name: `${k} (迁移)`, ...v }] : undefined;
        if (!parsed.providers[k]) delete parsed.providers[k];
      }
    }
    // v2.5：转写改统一 provider 列表 —— 本机两档拆成独立条目（低 tiny / 高 small），云端条目恢复保留（撤销 v2.3 剔除）
    const tr = parsed.providers.transcription;
    if (Array.isArray(tr)) {
      const locals = tr.filter((p) => p.type === 'local');
      const clouds = tr.filter((p) => p.type !== 'local');
      if (locals.length === 2 && locals.every((p) => !p.quality)) {
        // 已是拆分形态，仅兜底清理
      } else {
        // 旧形态：单条 local 带 quality（或缺失）→ 拆两条，旧精度对应的条目启用并置顶
        const oldHigh = locals.some((p) => p.quality === 'high' || /small/.test(p.model || ''));
        const tiny = { name: '本机 Whisper 低精度', type: 'local', model: 'Xenova/whisper-tiny', keyless: true, enabled: !oldHigh };
        const small = { name: '本机 Whisper 高精度', type: 'local', model: 'Xenova/whisper-small', keyless: true, enabled: oldHigh };
        parsed.providers.transcription = oldHigh ? [small, tiny, ...clouds] : [tiny, small, ...clouds];
      }
      for (const p of parsed.providers.transcription) delete p.quality;
    }
    // v2.2：embeddings 默认本机 BGE —— 旧数组里没有 local 条目时置顶补上
    const em = parsed.providers.embeddings;
    if (Array.isArray(em) && !em.some((p) => p.type === 'local')) {
      em.unshift({ name: '本机 BGE 中文', type: 'local', model: 'Xenova/bge-small-zh-v1.5', keyless: true });
    }
    // v2.6：OpenCode Zen 免费预设（deepseek-v4-flash-free）—— 缺则追加到尾部，不动用户既有灾备顺序
    const ch = parsed.providers.chat;
    if (Array.isArray(ch) && !ch.some((p) => (p.baseUrl || '').includes('opencode.ai'))) {
      ch.push({ name: 'OpenCode Zen Free', baseUrl: 'https://opencode.ai/zen/v1', apiKey: '', model: 'deepseek-v4-flash-free' });
    }
  }
  // v2.8：图形 embedding 默认升级为中文优化 Chinese-CLIP —— 仅当用户从未启用且仍为旧默认（未投入）时升级
  if (parsed.imageEmbed && parsed.imageEmbed.enabled !== true && parsed.imageEmbed.model === 'Xenova/clip-vit-base-patch32') {
    parsed.imageEmbed.model = 'Xenova/chinese-clip-vit-base-patch16';
  }
  // v2.7：目标索引 perFolder 由 bool（仅内容）升级为 { content, cloud }；cloud 继承旧全局 cloudContent
  if (parsed.destIndex?.perFolder) {
    const inheritCloud = parsed.destIndex.cloudContent === true;
    for (const k of Object.keys(parsed.destIndex.perFolder)) {
      const v = parsed.destIndex.perFolder[k];
      if (typeof v === 'boolean') parsed.destIndex.perFolder[k] = { content: v, cloud: inheritCloud };
    }
  }
  return parsed;
}

function get() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    cached = deepMerge(DEFAULTS, migrate(JSON.parse(raw)));
  } catch {
    cached = structuredClone(DEFAULTS);
  }
  return cached;
}

function set(patch) {
  cached = deepMerge(get(), patch);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(cached, null, 2), 'utf8');
  return cached;
}

// 识别 下载/桌面 并以「未启用」状态添加进清理列表（不替用户决定）；一次性 seed，用户删除后不复活
function seedCleanupFolders() {
  const cfg = get();
  if (cfg.cleanup.seeded || !(cfg.recordedFolders || []).length) return cfg;
  const folders = [...cfg.cleanup.folders];
  for (const rf of cfg.recordedFolders) {
    if (rf.kind !== 'standard' || !/downloads?|desktop|下载|桌面/i.test(rf.name || '')) continue;
    if (!rf.path || folders.some((f) => f.path === rf.path)) continue;
    folders.push({ path: rf.path, staleDays: null, rules: null, enabled: false });
  }
  return set({ cleanup: { folders, seeded: true } });
}

module.exports = { get, set, DEFAULTS, deepMerge, migrate, seedCleanupFolders };
