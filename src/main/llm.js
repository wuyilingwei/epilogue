'use strict';
// OpenAI-compatible 客户端：chat / embeddings / whisper 转写 / 模型列表
// 全部基于 Node 全局 fetch，无 SDK 依赖。
const fs = require('fs');
const path = require('path');

function headers(provider, extra = {}) {
  const h = { ...extra };
  if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
  if ((provider.baseUrl || '').includes('openrouter.ai')) {
    h['HTTP-Referer'] = 'https://github.com/Wuyilingwei/epilogue';
    h['X-Title'] = 'Epilogue';
  }
  return h;
}

// provider 可用：未被禁用，且为本机（type=local）/ 免 Key（内置）/ 已配 Key
function usable(p) {
  if (!p || p.enabled === false) return false;
  if (p.type === 'local') return true;
  return Boolean(p.baseUrl && (p.keyless || p.apiKey));
}

// 计费网络时只保留本机 provider
function localOnlyFilter(providers, localOnly) {
  const list = Array.isArray(providers) ? providers : [providers];
  return localOnly ? list.filter((p) => p.type === 'local') : list;
}

// 灾备：按数组顺序逐个尝试，全部失败抛最后一个错误
async function withFailover(providers, fn) {
  const list = (Array.isArray(providers) ? providers : [providers]).filter(usable);
  if (!list.length) throw new Error('没有可用的 provider（请在设置中配置，或保留内置免费模型）');
  let lastErr;
  for (const p of list) {
    try {
      return await fn(p);
    } catch (e) {
      lastErr = e;
      require('./log').log('llm', `provider failed: ${p.name || p.baseUrl || 'local'}`, { error: String(e.message || e).slice(0, 200) });
    }
  }
  // 全部失败且是限流/超时：换成可操作的友好提示
  const msg = lastErr?.message || '';
  if (/HTTP 429/.test(msg) || /timeout/.test(msg)) {
    const { makeT } = require('../shared/locales');
    const t = makeT(require('./settings').get().language);
    throw new Error(t(/HTTP 429/.test(msg) ? 'err_busy' : 'err_timeout'));
  }
  throw lastErr;
}

function apiUrl(provider, endpoint) {
  return `${(provider.baseUrl || '').replace(/\/+$/, '')}${endpoint}`;
}

async function raise(res, what) {
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 各类请求超时：免费端点可能挂起连接不响应，无超时会让 UI 永远「思考中…」，
// 且同主机串行节流链会被一个挂死请求堵死全部后续 AI 调用
const TIMEOUTS = { chat: 90000, embeddings: 60000, transcription: 180000, 'list models': 15000 };

// 自动重试：429 最多 5 次（3s 起指数退避 + 抖动，免费通道拥挤是常态）；5xx 最多 3 次；尊重 Retry-After
async function fetchWithRetry(url, options, what, retries = 3) {
  const { log } = require('./log');
  const host = (url.split('/')[2] || '?').toLowerCase();
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUTS[what] || 90000) });
    } catch (e) {
      // 超时不重试（已等足量时间），直接抛给灾备链切换下一个 provider
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        log('llm', `${what} timeout`, { host, ms: Date.now() - t0, attempt });
        throw new Error(`${what} timeout：${(TIMEOUTS[what] || 90000) / 1000}s 无响应`);
      }
      log('llm', `${what} network error`, { host, error: String(e.message || e).slice(0, 200) });
      throw e;
    }
    if (res.ok) {
      log('llm', `${what} ok`, { host, ms: Date.now() - t0, attempt });
      return res;
    }
    const is429 = res.status === 429;
    const maxAttempts = is429 ? 5 : retries;
    if ((is429 || res.status >= 500) && attempt < maxAttempts) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const backoff = is429 ? 3000 * 2 ** attempt + Math.floor(Math.random() * 1500) : 2000 * 2 ** attempt;
      const waitMs = Number.isFinite(ra) ? Math.min(ra * 1000, 30000) : Math.min(backoff, 30000);
      log('llm', `${what} HTTP ${res.status}, retrying`, { host, attempt, waitMs });
      await sleep(waitMs);
      continue;
    }
    log('llm', `${what} HTTP ${res.status}, giving up`, { host, ms: Date.now() - t0, attempt });
    await raise(res, what); // 不可重试或重试耗尽
  }
}

// 同主机请求串行化 + 最小间隔：免费端点（如 Pollinations 单 IP 队列上限 1）背靠背连发必 429
const hostChains = new Map();
function hostGap(host) {
  return host.includes('pollinations') ? 3000 : 300; // 匿名免费通道队列极小，间隔放宽
}
function throttled(provider, fn) {
  const host = ((provider.baseUrl || '').split('/')[2] || 'local').toLowerCase();
  const prev = hostChains.get(host) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const result = await fn();
    await sleep(hostGap(host)); // 给服务端释放队列槽位的时间
    return result;
  });
  hostChains.set(host, run);
  return run;
}

async function chat(provider, messages, { json = false, temperature = 0.2 } = {}) {
  const body = { model: provider.model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  const res = await throttled(provider, () =>
    fetchWithRetry(
      apiUrl(provider, '/chat/completions'),
      {
        method: 'POST',
        headers: headers(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
      'chat'
    )
  );
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('chat 返回缺少 content');
  return content;
}

// 从模型输出中提取 JSON（容忍 ```json 围栏与前后杂文）
function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`无法从模型输出解析 JSON: ${text.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

async function chatJson(provider, messages, opts = {}) {
  // response_format 并非所有 OpenAI-compatible 服务都支持，失败时退回普通模式。
  // 但超时/429 是基础设施错误而非格式不支持 —— 回退只会对同一挂起/拥挤服务商白等双倍时间，直接上抛让灾备链切换。
  let text;
  try {
    text = await chat(provider, messages, { ...opts, json: true });
  } catch (e) {
    if (/timeout|HTTP 429/.test(e.message || '')) throw e;
    text = await chat(provider, messages, { ...opts, json: false });
  }
  return parseJsonLoose(text);
}

function embeddingsConfigured(providers) {
  const list = Array.isArray(providers) ? providers : [providers];
  return list.some((p) => p?.type === 'local' || (usable(p) && p.apiKey && !(p.baseUrl || '').includes('openrouter.ai')));
}

async function embed(provider, texts) {
  const res = await throttled(provider, () =>
    fetchWithRetry(
      apiUrl(provider, '/embeddings'),
      {
        method: 'POST',
        headers: headers(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: provider.model, input: texts }),
      },
      'embeddings'
    )
  );
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function transcribe(provider, filePath) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('model', provider.model);
  const res = await throttled(provider, () =>
    fetchWithRetry(apiUrl(provider, '/audio/transcriptions'), { method: 'POST', headers: headers(provider), body: form }, 'transcription')
  );
  const data = await res.json();
  return data.text || '';
}

async function listModels(provider) {
  const res = await fetchWithRetry(apiUrl(provider, '/models'), { headers: headers(provider) }, 'list models', 1);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

// 连通性测试：单次请求、短超时、不重试不节流（一次定生死，且不排同主机节流队列）
const TEST_TIMEOUT = 15000;
async function testProvider(type, provider) {
  const t0 = Date.now();
  const post = async (endpoint, body, check) => {
    let res;
    try {
      res = await fetch(apiUrl(provider, endpoint), {
        method: 'POST',
        headers: headers(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TEST_TIMEOUT),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`test timeout：${TEST_TIMEOUT / 1000}s 无响应`);
      throw e;
    }
    if (!res.ok) await raise(res, 'test');
    const data = await res.json();
    if (!check(data)) throw new Error('返回格式异常（非 OpenAI-compatible 响应）');
  };
  if (type === 'chat') {
    await post(
      '/chat/completions',
      { model: provider.model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8 },
      (d) => typeof d.choices?.[0]?.message?.content === 'string'
    );
  } else if (type === 'embeddings') {
    await post('/embeddings', { model: provider.model, input: ['ping'] }, (d) => Array.isArray(d.data?.[0]?.embedding));
  } else {
    throw new Error('该类型不支持快速测试');
  }
  return { ok: true, ms: Date.now() - t0 };
}

// 数组灾备版入口
const chatF = (providers, messages, opts) => withFailover(providers, (p) => chat(p, messages, opts));
const chatJsonF = (providers, messages, opts) => withFailover(providers, (p) => chatJson(p, messages, opts));
const embedF = (providers, texts) =>
  withFailover(
    (Array.isArray(providers) ? providers : [providers]).filter(
      (p) => p.type === 'local' || (p.apiKey && !(p.baseUrl || '').includes('openrouter.ai'))
    ),
    (p) => {
      if (p.type === 'local') {
        const localModels = require('./localModels'); // 懒加载：本机 BGE，离线免费
        return localModels.embed(texts, p.model);
      }
      return embed(p, texts);
    }
  );
const transcribeF = (providers, filePath) => withFailover(providers, (p) => transcribe(p, filePath));

module.exports = {
  chat, chatJson, embed, transcribe, listModels,
  chatF, chatJsonF, embedF, transcribeF,
  usable, withFailover, embeddingsConfigured, parseJsonLoose, localOnlyFilter, testProvider,
  TIMEOUTS, // 导出供测试覆盖
};
