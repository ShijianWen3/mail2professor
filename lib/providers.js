// lib/providers.js
// 把各家 LLM 的 chat API 统一成「能调用工具的一轮对话」。
//
// 内部统一消息格式（OpenAI 风格，agent.js 只认这一套）：
//   { role:'system',    content }
//   { role:'user',      content }
//   { role:'assistant', content, toolCalls:[{ id, name, args }] }
//   { role:'tool',      toolCallId, name, content }
//
// 加新厂商的两种方式：
//   1. 只是 OpenAI 兼容接口 → 在 PRESETS 里加一条即可
//   2. 私有协议 → 加一个 adapter（参考 anthropicAdapter）

export const PRESETS = {
  deepseek: {
    label: 'DeepSeek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    apiKeyPrefix: 'sk-', note: '便宜、工具调用稳定，推荐'
  },
  glm: {
    label: '智谱 GLM', protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    apiKeyPrefix: '', note: 'glm-4-flash 有免费额度'
  },
  qwen: {
    label: '通义千问', protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
    apiKeyPrefix: 'sk-'
  },
  kimi: {
    label: 'Kimi', protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k',
    apiKeyPrefix: 'sk-'
  },
  openai: {
    label: 'OpenAI', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    apiKeyPrefix: 'sk-'
  },
  minimax: {
    label: 'MiniMax', protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-Text-01',
    apiKeyPrefix: ''
  },
  anthropic: {
    label: 'Anthropic', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514',
    apiKeyPrefix: 'sk-ant-'
  }
};

export function presetOf(provider) {
  return PRESETS[provider] || PRESETS.deepseek;
}

// 每个厂商的设置分开存：llm.perProvider[provider] = { apiKey, baseUrl, model }
// 没配过的厂商回落到它自己的预设默认值 —— 这样在厂商之间来回切换不会互相冲掉
// key 和自定义 base URL（比如"OpenAI 兼容"里填的本地/代理地址）。
export function providerSettings(llm = {}, provider = llm.provider) {
  const preset = presetOf(provider);
  const slot = llm.perProvider?.[provider] || {};
  return {
    apiKey: slot.apiKey || '',
    baseUrl: (slot.baseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
    model: slot.model || preset.model
  };
}

export function currentApiKey(llm = {}) {
  return providerSettings(llm, llm.provider).apiKey;
}

export function resolveConfig(llm = {}) {
  const provider = llm.provider || 'deepseek';
  const preset = presetOf(provider);
  const settings = providerSettings(llm, provider);
  return {
    provider,
    protocol: preset.protocol || 'openai',
    apiKey: settings.apiKey.trim(),
    baseUrl: settings.baseUrl,
    model: settings.model
  };
}

// ─── 文本清理：模型返回的 JSON 参数里可能夹带真正的换行/控制字符 ───────────────
export function sanitizeJsonString(str) {
  return String(str).replace(
    /"((?:[^"\\]|\\.)*)"/g,
    (match, inner) =>
      '"' +
      inner
        .replace(/\r\n/g, '\\n')
        .replace(/\r/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') +
      '"'
  );
}

// 工具参数容错解析：字符串 → 对象。模型/厂商在这里翻车的概率最高。
export function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  const attempts = [
    text,
    sanitizeJsonString(text),
    text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  ];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      /* 换下一种 */
    }
  }
  throw new Error(`工具参数不是合法 JSON: ${text.slice(0, 200)}`);
}

// 少数厂商（尤其旧版 GLM / 部分国产模型）不返回 tool_calls，而是把调用写进正文：
//   {"name": "read_current_page", "arguments": {...}}
// 这里做一次兜底识别，识别不到就返回 null。
export function extractTextToolCall(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : content).trim();
  if (!raw.startsWith('{')) return null;
  try {
    const obj = JSON.parse(sanitizeJsonString(raw));
    const name = obj.name || obj.tool || obj.function?.name;
    const args = obj.arguments || obj.args || obj.parameters || obj.function?.arguments || {};
    if (typeof name === 'string' && name) {
      return { name, args: typeof args === 'string' ? parseToolArguments(args) : args };
    }
  } catch {
    /* 不是工具调用，正常文本 */
  }
  return null;
}

// ─── OpenAI 兼容协议 ────────────────────────────────────────────────────────
export function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }))
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

// ─── Anthropic 协议 ────────────────────────────────────────────────────────
// 两个坑：
//   1. tools 用 input_schema 而不是 parameters
//   2. 工具结果要作为 user 消息里的 tool_result block，且连续多个结果必须合并进
//      同一条 user 消息，否则 API 直接报错。所以要按段合并。
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system 走顶层参数

    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: String(m.content ?? '')
      };
      const last = out[out.length - 1];
      const lastIsMergedResults =
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === 'tool_result');
      if (lastIsMergedResults) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }

    out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
  }
  return out;
}

// ─── 统一入口 ──────────────────────────────────────────────────────────────
export async function chat({ config, messages, tools, maxTokens = 2000, signal }) {
  if (config.protocol === 'anthropic') return anthropicChat({ config, messages, tools, maxTokens, signal });
  return openaiChat({ config, messages, tools, maxTokens, signal });
}

async function openaiChat({ config, messages, tools, maxTokens, signal }) {
  const url = /\/chat\/completions$/.test(config.baseUrl)
    ? config.baseUrl
    : `${config.baseUrl}/chat/completions`;

  const body = {
    model: config.model,
    messages: toOpenAIMessages(messages),
    max_tokens: maxTokens
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    body.tool_choice = 'auto';
  }

  const data = await postJson(url, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body,
    signal
  });

  const message = data.choices?.[0]?.message || {};
  let toolCalls = (message.tool_calls || [])
    .filter((c) => c?.function?.name)
    .map((c) => ({
      id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: c.function.name,
      args: parseToolArguments(c.function.arguments)
    }));

  const content = typeof message.content === 'string' ? message.content : '';

  if (!toolCalls.length) {
    const salvaged = extractTextToolCall(content);
    if (salvaged) {
      toolCalls = [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, ...salvaged }];
      return { content: '', toolCalls };
    }
  }
  return { content, toolCalls };
}

async function anthropicChat({ config, messages, tools, maxTokens, signal }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

  const body = {
    model: config.model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(messages)
  };
  if (system) body.system = system;
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }

  const data = await postJson(`${config.baseUrl}/v1/messages`, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // 扩展里没有后端，必须显式声明才允许浏览器直连
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body,
    signal
  });

  const blocks = data.content || [];
  const content = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));

  return { content, toolCalls };
}

async function postJson(url, { headers, body, signal }) {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`请求 ${url} 失败：${e.message}（检查网络/代理，或 base URL 是否正确）`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || parsed?.base_resp?.status_msg || text;
    } catch {
      /* 保持原文 */
    }
    throw new Error(`HTTP ${resp.status}: ${String(detail).slice(0, 400)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 300)}`);
  }
}
