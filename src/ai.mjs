import { randomUUID } from 'node:crypto';

const ROLE_CONFIG = {
  planner: { prefix:'PLANNER', label:'故事规划' },
  writer: { prefix:'WRITER', label:'正文写作' },
  reviewer: { prefix:'REVIEWER', label:'审稿整理' },
  checker: { prefix:'CHECKER', label:'网络查重' }
};
const DEFAULT_OUTPUT_TOKENS = {planner:8000, writer:24000, reviewer:6000, checker:6000};
const REASONING_EFFORTS = new Set(['none','minimal','low','medium','high','xhigh','max']);

export class AIClient {
  constructor({ apiKey, model, baseUrl, protocol = 'responses', maxOutputTokens = 6000, reasoningEffort = null, fetchImpl = fetch, role = 'default', emit = () => {} }) {
    this.apiKey = apiKey;
    this.model = model || 'gpt-5.6-luna';
    this.protocol = normalizeProtocol(protocol, baseUrl);
    this.endpoint = normalizeEndpoint(baseUrl, this.protocol);
    this.fetch = fetchImpl;
    this.role = role;
    this.maxOutputTokens = Number.isInteger(Number(maxOutputTokens)) ? Number(maxOutputTokens) : 6000;
    this.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
    this.emit = typeof emit === 'function' ? emit : () => {};
  }

  get enabled() { return Boolean(this.apiKey && this.model); }

  async generate({ instructions, input, maxOutputTokens = this.maxOutputTokens, tools, toolChoice, validate, streamProgress = false, meta = {} }) {
    const id = randomUUID();
    const started = Date.now();
    const requestText = `${instructions || ''}\n${input || ''}`;
    const event = extra => { try { this.emit({id, role:this.role, model:this.model, protocol:this.protocol, outputBudget:Number(maxOutputTokens) || 0, requestPreview:preview(requestText, 1600), requestText:requestText.slice(0, 20000), requestLength:requestText.length, createdAt:new Date(started).toISOString(), ...meta, ...extra}); } catch {} };
    event({status:'running', message:'已提交模型请求'});
    if (!this.enabled) {
      const error = new Error(`“${this.role}”尚未配置可用的 API 密钥和模型`);
      event({status:'failed', message:error.message, error:error.message, durationMs:Date.now()-started});
      throw error;
    }
    try {
      const payload = this.protocol === 'chat'
        ? { model:this.model, messages:[{role:'system',content:instructions},{role:'user',content:input}], max_tokens:maxOutputTokens }
        : { model:this.model, instructions, input, max_output_tokens:maxOutputTokens, store:false };
      if (this.reasoningEffort) {
        if (this.protocol === 'chat') payload.reasoning_effort = chatReasoningEffort(this.reasoningEffort);
        else payload.reasoning = {effort:this.reasoningEffort};
      }
      if (tools?.length) {
        if (this.protocol !== 'responses') throw new Error(`${this.role}需要 Responses 协议才能使用内置网页搜索`);
        payload.tools = tools;
        if (toolChoice) payload.tool_choice = toolChoice;
      }
      if (streamProgress) payload.stream = true;
      let response = await this.fetch(this.endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${this.apiKey}`},
        body:JSON.stringify(payload)
      });
      if (!response.ok) {
        let detail = await response.text();
        if (streamProgress && [400,422].includes(response.status) && /stream|sse|流式/i.test(detail)) {
          delete payload.stream;
          event({status:'running',message:'当前接口不支持流式返回，已自动切换普通模式'});
          response = await this.fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.apiKey}`},body:JSON.stringify(payload)});
          if (response.ok) detail = ''; else detail = await response.text();
        }
        if (response.ok) {
          // Continue below with the compatible non-stream response.
        } else {
        throw new Error(`${this.role}模型调用失败 (${response.status}): ${detail.slice(0, 300)}`);
        }
      }
      let data, text, incompleteReason, usage;
      if (streamProgress && response.body && String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) {
        const streamed = await readEventStream(response.body,this.protocol,(partial) => {
          event({status:'running',message:`正在接收模型正文（${partial.length} 字符）`,responseText:partial,responsePreview:preview(partial,1200),responseLength:partial.length});
        });
        data = streamed.data;
        text = streamed.text;
        incompleteReason = streamed.incompleteReason;
        usage = streamed.usage;
      } else {
        data = await response.json();
        incompleteReason = responseIncompleteReason(data, this.protocol);
        text = this.protocol === 'chat' ? chatText(data) : responsesText(data);
        usage = data.usage || null;
      }
      if (!text) {
        const error = incompleteReason
          ? new Error(`${this.role}模型返回被截断（${incompleteReason}）`)
          : new Error(`${this.role}模型没有返回文本${responseShapeHint(data, this.protocol)}`);
        error.responseText = '';
        error.usage = usage;
        throw error;
      }
      if (incompleteReason) {
        const error = new Error(`${this.role}模型返回被截断（${incompleteReason}）`);
        error.responseText = text; error.usage = usage;
        throw error;
      }
      let value;
      try { value = validate ? validate(text) : undefined; }
      catch (cause) {
        const error = new Error(`${this.role}模型返回校验失败：${cause.message}`);
        error.responseText = text; error.usage = usage;
        throw error;
      }
      event({status:'completed', message:validate ? '模型返回已校验，可以保存' : '模型已返回结果', responseText:text, responsePreview:preview(text,1200), responseLength:text.length, usage, durationMs:Date.now()-started});
      return {text, value, usage, model:this.model, role:this.role};
    } catch (error) {
      if (error.message === 'fetch failed') {
        const code = error.cause?.code || error.cause?.errors?.find(item => item.code)?.code;
        const advice = ['EACCES','EPERM'].includes(code)
          ? '当前服务进程没有外网连接权限，请在正常桌面环境重新启动墨流，或允许服务联网'
          : ['ENOTFOUND','EAI_AGAIN'].includes(code)
            ? '无法解析模型服务地址，请检查 API 地址和 DNS'
            : ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)
              ? '连接模型服务超时，请检查网络或代理'
              : '无法连接模型服务，请检查网络、代理及 API 地址';
        error.message = `${this.role}模型连接失败${code ? `（${code}）` : ''}：${advice}`;
      }
      event({status:'failed', message:error.message, error:error.message, responseText:error.responseText || '', responseLength:error.responseText?.length || 0, usage:error.usage || null, durationMs:Date.now()-started});
      throw error;
    }
  }
}

async function readEventStream(body, protocol, onProgress) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', usage = null, data = {}, incompleteReason = null, lastUpdate = 0;
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (protocol === 'chat') {
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') text += delta;
      if (event.choices?.[0]?.finish_reason === 'length') incompleteReason = '达到输出上限';
      usage = event.usage || usage;
      data = event;
    } else {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        data = event.response || event;
        usage = data.usage || usage;
        incompleteReason = responseIncompleteReason(data,'responses');
        if (!text) text = responsesText(data);
      }
    }
    const stamp = Date.now();
    if (text && stamp-lastUpdate >= 300) { lastUpdate = stamp; onProgress(text); }
  };
  while (true) {
    const {done,value} = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(),{stream:!done});
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop();
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  if (text) onProgress(text);
  return {text,usage,data,incompleteReason};
}

function responseIncompleteReason(data, protocol) {
  if (protocol === 'chat') {
    const reason = data.choices?.[0]?.finish_reason;
    return reason === 'length' ? '达到输出上限' : null;
  }
  if (data.status === 'incomplete') return data.incomplete_details?.reason || '响应未完成';
  return data.incomplete_details?.reason || null;
}

export class ModelRouter {
  constructor(env = process.env, options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.reload(env);
  }

  reload(env = process.env) {
    this.reviewEnabled = env.AI_REVIEW_ENABLED !== 'false';
    this.clients = {};
    for (const [role, config] of Object.entries(ROLE_CONFIG)) {
      const prefix = `AI_${config.prefix}_`;
      const baseUrl = env[`${prefix}BASE_URL`] || env.OPENAI_BASE_URL;
      const protocol = env[`${prefix}PROTOCOL`] || env.OPENAI_PROTOCOL || 'responses';
      const endpoint = normalizeEndpoint(baseUrl, normalizeProtocol(protocol, baseUrl));
      const configuredReasoning = env[`${prefix}REASONING_EFFORT`];
      this.clients[role] = new AIClient({
        apiKey:env[`${prefix}API_KEY`] ?? env.OPENAI_API_KEY,
        model:env[`${prefix}MODEL`] || env.OPENAI_MODEL || 'gpt-5.6-luna',
        baseUrl,
        protocol,
        maxOutputTokens:env[`${prefix}MAX_OUTPUT_TOKENS`] || DEFAULT_OUTPUT_TOKENS[role],
        // DeepSeek's reasoning mode is on by default and its reasoning tokens
        // count toward max_output_tokens. Structured reviews otherwise can
        // consume the whole budget before producing the JSON result.
        reasoningEffort:configuredReasoning ?? (role === 'reviewer' && isDeepSeekEndpoint(endpoint) ? 'none' : null),
        fetchImpl:this.fetchImpl,
        role:config.label,
        emit:this.emit
      });
    }
    return this.describe();
  }

  for(role) {
    const client = this.clients[role];
    if (!client) throw new Error(`未知模型任务：${role}`);
    return client;
  }

  enabledFor(role) { return this.for(role).enabled; }
  get enabled() { return Object.values(this.clients).every(client => client.enabled); }

  describe() {
    return Object.entries(ROLE_CONFIG).map(([role, config]) => {
      const client = this.clients[role];
      return {
        role, label:config.label, enabled:client.enabled, model:client.model,
        protocol:client.protocol, outputTokens:client.maxOutputTokens,
        endpoint:safeEndpoint(client.endpoint), reasoningEffort:client.reasoningEffort || 'auto'
      };
    });
  }

  outputTokens(role, fallback) { return this.for(role).maxOutputTokens || fallback; }

  async testConnections() {
    const cache = new Map();
    const results = [];
    for (const item of this.describe()) {
      const client = this.for(item.role);
      if (!client.enabled) {
        results.push({...item, ok:false, message:'未配置密钥'});
        continue;
      }
      const fingerprint = `${client.endpoint}|${client.model}|${client.protocol}|${client.apiKey}`;
      let check = cache.get(fingerprint);
      if (!check) {
        check = client.generate({instructions:'这是连接测试。', input:'只回复 OK', maxOutputTokens:128, meta:{task:'connection-test'}})
          .then(result => ({ok:true, message:result.text.trim().slice(0, 80)}))
          .catch(error => ({ok:false, message:error.message}));
        cache.set(fingerprint, check);
      }
      results.push({...item, ...await check});
    }
    return results;
  }
}

function normalizeProtocol(protocol, url='') {
  if (/\/chat\/completions\/?$/i.test(url || '')) return 'chat';
  if (/\/responses\/?$/i.test(url || '')) return 'responses';
  const value = String(protocol || '').toLowerCase();
  if (value === 'chat' || value === 'chat_completions') return 'chat';
  return 'responses';
}

function normalizeEndpoint(baseUrl, protocol) {
  const suffix = protocol === 'chat' ? '/chat/completions' : '/responses';
  if (!baseUrl) return `https://api.openai.com/v1${suffix}`;
  const base = String(baseUrl).replace(/\/$/, '');
  if (/\/(responses|chat\/completions)$/i.test(base)) return base;
  return `${base}${suffix}`;
}

function responsesText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(item => item && (item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string')
    .map(item => item.text).join('');
}

function chatText(data) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item.text || item.content || '').join('');
  return '';
}

function safeEndpoint(endpoint) {
  try { const url = new URL(endpoint); return `${url.origin}${url.pathname}`; }
  catch { return endpoint; }
}

function preview(value, limit=1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'auto' || !normalized ? null : (REASONING_EFFORTS.has(normalized) ? normalized : null);
}

function chatReasoningEffort(value) {
  if (value === 'minimal') return 'low';
  if (value === 'medium' || value === 'xhigh') return 'high';
  return value;
}

function isDeepSeekEndpoint(endpoint) {
  try { return new URL(endpoint).hostname.toLowerCase() === 'api.deepseek.com'; }
  catch { return false; }
}

function responseShapeHint(data, protocol) {
  if (!data || typeof data !== 'object') return '';
  if (protocol === 'chat') {
    const content = data.choices?.[0]?.message?.content;
    return `（响应状态：${data.status || '未知'}；消息内容类型：${Array.isArray(content) ? '数组' : typeof content}）`;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const types = output.map(item => item?.type).filter(Boolean);
  const contentTypes = output.flatMap(item => Array.isArray(item?.content) ? item.content : []).map(item => item?.type).filter(Boolean);
  const detail = [...new Set(contentTypes.length ? contentTypes : types)].join('、') || '无';
  return `（响应状态：${data.status || '未知'}；输出项：${detail}）`;
}

export function parseJsonText(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  const candidates = [cleaned];
  if (start >= 0 && end > start && (start !== 0 || end !== cleaned.length - 1)) candidates.push(cleaned.slice(start, end + 1));
  let lastError;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (error) { lastError = error; }
    const repaired = escapeJsonStringControls(candidate);
    if (repaired !== candidate) {
      try { return JSON.parse(repaired); } catch (error) { lastError = error; }
    }
  }
  if (lastError) throw new Error('模型返回内容不是有效的 JSON', {cause:lastError});
  throw new Error('模型返回内容不是有效的 JSON');
}

// Some compatible model endpoints occasionally place literal newlines, tabs or
// other control bytes inside JSON strings. Escape only those bytes while inside
// a quoted string; structural whitespace and all ordinary content stay intact.
function escapeJsonStringControls(source) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    const code = character.codePointAt(0);
    if (code < 0x20) {
      const standard = {'\b':'\\b','\f':'\\f','\n':'\\n','\r':'\\r','\t':'\\t'}[character];
      result += standard || `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      result += character;
    }
  }
  return result;
}
