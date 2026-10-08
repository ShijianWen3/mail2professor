// tools/e2e-verify.mjs
// 端到端自检：本机 Chrome 真实加载扩展 → 打开侧边栏 → 走真实 UI 路径配置并跑一次完整 agent 任务。
//
// 覆盖的能力（都是为了不再犯已经犯过的错）：
//   · 首次进入自动路由到「模型设置」页，配置完自动回主页
//   · 通过 UI 保存 API Key / 个人资料，真的落到 chrome.storage
//   · 个人资料（含新增的竞赛、技能、排名）会进入系统提示词
//   · 关掉侧边栏再打开：不但要持久化，而且**只显示主页**（曾经设置块一直挂着，
//     用户看到空输入框就以为没保存）
//   · 页面路由：任何时刻只允许一个页面可见
//
// 用法（在 professor-mail-extension 目录下）：
//   node tools/e2e-verify.mjs
//
// 全程使用本地 mock 模型，不碰外部 API、不需要真实 key。截图写到 tools/last-run-*.png。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const APP_PORT = 8787;
const CDP_PORT = 9333;
const EXT_DIR = resolve(import.meta.dirname, '..');
const MASK = '••••••••';

const STUDENT = {
  name: '李明',
  school: '测试大学',
  major: '计算机科学与技术',
  gpaRank: 'GPA 3.9/4.0，专业前 3%（2/65）',
  awards: 'ICPC 区域赛银奖；国家奖学金',
  skills: 'PyTorch、HuggingFace、LaTeX',
  email: 'liming@test.edu'
};

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ─── 本地假环境：导师主页 + mock 模型 ─────────────────────────────────────
const mockState = { requests: [], problems: [] };

const PROFESSOR_PAGE = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>张伟 教授 - 测试大学计算机学院</title></head>
<body>
<nav><a href="/">首页</a><a href="/faculty">师资队伍</a></nav>
<main>
  <h1>张伟 教授</h1>
  <p>测试大学计算机学院教授，博士生导师。</p>
  <p>研究方向：自然语言处理、大语言模型、跨语言信息检索、低资源学习</p>
  <p>联系方式：zhangwei (at) cs (dot) example (dot) edu</p>
  <p>近期工作：《面向低资源场景的跨语言检索》，ACL 2025。</p>
  <p>招生说明：每年招收 2 名硕士生，欢迎有 NLP 项目经验的同学。</p>
</main>
<footer>版权所有</footer>
</body></html>`;

function mockChatResponse(body, n) {
  const messages = body.messages || [];
  const toolResults = messages.filter((m) => m.role === 'tool');
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  const toolCall = (name, args) => ({
    id: `call_${n}_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  });

  const reply = (tool_calls, content = null) => ({
    id: `chatcmpl-${n}`,
    object: 'chat.completion',
    created: 0,
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content, tool_calls }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }]
  });

  // 第 0 轮：先读页面；同时检查学生资料有没有进系统提示词
  if (n === 0) {
    if (!Array.isArray(body.tools) || body.tools.length < 5) {
      mockState.problems.push(`工具 schema 没传过来：收到 ${body.tools?.length ?? 0} 个`);
    }
    if (!lastUser?.content?.includes('导师')) mockState.problems.push('用户任务没有传给模型');
    if (toolResults.length) mockState.problems.push('第一轮就出现了工具结果，说明上下文串了');
    if (!system.includes(STUDENT.name)) mockState.problems.push('系统提示词里没有学生姓名');
    if (!system.includes(STUDENT.school)) mockState.problems.push('系统提示词里没有本科院校');
    if (!system.includes(STUDENT.major)) mockState.problems.push('系统提示词里没有专业（新增字段没进提示词）');
    if (!system.includes('前 3%')) mockState.problems.push('系统提示词里没有成绩排名（新增字段没进提示词）');
    if (!system.includes('ICPC')) mockState.problems.push('系统提示词里没有竞赛奖项（新增字段没进提示词）');
    if (!system.includes('PyTorch')) mockState.problems.push('系统提示词里没有科研技能（新增字段没进提示词）');
    if (!system.includes('绝不编造')) mockState.problems.push('系统提示词丢了"不得编造"的铁律');
    return reply([toolCall('read_current_page', {})]);
  }

  // 第 1 轮：应当收到读页面的观察结果（含还原后的邮箱）
  if (n === 1) {
    const pageResult = toolResults[0]?.content || '';
    if (!pageResult.includes('张伟')) mockState.problems.push('read_current_page 没返回导师姓名');
    if (!pageResult.includes('zhangwei@cs.example.edu')) {
      mockState.problems.push(`邮箱去混淆失败：${pageResult.slice(0, 400)}`);
    }
    if (!pageResult.includes('跨语言信息检索')) mockState.problems.push('read_current_page 没返回研究方向正文');
    return reply([
      toolCall('save_professor', {
        name: '张伟',
        email: 'zhangwei@cs.example.edu',
        school: '测试大学计算机学院',
        tags: ['自然语言处理', '大语言模型', '跨语言检索'],
        summary: '做 NLP 与低资源学习，近期关注跨语言检索。',
        status: 'new'
      })
    ]);
  }

  // 第 2 轮：应当看到入库结果，然后写草稿
  if (n === 2) {
    const saved = toolResults.map((m) => m.content).join('\n');
    if (!/"saved"/.test(saved)) mockState.problems.push('save_professor 没有返回 saved 字段');
    if (!/p_/.test(saved)) mockState.problems.push('save_professor 没有返回导师 id');
    return reply([
      toolCall('save_email_draft', {
        to: 'zhangwei@cs.example.edu',
        subject: '申请加入课题组 - 测试大学 李明',
        professor_name: '张伟',
        body: '尊敬的张伟老师：\n\n您好！我是测试大学计算机科学与技术专业的李明，GPA 3.9/4.0（专业前 3%），想申请加入您的课题组。\n\n祝好\n李明'
      })
    ]);
  }

  // 第 3 轮：收尾
  return reply(null, '已完成：读取了导师主页，邮箱为 zhangwei@cs.example.edu，已存入导师库并生成邮件草稿。');
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/prof') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PROFESSOR_PAGE);
  }
  if (req.method === 'GET' && req.url === '/__report') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(mockState));
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const reply = mockChatResponse(body, mockState.requests.length);
        mockState.requests.push({
          messageCount: body.messages?.length,
          roles: body.messages?.map((m) => m.role).join(','),
          tools: body.tools?.map((t) => t.function?.name)
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(reply));
      } catch (e) {
        mockState.problems.push(`mock 解析请求失败: ${e.message}`);
        res.writeHead(400).end('{}');
      }
    });
    return;
  }
  res.writeHead(404).end('not found');
});

const listen = (port) =>
  new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });

// ─── 极简 CDP 客户端（Node 22 自带 WebSocket）─────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => this.#handle(JSON.parse(event.data)));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', (e) => fail(new Error(`WebSocket 连接失败: ${e.message || 'unknown'}`)), { once: true });
    });
    return new CDP(ws);
  }

  #handle(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { ok, fail } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message} (${msg.error.code})`)) : ok(msg.result);
      return;
    }
    this.listeners.forEach((fn) => fn(msg));
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      setTimeout(() => {
        if (this.pending.delete(id)) fail(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
    });
  }
}

async function httpJson(path) {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return resp.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(interval);
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
let chrome;
let profileDir;
let cdp;
let panel = null;
const panelExceptions = [];

async function ev(expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    panel.sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(`页面内执行出错: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result.result.value;
}

const click = (selector) => ev(`(document.querySelector(${JSON.stringify(selector)}).click(), 'ok')`);

const fill = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);

// 当前可见的页面（期望任何时刻只有一个）
const visiblePages = () =>
  ev(`(() => ['home','task','result','crm','profile','model']
        .filter((p) => getComputedStyle(document.getElementById('page-' + p)).display !== 'none'))()`);

const storage = (key) =>
  ev(`chrome.storage.local.get(${JSON.stringify(key)}).then((d) => d[${JSON.stringify(key)}] ?? null)`);

async function openPanel(label) {
  const target = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  panel = { targetId: target.targetId, sessionId };

  const url = await waitFor(async () => {
    const href = await ev(`location.href`);
    if (/^chrome-error:/.test(href)) throw new Error(`侧边栏页面打不开：${href}`);
    return /^chrome-extension:/.test(href) ? href : null;
  }, { timeout: 10000, label: '侧边栏页面加载' });

  await sleep(1200); // 等 init() 跑完
  if (label) console.log(`   (${label})`);
  return url;
}

// 截图只是为了人工看一眼，失败不该影响验证结论
async function capture(name) {
  try {
    await cdp.send('Target.activateTarget', { targetId: panel.targetId }).catch(() => {});
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, panel.sessionId, 8000);
    const path = join(EXT_DIR, 'tools', name);
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    return path;
  } catch (e) {
    return `截图失败（不影响结论）: ${e.message}`;
  }
}

let extensionId = '';

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) throw new Error('没找到 Chrome/Edge，跳过端到端验证');
  record('找到浏览器', true, chromePath);

  await listen(APP_PORT);
  record('本地 mock 环境启动', true, `http://127.0.0.1:${APP_PORT}/prof`);

  profileDir = mkdtempSync(join(tmpdir(), 'mp-e2e-'));
  chrome = spawn(
    chromePath,
    [
      '--headless',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      // Chrome 137+ 已禁用 --load-extension（防侧载），改走 CDP 的 Extensions.loadUnpacked
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const version = await waitFor(() => httpJson('/json/version'), { timeout: 20000, label: 'Chrome 调试端口' });
  record('Chrome 启动', true, version.Browser);

  cdp = await CDP.connect(version.webSocketDebuggerUrl);
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      panelExceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
    }
  });

  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  extensionId = loaded?.id || '';
  record('扩展已加载', true, extensionId);

  const worker = await waitFor(
    async () => (await httpJson('/json/list')).find((t) => /\/background\.js$/.test(t.url || '')),
    { timeout: 10000, label: 'background service worker' }
  );
  record('background.js 已运行', true, worker.url);

  // 导师主页：让它成为活动标签页（read_current_page 读的就是活动标签页）
  const prof = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${APP_PORT}/prof` });
  await cdp.send('Target.activateTarget', { targetId: prof.targetId });
  await sleep(1000);

  // ── ① 首次打开：应当自动进入模型设置页
  await openPanel('首次打开');
  const firstPages = await visiblePages();
  record('首次进入自动进「模型设置」页', firstPages.length === 1 && firstPages[0] === 'model', firstPages.join(','));
  const firstNotice = await ev(`document.getElementById('model-notice').textContent.trim()`);
  record('模型页有首次使用提示', firstNotice.includes('首次使用'), firstNotice.slice(0, 40));

  // ── ② 通过真实 UI 保存 API Key 与 provider（每个厂商一套，先切厂商再填值）
  await click('.model-btn[data-provider="openai"]');
  await sleep(800); // 切厂商是异步的（会先把当前厂商的改动存下来）
  await fill('#model-api-key', 'sk-test-e2e');
  await fill('#model-base-url', `http://127.0.0.1:${APP_PORT}/v1`);
  await fill('#model-name', 'mock-1');
  await click('#model-save-btn');
  await sleep(400);

  const savedLlm = await storage('llm');
  record(
    '当前厂商的 Key 与配置写进 storage',
    savedLlm?.provider === 'openai' &&
      savedLlm?.perProvider?.openai?.apiKey === 'sk-test-e2e' &&
      savedLlm?.perProvider?.openai?.baseUrl === `http://127.0.0.1:${APP_PORT}/v1` &&
      savedLlm?.perProvider?.openai?.model === 'mock-1',
    JSON.stringify(savedLlm?.perProvider?.openai)
  );
  const modelTip = await ev(`document.getElementById('model-tip').textContent.trim()`);
  record('保存后显示真实结果（不是无条件 ✓）', modelTip.includes('保存'), modelTip);

  // ── ②b 切厂商：Key 分开存，互不覆盖
  await sleep(900); // 首次配置成功会自动回主页
  await click('.nav-btn[data-goto="model"]');
  await sleep(300);
  await click('.model-btn[data-provider="deepseek"]');
  await sleep(800);
  const deepseekKeyField = await ev(`document.getElementById('model-api-key').value`);
  record('切到 DeepSeek 后 Key 框是空的（不显示别家的 key）', deepseekKeyField === '', deepseekKeyField || '(空)');
  const deepseekBase = await ev(`document.getElementById('model-base-url').value`);
  record('切到 DeepSeek 后 BASE URL 用它自己的默认值', deepseekBase.includes('deepseek.com'), deepseekBase);

  await fill('#model-api-key', 'sk-deepseek-e2e');
  await sleep(1100); // 等自动保存
  await click('.model-btn[data-provider="openai"]');
  await sleep(800);
  const backToOpenai = await ev(`document.getElementById('model-api-key').value`);
  const openaiBase = await ev(`document.getElementById('model-base-url').value`);
  const bothKeys = await storage('llm');
  record('切回 OpenAI 后仍是它自己的 Key（掩码）', backToOpenai === MASK, backToOpenai || '(空)');
  record('切回 OpenAI 后自定义 BASE URL 也还在', openaiBase === `http://127.0.0.1:${APP_PORT}/v1`, openaiBase);
  record(
    '两家 Key 同时存在且互不覆盖',
    bothKeys?.perProvider?.openai?.apiKey === 'sk-test-e2e' &&
      bothKeys?.perProvider?.deepseek?.apiKey === 'sk-deepseek-e2e',
    JSON.stringify(bothKeys?.perProvider)
  );

  await click('#header-back');
  await sleep(300);
  const afterSavePages = await visiblePages();
  record('回到主页', afterSavePages.length === 1 && afterSavePages[0] === 'home', afterSavePages.join(','));
  const homeModelMeta = await ev(`document.getElementById('home-model-meta').textContent.trim()`);
  record('主页显示当前模型', homeModelMeta.includes('mock-1'), homeModelMeta);
  const homeNotice = await ev(`document.getElementById('home-notice').textContent.trim()`);
  record('主页提醒还缺资料', homeNotice.includes('还缺'), homeNotice.slice(0, 50));

  // ── ③ 通过真实 UI 填个人资料（自动保存）
  await click('.nav-btn[data-goto="profile"]');
  await sleep(300);
  const profilePages = await visiblePages();
  record('进入「我的资料」页', profilePages.length === 1 && profilePages[0] === 'profile', profilePages.join(','));

  const fieldCount = await ev(`document.querySelectorAll('#profile-form [data-field]').length`);
  record('资料表单字段已扩充', fieldCount >= 9, `${fieldCount} 个字段`);
  for (const [key, value] of Object.entries(STUDENT)) {
    await fill(`#profile-form [data-field="${key}"]`, value);
  }
  await sleep(1300); // 等自动保存（debounce 700ms）

  const savedProfile = await storage('profile');
  const profileOk = savedProfile && Object.entries(STUDENT).every(([k, v]) => savedProfile[k] === v);
  record('个人资料自动保存到 storage', profileOk, profileOk ? '' : JSON.stringify(savedProfile));
  const profileTip = await ev(`document.getElementById('profile-tip').textContent.trim()`);
  record('资料页显示已自动保存', profileTip.includes('自动保存'), profileTip);
  await cdp.send('Target.activateTarget', { targetId: panel.targetId }).catch(() => {});
  record('资料页截图已保存', true, await capture('last-run-profile.png'));

  await click('#header-back');
  await sleep(300);
  const homeMeta = await ev(`document.getElementById('home-profile-meta').textContent.trim()`);
  record('主页显示资料完整度且不再报缺', homeMeta.includes('已填') && !homeMeta.includes('还缺'), homeMeta);

  // ── ④ 跑一次完整 agent 任务
  await click('#go-task-btn');
  await sleep(400);
  const taskPages = await visiblePages();
  record('进入任务页', taskPages.length === 1 && taskPages[0] === 'task', taskPages.join(','));

  // 任务框要能完整显示默认文案，推荐任务要能看到整段提示词
  const taskBox = await ev(`(() => {
    const el = document.getElementById('task-input');
    const presets = [...document.querySelectorAll('#task-chips .preset-item')];
    return {
      valueLength: el.value.length,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      presetCount: presets.length,
      presetTextLengths: presets.map((item) => item.querySelector('.preset-text')?.textContent.trim().length || 0),
      presetTitles: presets.map((item) => item.querySelector('.preset-title')?.textContent.trim() || '')
    };
  })()`);
  record(
    '任务输入框完整显示默认文案（不出现滚动条）',
    taskBox.valueLength > 50 && taskBox.scrollHeight <= taskBox.clientHeight + 2,
    `${taskBox.valueLength} 字 / client=${taskBox.clientHeight} scroll=${taskBox.scrollHeight}`
  );
  record(
    '推荐任务完整展示（不再是截断的 chip）',
    taskBox.presetCount === 3 && taskBox.presetTextLengths.every((n) => n > 40),
    `${taskBox.presetTitles.join(' / ')} → 长度 ${taskBox.presetTextLengths.join(',')}`
  );
  record('任务页截图已保存', true, await capture('last-run-task.png'));

  await cdp.send('Target.activateTarget', { targetId: prof.targetId });
  await sleep(400);
  await click('#run-btn');

  const finished = await waitFor(async () => {
    const state = await ev(`(() => {
      const box = document.querySelector('#task-status-area .status-box');
      const text = box?.textContent || '';
      if (!text) return null;
      if (text.includes('AI 调用失败') || text.includes('已手动停止')) return { ok: false, text };
      if (text.includes('完成')) return { ok: true, text };
      return null;
    })()`);
    return state;
  }, { timeout: 40000, interval: 400, label: 'agent 运行结束' });
  record('agent 任务跑完', finished.ok, finished.text.trim());

  await sleep(600);
  const resultPages = await visiblePages();
  record('跑完自动进「确认邮件」页', resultPages.length === 1 && resultPages[0] === 'result', resultPages.join(','));

  const draft = await ev(`({
    to: document.getElementById('email-to').value,
    subject: document.getElementById('email-subject').value,
    body: document.getElementById('email-body').value
  })`);
  record('邮件草稿渲染完整', draft.to === 'zhangwei@cs.example.edu' && draft.body.includes('尊敬的张伟老师'), `收件人=${draft.to}`);
  const traceTools = await ev(`[...document.querySelectorAll('#trace-body .trace-tool')].map((el) => el.textContent).join(' ')`);
  record(
    'trace 覆盖读页面 → 入库 → 写草稿',
    ['read_current_page', 'save_professor', 'save_email_draft'].every((name) => traceTools.includes(name)),
    ''
  );

  const professors = await storage('professors');
  const profRecord = Object.values(professors || {})[0] || {};
  record('导师已入库且状态推进', profRecord.name === '张伟' && profRecord.status === 'drafted', JSON.stringify({ name: profRecord.name, status: profRecord.status }));

  await click('#header-back');
  await sleep(300);
  await click('.nav-btn[data-goto="crm"]');
  await sleep(300);
  const crmPages = await visiblePages();
  const crmRows = await ev(`document.querySelectorAll('#pipeline-list .prof-row').length`);
  record('导师库页可见且有记录', crmPages.length === 1 && crmPages[0] === 'crm' && crmRows === 1, `rows=${crmRows}`);

  await cdp.send('Target.activateTarget', { targetId: panel.targetId }).catch(() => {});
  record('导师库截图已保存', true, await capture('last-run-crm.png'));

  // ── ⑤ 关掉侧边栏再打开：持久化 + 只显示主页（用户报过的两个 bug）
  await cdp.send('Target.closeTarget', { targetId: panel.targetId });
  await sleep(500);
  await openPanel('重新打开');

  const reopenPages = await visiblePages();
  record('重开后只显示主页（不再要求重填）', reopenPages.length === 1 && reopenPages[0] === 'home', reopenPages.join(','));
  const reopenHomeMeta = await ev(`document.getElementById('home-model-meta').textContent.trim()`);
  const reopenProfileMeta = await ev(`document.getElementById('home-profile-meta').textContent.trim()`);
  record('重开后模型配置仍在', reopenHomeMeta.includes('mock-1'), reopenHomeMeta);
  record('重开后资料完整度仍在', reopenProfileMeta.includes('已填'), reopenProfileMeta);
  record('主页截图已保存', true, await capture('last-run-home.png'));

  await click('.nav-btn[data-goto="profile"]');
  await sleep(300);
  const restored = await ev(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('#profile-form [data-field]')) out[el.dataset.field] = el.value;
    return out;
  })()`);
  record(
    '重开后个人资料逐项恢复',
    Object.entries(STUDENT).every(([k, v]) => restored[k] === v),
    Object.entries(STUDENT).map(([k]) => `${k}=${restored[k] ? '✓' : '✗'}`).join(' ')
  );

  await click('#header-back');
  await sleep(200);
  await click('.nav-btn[data-goto="model"]');
  await sleep(300);
  const maskValue = await ev(`document.getElementById('model-api-key').value`);
  record('重开后 Key 以掩码显示', maskValue === MASK, maskValue || '(空)');
  record('模型页截图已保存', true, await capture('last-run-model.png'));

  // ── ⑥ mock 侧与页面异常
  const report = await (await fetch(`http://127.0.0.1:${APP_PORT}/__report`)).json();
  record('模型被调用了 4 轮', report.requests.length === 4, report.requests.map((r) => r.tools?.length).join(','));
  record('mock 侧断言全过（含资料进入提示词）', report.problems.length === 0, report.problems.join('; '));
  record('浏览器无 JS 异常', panelExceptions.length === 0, panelExceptions.slice(0, 2).join(' | '));
}

main()
  .catch((e) => record('端到端验证', false, `${e.message}`))
  .finally(async () => {
    server.close();
    if (chrome) {
      chrome.kill();
      await sleep(500);
    }
    if (profileDir) {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* Windows 可能还锁着，忽略 */ }
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
    if (failed.length) {
      console.log('失败项：');
      failed.forEach((f) => console.log(` - ${f.name}: ${f.detail}`));
      process.exitCode = 1;
    }
  });
