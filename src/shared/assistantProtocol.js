'use strict';
// 助手工具协议：纯函数、零 Electron 依赖（主进程与 /test 共用）。
// 免费 OpenAI-compatible 端点不保证 function-calling，故采用 JSON 输出协议：
//   {"reply": "给用户看的话", "actions": [{"tool": "update_settings", "args": {...}}]}

const MAX_ACTIONS_PER_TURN = 4;
const TOOL_NAMES = ['update_settings', 'search_files', 'get_status'];

// 助手可改的设置白名单（providers/apiKey、路径类字段一律禁止）
const SETTINGS_SCHEMA = {
  rules: { type: 'string', max: 4000 },
  staleDays: { type: 'int', min: 1, max: 3650 },
  searchMode: { enum: ['keyword', 'match', 'ai'] },
  language: { enum: ['zh', 'en'] },
  cleanup: {
    autoScan: { type: 'bool' },
    scanIntervalHours: { type: 'int', min: 1, max: 168 },
  },
  extraction: {
    officeMode: { enum: ['full', 'head'] },
    xlsxMode: { enum: ['full', 'headers'] },
    pdfMaxPages: { type: 'int', min: 1, max: 500 },
    maxChars: { type: 'int', min: 500, max: 100000 },
    sttMaxSeconds: { type: 'int', min: 30, max: 7200 },
  },
  app: {
    lowPower: { type: 'bool' },
    avoidCloudOnMetered: { type: 'bool' },
  },
};

function checkLeaf(spec, value) {
  if (spec.enum) return spec.enum.includes(value) ? value : undefined;
  if (spec.type === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (spec.type === 'int') {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : undefined;
  }
  if (spec.type === 'string') return typeof value === 'string' ? value.slice(0, spec.max) : undefined;
  return undefined;
}

// 递归按白名单过滤 patch；返回 {patch, rejected[]}（rejected 为被拒绝的键路径，供回执提示）
function sanitizeSettingsPatch(raw, schema = SETTINGS_SCHEMA, prefix = '') {
  const patch = {};
  const rejected = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patch, rejected: [prefix || '(patch)'] };
  for (const [key, value] of Object.entries(raw)) {
    const spec = schema[key];
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (!spec) {
      rejected.push(pathKey);
    } else if (spec.enum || spec.type) {
      const ok = checkLeaf(spec, value);
      if (ok === undefined) rejected.push(pathKey);
      else patch[key] = ok;
    } else {
      const sub = sanitizeSettingsPatch(value, spec, pathKey);
      rejected.push(...sub.rejected);
      if (Object.keys(sub.patch).length) patch[key] = sub.patch;
    }
  }
  return { patch, rejected };
}

// 从模型输出提取 {reply, actions}；不是协议 JSON 时返回 null（按纯文本回复处理）
function parseAssistantOutput(text, parseJsonLoose) {
  let obj;
  try {
    obj = parseJsonLoose(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.reply !== 'string') return null;
  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .filter((a) => a && typeof a === 'object' && TOOL_NAMES.includes(a.tool))
    .slice(0, MAX_ACTIONS_PER_TURN)
    .map((a) => ({ tool: a.tool, args: a.args && typeof a.args === 'object' ? a.args : {} }));
  return { reply: obj.reply, actions };
}

module.exports = {
  SETTINGS_SCHEMA,
  MAX_ACTIONS_PER_TURN,
  TOOL_NAMES,
  sanitizeSettingsPatch,
  parseAssistantOutput,
};
