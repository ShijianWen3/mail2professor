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
import { runAgent, packToolResult } from '../lib/agent.js';
import { extractEmails, deobfuscate, looksLikeFacultyList, normalizeUrl } from '../lib/tools.js';

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
