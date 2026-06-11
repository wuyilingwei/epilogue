'use strict';
// 内置助手：对话 + 基础智能体能力（JSON 工具协议，见 shared/assistantProtocol.js）。
// 能力：白名单内读改设置（含把长期偏好合并进归类习惯 rules）、检索索引库。
const settings = require('./settings');
const llm = require('./llm');
const { makeT } = require('../shared/locales');
const proto = require('../shared/assistantProtocol');

const MAX_HISTORY = 16; // 只送最近 N 条，控 token
const MAX_TOOL_ROUNDS = 3;

function settingsDigest(cfg) {
  return {
    language: cfg.language,
    searchMode: cfg.searchMode,
    staleDays: cfg.staleDays,
    rules: (cfg.rules || '').slice(0, 1500),
    destinations: cfg.destinations,
    cleanup: { autoScan: cfg.cleanup.autoScan, scanIntervalHours: cfg.cleanup.scanIntervalHours, folders: cfg.cleanup.folders.map((f) => f.path) },
    extraction: cfg.extraction,
    app: { lowPower: cfg.app.lowPower, avoidCloudOnMetered: cfg.app.avoidCloudOnMetered },
  };
}

function buildSystemPrompt(cfg) {
  const lang = cfg.language === 'en' ? 'English' : '中文';
  return [
    '你是 Epilogue（个人文件 AI 工作流桌面应用）的内置助手。应用功能：索引文件内容（压缩包/Office/PDF/音视频转写）、',
    '按用户习惯归类过期文件、自然语言寻物。你帮用户：调整应用设置、维护长期偏好（指导方案）、查找文件、答疑。',
    '',
    `用户界面语言：${lang}（用该语言回复，除非用户换语言提问）。`,
    `当前设置摘要：${JSON.stringify(settingsDigest(cfg))}`,
    '',
    '回复协议：永远只输出一个 JSON 对象，不要输出其他文字：',
    '{"reply": "给用户看的话", "actions": [{"tool": "工具名", "args": {…}}]}',
    '无需动作时 actions 为 []。可用工具：',
    '- update_settings {patch}: 修改设置。仅允许字段：rules(归类习惯,字符串)、staleDays(1-3650)、searchMode(keyword|match|ai)、',
    '  language(zh|en)、cleanup.autoScan(bool)、cleanup.scanIntervalHours(1-168)、extraction.officeMode(full|head)、',
    '  extraction.xlsxMode(full|headers)、extraction.pdfMaxPages、extraction.maxChars、extraction.sttMaxSeconds、',
    '  app.lowPower(bool)、app.avoidCloudOnMetered(bool)。API/provider 配置你无权修改。',
    '  用户说「记住/以后…」等长期归类偏好时，把偏好合并进 rules（给出合并后的完整文本，保留仍有效的旧条目，短行列表组织）。',
    '- search_files {query}: 在已索引文件中检索，返回匹配文件路径与摘要。',
    '- get_status {}: 获取索引统计与完整设置摘要。',
    '工具结果会以 [tool results] 消息回给你，之后继续按同样协议回复。修改前无需再次确认，但要在 reply 中说明做了什么。',
  ].join('\n');
}

async function runTool(action, events, hooks) {
  const { tool, args } = action;
  if (tool === 'update_settings') {
    const { patch, rejected } = proto.sanitizeSettingsPatch(args.patch || args);
    if (Object.keys(patch).length) {
      const cfg = settings.set(patch);
      hooks.onSettingsChanged?.(cfg);
      events.push({ type: 'settings_updated', detail: Object.keys(patch).join(', ') });
    }
    return { tool, ok: Object.keys(patch).length > 0, applied: patch, rejected };
  }
  if (tool === 'search_files') {
    const query = String(args.query ?? '').trim();
    if (!query) return { tool, ok: false, error: 'empty query' };
    const ipc = require('./ipc'); // lazy：register 时 ipc 已加载完成，无循环问题
    const r = await ipc.ask(query, args.mode === 'ai' ? 'ai' : 'match');
    events.push({ type: 'search', detail: query });
    return {
      tool,
      ok: true,
      answer: r.answer || undefined,
      hits: r.hits.slice(0, 6).map((h) => ({ path: h.filePath, summary: (h.summary || '').slice(0, 120), score: +(h.score ?? 0).toFixed(2) })),
    };
  }
  if (tool === 'get_status') {
    const ipc = require('./ipc');
    return { tool, ok: true, stats: ipc.getStore().stats(), settings: settingsDigest(settings.get()) };
  }
  return { tool, ok: false, error: 'unknown tool' };
}

// 一轮对话：history 为 [{role:'user'|'assistant', content}]，返回 {reply, events[]}
async function chatTurn(history, hooks = {}) {
  const cfg = settings.get();
  const t = makeT(cfg.language);
  const msgs = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...history.slice(-MAX_HISTORY).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
  ];
  const events = [];
  let lastReply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const text = await llm.chatF(cfg.providers.chat, msgs, { temperature: 0.4 });
    const parsed = proto.parseAssistantOutput(text, llm.parseJsonLoose);
    if (!parsed) return { reply: text.trim(), events }; // 模型没守协议 → 当纯文本回复
    lastReply = parsed.reply;
    if (!parsed.actions.length) return { reply: lastReply, events };
    const { log } = require('./log');
    log('assistant', `round ${round + 1}: ${parsed.actions.length} action(s)`, { tools: parsed.actions.map((a) => a.tool) });
    const results = [];
    for (const a of parsed.actions) {
      try {
        results.push(await runTool(a, events, hooks));
      } catch (e) {
        log('assistant', `tool failed: ${a.tool}`, { error: e.message.slice(0, 200) });
        results.push({ tool: a.tool, ok: false, error: e.message.slice(0, 200) });
      }
    }
    msgs.push({ role: 'assistant', content: text });
    msgs.push({ role: 'user', content: `[tool results]\n${JSON.stringify(results)}\n据此继续，仍按 JSON 协议回复；若已完成就给最终 reply 且 actions 为 []。` });
  }
  return { reply: lastReply || t('err', { msg: 'assistant loop exhausted' }), events };
}

module.exports = { chatTurn };
