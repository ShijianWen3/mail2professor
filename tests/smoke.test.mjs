// tests/smoke.test.mjs
// Node 层自测：agent 循环、消息翻译、参数容错。
// 浏览器 API（chrome.*）在这里跑不了，所以只测纯逻辑部分。
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeJsonString,
  parseToolArguments,
  extractTextToolCall,
  toAnthropicMessages,
  toOpenAIMessages
} from '../lib/providers.js';
import { runAgent, packToolResult, buildSystemPrompt, profileBlock } from '../lib/agent.js';
import { extractEmails, deobfuscate, looksLikeFacultyList, normalizeUrl } from '../lib/tools.js';
import { migrate, profileCompleteness, PROFILE_FIELDS, stableStringify } from '../lib/store.js';
import { providerSettings, currentApiKey, resolveConfig } from '../lib/providers.js';

const config = {
  provider: 'deepseek',
  protocol: 'openai',
  apiKey: 'test',
  baseUrl: 'https://example.com/v1',
  model: 'test-model'
};

// 按脚本顺序吐回复的假模型：用来验证循环而不是验证模型
function scriptedChat(replies) {
  let i = 0;
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return replies[i++] ?? { content: '（脚本用完了）', toolCalls: [] };
  };
  fn.calls = calls;
  return fn;
}

function echoTool(run) {
  return {
    name: 't_echo',
    description: '回显',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: [] },
    run: run || (async (args) => ({ echo: args.value }))
  };
}

const baseMessages = [
  { role: 'system', content: '你是测试助手' },
  { role: 'user', content: '开始' }
];

test('runAgent：调工具 → 回填结果 → 拿到最终回答', async () => {
  const events = [];
  const chatFn = scriptedChat([
    { content: '我先读一下页面', toolCalls: [{ id: 'c1', name: 't_echo', args: { value: 42 } }] },
    { content: '页面读完了', toolCalls: [] }
  ]);

  const result = await runAgent({
    config,
    tools: [echoTool()],
    messages: baseMessages,
    maxSteps: 5,
    onEvent: (e) => events.push(e),
    chatFn
  });

  assert.equal(result.content, '页面读完了');
  assert.equal(result.steps, 2);
  assert.equal(result.stopped, false);

  // 工具结果必须以 tool 消息挂回上下文，否则模型看不到观察结果
  const toolMessage = result.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.toolCallId, 'c1');
  assert.match(toolMessage.content, /42/);

  // assistant 的工具调用决定要留在上下文里（Anthropic 协议强制要求）
  const assistantWithCalls = result.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
  assert.ok(assistantWithCalls, 'assistant toolCalls 必须留在 messages 里');

  assert.ok(events.some((e) => e.type === 'thinking'));
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 't_echo'));
  assert.ok(events.some((e) => e.type === 'tool_end'));
  assert.ok(events.some((e) => e.type === 'final'));
});

test('runAgent：工具 schema 正确传给模型', async () => {
  const chatFn = scriptedChat([{ content: '结束', toolCalls: [] }]);
  await runAgent({ config, tools: [echoTool()], messages: baseMessages, onEvent: () => {}, chatFn });

  const passed = chatFn.calls[0].tools;
  assert.equal(passed.length, 1);
  assert.equal(passed[0].name, 't_echo');
  assert.equal(passed[0].description, '回显');
  assert.equal(passed[0].parameters.type, 'object');
});

test('runAgent：未知工具名 → 错误回填给模型，而不是崩掉', async () => {
  const chatFn = scriptedChat([
    { content: '', toolCalls: [{ id: 'c1', name: 't_not_exist', args: {} }] },
    { content: '换了个办法', toolCalls: [] }
  ]);

  const result = await runAgent({ config, tools: [echoTool()], messages: baseMessages, onEvent: () => {}, chatFn, maxSteps: 4 });
  assert.equal(result.content, '换了个办法');
  assert.match(result.messages.find((m) => m.role === 'tool').content, /没有名为 t_not_exist 的工具/);
});

test('runAgent：工具抛异常 → 错误回填（自愈能力的关键）', async () => {
  const failing = echoTool(async () => {
    throw new Error('页面超时');
  });
  const chatFn = scriptedChat([
    { content: '', toolCalls: [{ id: 'c1', name: 't_echo', args: {} }] },
    { content: '那我改用搜索', toolCalls: [] }
  ]);

  const result = await runAgent({ config, tools: [failing], messages: baseMessages, onEvent: () => {}, chatFn, maxSteps: 4 });
  assert.equal(result.content, '那我改用搜索');
  assert.match(result.messages.find((m) => m.role === 'tool').content, /工具执行失败: 页面超时/);
});

test('runAgent：步数上限会兜底停止', async () => {
  let n = 0;
  const chatFn = async () => ({
    content: `第${++n}轮还在调`,
    toolCalls: [{ id: `c${n}`, name: 't_echo', args: {} }]
  });
  const events = [];
  const result = await runAgent({ config, tools: [echoTool()], messages: baseMessages, maxSteps: 3, onEvent: (e) => events.push(e), chatFn });

  assert.equal(result.steps, 3);
  assert.equal(n, 3);
  assert.equal(result.content, '');
  assert.ok(events.some((e) => e.type === 'limit'));
});

test('runAgent：AbortSignal 生效', async () => {
  const controller = new AbortController();
  const chatFn = async () => {
    controller.abort();
    return { content: '', toolCalls: [{ id: 'c1', name: 't_echo', args: {} }] };
  };

  const result = await runAgent({
    config,
    tools: [echoTool()],
    messages: baseMessages,
    onEvent: () => {},
    chatFn,
    signal: controller.signal,
    maxSteps: 5
  });
  assert.equal(result.stopped, true);
});

test('runAgent：模型调用失败时抛错并产生 error 事件', async () => {
  const events = [];
  const chatFn = async () => {
    throw new Error('HTTP 401: invalid api key');
  };
  await assert.rejects(
    () => runAgent({ config, tools: [echoTool()], messages: baseMessages, onEvent: (e) => events.push(e), chatFn }),
    /invalid api key/
  );
  assert.ok(events.some((e) => e.type === 'error'));
});

test('toAnthropicMessages：多个工具结果必须合并进同一条 user 消息', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '做两件事' },
    {
      role: 'assistant',
      content: '并行读两个页面',
      toolCalls: [
        { id: 'a', name: 'visit_page', args: { url: 'https://x.com' } },
        { id: 'b', name: 'visit_page', args: { url: 'https://y.com' } }
      ]
    },
    { role: 'tool', toolCallId: 'a', name: 'visit_page', content: '页面A' },
    { role: 'tool', toolCallId: 'b', name: 'visit_page', content: '页面B' }
  ];

  const out = toAnthropicMessages(messages);
  assert.equal(out.length, 3); // system 被剔除，之后只有 user/assistant/user
  const toolUses = out[1].content.filter((b) => b.type === 'tool_use');
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].input.url, 'https://x.com');
  assert.equal(toolUses[1].id, 'b');
  // assistant 里既有的文本要保留，不能只发 tool_use
  assert.equal(out[1].content.filter((b) => b.type === 'text')[0].text, '并行读两个页面');

  const merged = out[2];
  assert.equal(merged.role, 'user');
  assert.equal(merged.content.length, 2, '两个 tool_result 必须在同一条 user 消息里');
  assert.deepEqual(
    merged.content.map((b) => b.tool_use_id),
    ['a', 'b']
  );
});

test('toAnthropicMessages：连续两轮工具调用不互相污染', () => {
  const out = toAnthropicMessages([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }] },
    { role: 'tool', toolCallId: 'a', name: 'x', content: 'r1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'y', args: {} }] },
    { role: 'tool', toolCallId: 'b', name: 'y', content: 'r2' }
  ]);
  assert.equal(out.length, 5);
  assert.equal(out[2].content.length, 1);
  assert.equal(out[4].content[0].tool_use_id, 'b');
});

test('toOpenAIMessages：参数序列化成字符串、content 允许为空', () => {
  const out = toOpenAIMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: { q: 'hi' } }] },
    { role: 'tool', toolCallId: 'a', name: 'x', content: 'r' }
  ]);
  assert.equal(out[0].content, null);
  assert.equal(out[0].tool_calls[0].function.arguments, '{"q":"hi"}');
  assert.equal(out[0].tool_calls[0].type, 'function');
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'a', content: 'r' });
});

test('parseToolArguments：容忍代码块、真实换行、空参数', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments(null), {});
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  // 模型在 JSON 字符串里塞了真实换行 —— sanitizeJsonString 负责救回来
  assert.deepEqual(parseToolArguments('{"body":"第一行\n第二行"}'), { body: '第一行\n第二行' });
});

test('sanitizeJsonString：把字符串值里的控制字符转义', () => {
  const fixed = sanitizeJsonString('{"a":"x\ny\tz"}');
  assert.equal(JSON.parse(fixed).a, 'x\ny\tz');
});

test('extractTextToolCall：识别正文里的工具调用，普通文本返回 null', () => {
  const call = extractTextToolCall('```json\n{"name":"read_current_page","arguments":{"max_chars":4000}}\n```');
  assert.equal(call.name, 'read_current_page');
  assert.equal(call.args.max_chars, 4000);

  assert.equal(extractTextToolCall('这是一段普通回答，没有任何调用'), null);
  assert.equal(extractTextToolCall('{"随便":"一些JSON"}'), null);
});

test('packToolResult：超长结果截断并注明原长度', () => {
  const small = packToolResult({ ok: true });
  assert.match(small, /ok/);

  const long = packToolResult('x'.repeat(9000), 100);
  assert.equal(long.length < 200, true);
  assert.match(long, /已截断，原始长度 9000/);
});

test('extractEmails：普通邮箱、去重、过滤图片名', () => {
  const { emails } = extractEmails('联系 zhang@cs.tsinghua.edu.cn，或 zhang@cs.tsinghua.edu.cn。logo@2x.png');
  assert.deepEqual(emails, ['zhang@cs.tsinghua.edu.cn']);
});

test('extractEmails：还原 (at)/(dot) 混淆，且不丢多级域名', () => {
  const text = '联系方式：zhangwei (at) cs (dot) example (dot) edu';
  const { emails, deobfuscated } = extractEmails(text);
  assert.deepEqual(emails, []);
  assert.deepEqual(deobfuscated, ['zhangwei@cs.example.edu']);
  assert.equal(deobfuscate('a [AT] b [DOT] c [DOT] cn'), 'a@b.c.cn');
});

test('looksLikeFacultyList：识别师资列表页', () => {
  const links = [
    { text: '张伟 教授', href: '/~zhang' },
    { text: '李娜 副教授', href: '/~li' },
    { text: '王强 研究员', href: '/~wang' },
    { text: '刘洋 讲师', href: '/~liu' },
    { text: '陈静 博士', href: '/~chen' },
    { text: 'Prof. John Smith', href: '/~smith' },
    { text: '招生简章', href: '/admission' }
  ];
  assert.equal(looksLikeFacultyList(links), true);
  assert.equal(looksLikeFacultyList([{ text: '首页', href: '/' }]), false);
});

test('normalizeUrl：相对链接补全、去掉锚点', () => {
  assert.equal(normalizeUrl('/~zhang#pub', 'https://cs.example.edu/index.html'), 'https://cs.example.edu/~zhang');
  assert.equal(normalizeUrl('', 'https://cs.example.edu'), '');
});

// ─── 存储结构：迁移与资料完整度 ─────────────────────────────────────────────

test('migrate：旧版扁平字段迁移到新结构（落到当时那个厂商名下）', () => {
  const state = migrate({
    apiKey: 'sk-old',
    modelProvider: 'minimax',
    myName: '李明',
    mySchool: '测试大学',
    myBackground: 'GPA 3.9，做过 NLP 项目',
    lang: 'en'
  });
  assert.equal(state.llm.provider, 'minimax');
  assert.deepEqual(state.llm.perProvider, { minimax: { apiKey: 'sk-old' } });
  assert.equal(state.profile.name, '李明');
  assert.equal(state.profile.school, '测试大学');
  assert.equal(state.profile.research, 'GPA 3.9，做过 NLP 项目');
  assert.equal(state.lang, 'en');
});

test('migrate：2.1 的单 key 结构迁移到按厂商存储', () => {
  const state = migrate({
    llm: { provider: 'glm', baseUrl: 'https://proxy.local/v4', model: 'glm-4-plus', apiKey: 'sk-glm', maxSteps: 20 }
  });
  assert.equal(state.llm.provider, 'glm');
  assert.equal(state.llm.maxSteps, 20);
  assert.deepEqual(state.llm.perProvider.glm, {
    apiKey: 'sk-glm',
    baseUrl: 'https://proxy.local/v4',
    model: 'glm-4-plus'
  });
  assert.equal(state.llm.apiKey, undefined, '旧的单 key 字段不该再留着');
});

test('migrate：新结构已存在时旧 key 不得覆盖新值', () => {
  const state = migrate({
    llm: {
      provider: 'glm',
      maxSteps: 12,
      perProvider: { glm: { apiKey: 'sk-new' }, openai: { apiKey: 'sk-openai' } }
    },
    profile: { name: '新名字' },
    provider: 'openai',
    apiKey: 'sk-stale',
    myName: '旧名字'
  });
  assert.equal(state.llm.provider, 'glm');
  assert.equal(state.llm.perProvider.glm.apiKey, 'sk-new');
  assert.equal(state.llm.perProvider.openai.apiKey, 'sk-openai');
  assert.equal(state.profile.name, '新名字', '已有新 profile 结构时，旧的扁平 myName 不该生效');
});

test('migrate：旧 flat 数据里 profile 尚未迁移时仍然生效', () => {
  // 2.0 用户升级上来的典型状态：llm 已迁移、profile 还没有
  const state = migrate({ llm: { provider: 'deepseek', perProvider: {} }, myName: '李明', myBackground: '做过 NLP' });
  assert.equal(state.profile.name, '李明');
  assert.equal(state.profile.research, '做过 NLP');
});

test('providerSettings：每个厂商各用自己那套 key / baseUrl / model', () => {
  const llm = {
    provider: 'deepseek',
    maxSteps: 12,
    perProvider: {
      deepseek: { apiKey: 'sk-deepseek' },
      openai: { apiKey: 'sk-openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local-model' }
    }
  };

  const deepseek = providerSettings(llm, 'deepseek');
  assert.equal(deepseek.apiKey, 'sk-deepseek');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/v1'); // 没自定义 → 用预设默认
  assert.equal(deepseek.model, 'deepseek-chat');

  const openai = providerSettings(llm, 'openai');
  assert.equal(openai.apiKey, 'sk-openai');
  assert.equal(openai.baseUrl, 'http://127.0.0.1:8000/v1');      // 自己配过的保留
  assert.equal(openai.model, 'local-model');

  // 从没配过的厂商：key 为空、其余用预设默认
  const glm = providerSettings(llm, 'glm');
  assert.equal(glm.apiKey, '');
  assert.equal(glm.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(glm.model, 'glm-4-flash');

  assert.equal(currentApiKey(llm), 'sk-deepseek');
  assert.equal(resolveConfig(llm).apiKey, 'sk-deepseek');
});

test('providerSettings：切厂商不会读到别人的 key', () => {
  const llm = {
    provider: 'openai',
    perProvider: { deepseek: { apiKey: 'sk-d' }, openai: { apiKey: 'sk-o' } }
  };
  assert.equal(currentApiKey(llm), 'sk-o');
  assert.equal(currentApiKey({ ...llm, provider: 'deepseek' }), 'sk-d');
  assert.equal(currentApiKey({ ...llm, provider: 'kimi' }), '');
  assert.equal(currentApiKey({}), '', '空数据也不能炸');
});

test('migrate：空数据给完整默认结构，导师库与笔记保留', () => {
  const state = migrate({});
  assert.equal(state.llm.provider, 'deepseek');
  assert.equal(state.llm.maxSteps, 12);
  assert.deepEqual(state.llm.perProvider, {});
  assert.equal(state.lang, 'zh');
  for (const field of PROFILE_FIELDS) assert.equal(state.profile[field.key], '');

  const withData = migrate({ professors: { p1: { id: 'p1', name: '张伟' } }, notes: [{ ts: 1, text: 'x' }] });
  assert.equal(withData.professors.p1.name, '张伟');
  assert.equal(withData.notes.length, 1);
});

test('migrate：脏数据不会炸（professors 不是对象 / notes 不是数组）', () => {
  const state = migrate({ professors: 'oops', notes: 'oops' });
  assert.deepEqual(state.professors, {});
  assert.deepEqual(state.notes, []);
});

test('profileCompleteness：统计已填项与缺失的核心项', () => {
  const result = profileCompleteness({ name: '李明', school: '测试大学', skills: 'PyTorch' });
  assert.equal(result.total, PROFILE_FIELDS.length);
  assert.equal(result.filled, 3);
  assert.deepEqual(result.missingCore.sort(), ['gpaRank', 'major']);
});

test('profileBlock：只输出填过的字段，缺失项明确列出', () => {
  const block = profileBlock({ name: '李明', awards: 'ICPC 区域赛银奖' }, true);
  assert.match(block, /姓名：李明/);
  assert.match(block, /竞赛奖项：ICPC 区域赛银奖/);
  assert.ok(!block.includes('- 联系电话：'), '没填的字段不能出现在画像里');
  assert.match(block, /学生没填：/);
  assert.match(block, /联系电话/); // 但要作为"缺失项"提醒
});

test('profileBlock：资料全空时明确要求不要编造', () => {
  assert.match(profileBlock({}, true), /不要编造/);
  assert.match(profileBlock({}, false), /do not invent/i);
});

test('buildSystemPrompt：竞赛奖项/科研技能进入提示词，且保留不得编造的铁律', () => {
  const prompt = buildSystemPrompt({
    lang: 'zh',
    profile: { name: '李明', skills: 'PyTorch、LaTeX', awards: 'ICPC 银奖' },
    storeBrief: '（导师库为空）',
    pageContext: '当前页面：张伟 教授'
  });
  assert.match(prompt, /科研技能：PyTorch、LaTeX/);
  assert.match(prompt, /竞赛奖项：ICPC 银奖/);
  assert.match(prompt, /绝不编造/);
  assert.match(prompt, /save_email_draft/);
  assert.match(prompt, /当前页面：张伟 教授/);
});

// ─── 写入校验用的顺序无关比较 ──────────────────────────────────────────────
// chrome.storage 读回时 key 会按字母序重排，所以校验必须忽略顺序，
// 否则每次保存都会误报"保存失败"（这个坑真踩过）

test('stableStringify：key 顺序不同视为相等', () => {
  const written = { provider: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: 'k', maxSteps: 12 };
  const readBack = { apiKey: 'k', baseUrl: 'http://x/v1', maxSteps: 12, model: 'm', provider: 'openai' };
  assert.equal(stableStringify(written), stableStringify(readBack));
  assert.notEqual(JSON.stringify(written), JSON.stringify(readBack)); // 裸 JSON.stringify 会误判
});

test('stableStringify：嵌套对象/数组同样顺序无关，且能识别真正的差异', () => {
  assert.equal(
    stableStringify({ a: { x: 1, y: [ { p: 1, q: 2 } ] } }),
    stableStringify({ a: { y: [ { q: 2, p: 1 } ], x: 1 } })
  );
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 1, b: 2 }));
  // undefined 字段按 JSON 语义丢弃，不该造成差异
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
});
