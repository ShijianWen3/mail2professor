// tools/e2e-verify.mjs
// 端到端自检：本机 Chrome 真实加载扩展 → 打开侧边栏页面 → 用本地 mock 模型跑一次完整 agent 任务。
//
// 为什么值得写：单元测试只能证明循环逻辑对，证明不了"扩展能装上、模块能加载、DOM 绑定没错、
// chrome.tabs/chrome.storage 用对了"。这个脚本把这些全覆盖，而且不调用任何外部 API。
//
// 用法（在 professor-mail-extension 目录下）：
//   node tools/e2e-verify.mjs
//
// 它会打印每一步的结论，失败时退出码为 1，并把侧边栏截图写到 tools/last-run.png。

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

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ─── 1. 本地假环境：导师主页 + mock 模型 ─────────────────────────────────────
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

  // 第 0 轮：模型应该先读页面
  if (n === 0) {
    if (!Array.isArray(body.tools) || body.tools.length < 5) {
      mockState.problems.push(`工具 schema 没传过来：收到 ${body.tools?.length ?? 0} 个`);
    }
    if (!lastUser?.content?.includes('导师')) {
      mockState.problems.push('用户任务没有传给模型');
    }
    if (toolResults.length) mockState.problems.push('第一轮就出现了工具结果，说明上下文串了');
    return reply([toolCall('read_current_page', {})]);
  }

  // 第 1 轮：应当收到读页面的观察结果，其中必须含真实姓名与还原后的邮箱
  if (n === 1) {
    const pageResult = toolResults[0]?.content || '';
    if (!pageResult.includes('张伟')) mockState.problems.push('read_current_page 没返回导师姓名');
    if (!pageResult.includes('zhangwei@cs.example.edu')) {
      mockState.problems.push(`邮箱去混淆失败，观察结果里没有 zhangwei@cs.example.edu：${pageResult.slice(0, 400)}`);
    }
    if (!pageResult.includes('跨语言信息检索')) mockState.problems.push('read_current_page 没返回研究方向正文');
    if (!pageResult.includes('"pageType"')) mockState.problems.push('read_current_page 没有返回 pageType');
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
        body: '尊敬的张伟老师：\n\n您好！我是测试大学计算机学院的李明，想申请加入您的课题组。\n\n祝好\n李明'
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

// ─── 2. 极简 CDP 客户端（Node 22 自带 WebSocket）─────────────────────────────
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

// 在扩展页面里跑一段代码，返回它的值
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(`页面内执行出错: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result.result.value;
}

// ─── 3. 主流程 ──────────────────────────────────────────────────────────────
let chrome;
let profileDir;

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

  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const browserExceptions = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      browserExceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
    }
  });

  // 装扩展：拿到的 id 用于后面打开 sidepanel 页面
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const extensionId = loaded?.id || (await waitFor(async () => {
    const targets = await httpJson('/json/list');
    const hit = targets.find((t) => /\/background\.js$/.test(t.url || ''));
    return hit ? new URL(hit.url).host : null;
  }, { timeout: 10000, label: '扩展 ID' }));
  record('扩展已加载', true, extensionId);

  // 等 background service worker 起来，并把它的异常也纳入监控
  const extensionWorker = await waitFor(
    async () => (await httpJson('/json/list')).find((t) => /\/background\.js$/.test(t.url || '')),
    { timeout: 10000, label: 'background service worker' }
  );
  record('background.js 已运行', true, extensionWorker.url);

  // 先开侧边栏页面（稍后会被后面的标签页挤成后台标签，模拟真实侧边栏语义）
  const panel = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const panelUrl = await waitFor(
    async () => {
      const href = await evaluate(cdp, sessionId, `location.href`);
      if (/^chrome-error:/.test(href)) throw new Error(`侧边栏页面打不开：${href}`);
      return /^chrome-extension:/.test(href) ? href : null;
    },
    { timeout: 10000, label: '侧边栏页面加载' }
  );
  record('侧边栏页面打开', panelUrl.endsWith('/sidepanel.html'), panelUrl);

  // 再开导师主页，并显式激活它 —— read_current_page 读的是"当前活动标签页"
  const prof = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${APP_PORT}/prof` });
  await cdp.send('Target.activateTarget', { targetId: prof.targetId });
  await sleep(1500);
  const activeUrl = await evaluate(cdp, sessionId, `chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.url || '')`);
  record('当前活动标签页是导师主页', activeUrl.includes('/prof'), activeUrl);

  // 写入设置：指向本地 mock 模型
  await evaluate(
    cdp,
    sessionId,
    `chrome.storage.local.set({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:${APP_PORT}/v1',
      model: 'mock-1',
      apiKey: 'sk-test',
      myName: '李明',
      mySchool: '测试大学',
      myBackground: '计算机科学 GPA 3.9/4.0，做过 NLP 课程项目',
      lang: 'zh',
      maxSteps: 8
    }).then(() => 'ok')`
  );
  await cdp.send('Page.reload', {}, sessionId);
  await sleep(1500);

  const booted = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const ids = ['setup-view','info-section','main-view','result-view','pipeline-view','settings-view',
                   'setup-provider-selector','settings-provider-selector','task-input','run-btn','stop-btn',
                   'trace-panel','email-to','email-subject','email-body','pipeline-list'];
      const missing = ids.filter((id) => !document.getElementById(id));
      const visible = [...document.querySelectorAll('body > div')]
        .filter((el) => el.offsetParent !== null || getComputedStyle(el).display !== 'none')
        .map((el) => el.id).filter(Boolean);
      return {
        missing,
        providerChips: document.querySelectorAll('#setup-provider-selector .model-btn').length,
        taskChips: document.querySelectorAll('#task-chips .chip').length,
        taskLength: document.getElementById('task-input')?.value.length || 0,
        visible,
        headerSub: document.getElementById('header-sub')?.textContent,
        hasChromeStorage: typeof chrome?.storage?.local?.get === 'function'
      };
    })()`
  );

  record('侧边栏 DOM 完整', booted.missing.length === 0, booted.missing.length ? `缺: ${booted.missing}` : '所有关键节点都在');
  record('模型商快捷按钮渲染', booted.providerChips === 7, `${booted.providerChips} 个`);
  record('任务预设渲染', booted.taskChips === 3, `${booted.taskChips} 个`);
  record('默认任务已填入', booted.taskLength > 20, `${booted.taskLength} 字`);
  record('主界面可见（已读到已保存设置）', booted.visible.includes('main-view'), booted.visible.join(', '));
  record('扩展权限可用', booted.hasChromeStorage === true, booted.headerSub);

  // 点击开始，让 agent 真的跑起来
  await evaluate(cdp, sessionId, `document.getElementById('run-btn').click(), 'clicked'`);
  record('已触发 agent 运行', true);

  const finished = await waitFor(
    async () => {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const box = document.querySelector('#status-area .status-box');
          const text = box?.textContent || '';
          if (!text) return null;
          if (text.includes('AI 调用失败') || text.includes('已手动停止')) return { ok: false, text };
          if (text.includes('完成') || text.includes('没有生成')) return { ok: true, text };
          return null;
        })()`
      );
      return state;
    },
    { timeout: 40000, interval: 400, label: 'agent 运行结束' }
  );
  record('agent 任务跑完', finished.ok, finished.text.trim());

  const after = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('#pipeline-list .prof-row')];
      return {
        resultVisible: getComputedStyle(document.getElementById('result-view')).display !== 'none',
        to: document.getElementById('email-to').value,
        subject: document.getElementById('email-subject').value,
        body: document.getElementById('email-body').value,
        bodyLength: document.getElementById('email-body').value.length,
        traceRows: document.querySelectorAll('#trace-body .trace-row').length,
        toolRows: [...document.querySelectorAll('#trace-body .trace-tool')].map((el) => el.textContent),
        pipelineRows: rows.length
      };
    })()`
  );

  record('邮件草稿进入确认面板', after.to === 'zhangwei@cs.example.edu' && after.subject.length > 0, `收件人=${after.to}`);
  record('邮件正文已渲染', after.bodyLength > 20 && after.body.includes('尊敬的张伟老师'), `${after.bodyLength} 字`);
  record('trace 显示了工具调用', after.toolRows.length >= 3, after.toolRows.join(' | ').slice(0, 300));
  record(
    'trace 覆盖读页面 → 入库 → 写草稿',
    ['read_current_page', 'save_professor', 'save_email_draft'].every((name) => after.toolRows.join(' ').includes(name)),
    ''
  );

  const stored = await evaluate(
    cdp,
    sessionId,
    `chrome.storage.local.get('professors').then((d) => {
      const list = Object.values(d.professors || {});
      const p = list[0] || {};
      return { count: list.length, name: p.name, email: p.email, status: p.status, tags: p.tags, drafts: (p.drafts || []).length };
    })`
  );
  record('导师已入库', stored.count === 1 && stored.name === '张伟', JSON.stringify(stored));
  record('入库状态推进到 drafted', stored.status === 'drafted', stored.status);
  record('草稿留存在导师记录里', stored.drafts === 1, `${stored.drafts} 份`);

  // mock 侧的断言：模型实际收到了什么
  const report = await (await fetch(`http://127.0.0.1:${APP_PORT}/__report`)).json();
  record('模型被调用了 4 轮', report.requests.length === 4, report.requests.map((r) => r.tools?.length).join(','));
  record('mock 侧无异常', report.problems.length === 0, report.problems.join('; '));
  record('浏览器无 JS 异常', browserExceptions.length === 0, browserExceptions.slice(0, 2).join(' | '));

  // 视图可见性 + 面板切换（DOM 有值不等于用户看得见，所以要查 computed display）
  const visibility = () =>
    evaluate(
      cdp,
      sessionId,
      `(() => {
        const ids = ['setup-view','info-section','main-view','result-view','pipeline-view','settings-view'];
        const vis = {};
        ids.forEach((id) => { vis[id] = getComputedStyle(document.getElementById(id)).display !== 'none'; });
        return vis;
      })()`
    );

  // 截图只是为了人工看一眼，失败不该影响验证结论
  await cdp.send('Target.activateTarget', { targetId: panel.targetId }).catch(() => {});
  const capture = async (name) => {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId, 8000);
      const p = join(EXT_DIR, 'tools', name);
      writeFileSync(p, Buffer.from(shot.data, 'base64'));
      return p;
    } catch (e) {
      return `截图失败（不影响结论）: ${e.message}`;
    }
  };

  const v1 = await visibility();
  record('结果面板真的可见', v1['result-view'] === true && v1['main-view'] === false, JSON.stringify(v1));
  record('截图已保存', true, await capture('last-run-result.png'));

  await evaluate(cdp, sessionId, `(document.getElementById('back-btn').click(), 'ok')`);
  await sleep(300);
  const v2 = await visibility();
  record('返回后主视图可见、trace 保留', v2['main-view'] === true && v2['result-view'] === false, JSON.stringify(v2));

  await evaluate(cdp, sessionId, `(document.getElementById('open-pipeline-btn').click(), 'ok')`);
  await sleep(400);
  const v3 = await visibility();
  const rows = await evaluate(cdp, sessionId, `document.querySelectorAll('#pipeline-list .prof-row').length`);
  const statusValue = await evaluate(cdp, sessionId, `document.querySelector('#pipeline-list .status-select')?.value`);
  record('导师库面板可见且有记录', v3['pipeline-view'] === true && rows === 1 && statusValue === 'drafted', `rows=${rows} status=${statusValue}`);
  record('导师库截图已保存', true, await capture('last-run-pipeline.png'));

  await evaluate(cdp, sessionId, `(document.getElementById('pipeline-back-btn').click(), document.getElementById('open-settings-btn').click(), 'ok')`);
  await sleep(400);
  const v4 = await visibility();
  record('设置面板可见', v4['settings-view'] === true, JSON.stringify(v4));
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
