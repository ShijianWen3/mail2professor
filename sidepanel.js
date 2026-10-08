// sidepanel.js —— UI 层：任务输入、agent trace 渲染、邮件确认、导师库
//
// 分工：
//   lib/providers.js  各家 API → 统一工具调用
//   lib/agent.js      ReAct 循环（注入 chatFn 即可换成 Python 后端）
//   lib/tools.js      agent 的浏览器工具
//   lib/store.js      导师库 + 设置
//   sidepanel.js      只负责界面和状态

import { PRESETS, presetOf, resolveConfig } from './lib/providers.js';
import { Store, getSettings, setSettings, STATUSES } from './lib/store.js';
import { runAgent, buildSystemPrompt, DEFAULT_MAX_STEPS, describeProvider } from './lib/agent.js';
import { createTools } from './lib/tools.js';

// ─── 文案 ───────────────────────────────────────────────────────────────────
const i18n = {
  en: {
    setupDesc: 'Pick a provider and paste your API Key. The agent reads pages, searches, keeps a professor CRM and drafts the email itself.',
    providerLabel: 'PROVIDER', modelLabel: 'MODEL',
    apiKeyLabel: 'API KEY', saveBtn: 'Save', saved: '✓ Saved',
    yourName: 'Your Name', yourSchool: 'Your School', background: 'Major / GPA / Background',
    saveInfo: 'Save Info', changeKey: 'CHANGE API KEY', maxSteps: 'MAX STEPS PER TASK',
    taskLabel: 'TASK FOR THE AGENT', runBtn: '▶ Run', stopBtn: '■ Stop',
    taskDefault: 'Analyze the professor page I have open: confirm name, email, 3-6 research keywords and a short summary, save to the CRM, then draft a personalized email I can send after review.',
    taskDig: 'Research the professor on my current page: search their recent papers and lab homepage, find 3 concrete research angles I could contribute to, then rewrite a stronger email based on them.',
    taskFaculty: 'My current page may be a faculty listing: save each professor to the CRM (name + homepage link), then tell me how many there are and who has an email.',
    pipelineLink: '📚 Professor CRM', settings: '⚙ Settings', backToMain: '← Back',
    exportBtn: 'Export JSON',
    toLabel: 'TO', subjectLabel: 'SUBJECT', bodyLabel: 'BODY',
    back: '← Back', sendEmail: '📨 Open Mail', copyToClipboard: '📋 Copy', copied: '✓ Copied!',
    markContacted: '✓ Mark contacted', markedContacted: '✓ Marked as contacted',
    traceTitle: 'AGENT TRACE',
    thinking: (step) => `Step ${step}: thinking…`,
    running: 'The agent is working. Steps are shown below.',
    stopped: 'Stopped by user.',
    doneWithDraft: 'Done. The email draft is below — review and send.',
    doneNoDraft: 'Done. The agent did not produce an email draft.',
    errorApiKey: 'Please set your API Key first',
    errorContent: 'Cannot read page, please refresh and retry',
    aiError: 'AI error: ',
    emptyPipeline: 'No professors saved yet. Run a task on a professor page and the agent will fill this in.',
    pipelineCount: (n) => `${n} professor(s)`,
    status: { new: 'New', drafted: 'Drafted', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', offer: 'Offer', declined: 'Declined', archived: 'Archived' },
    observation: (len) => `observation · ${len} chars`,
    noEmailAlert: 'No recipient yet — fill it in manually before sending.'
  },
  zh: {
    setupDesc: '选择模型商并填写 API Key。Agent 会自己读页面、搜索、维护导师库并起草邮件。',
    providerLabel: '选择模型商', modelLabel: '模型',
    apiKeyLabel: 'API KEY', saveBtn: '保存', saved: '✓ 已保存',
    yourName: '你的姓名', yourSchool: '本科院校', background: '专业 / GPA / 简要背景',
    saveInfo: '保存个人信息', changeKey: '修改 API KEY', maxSteps: '单次任务最大步数',
    taskLabel: '给 agent 的任务', runBtn: '▶ 开始', stopBtn: '■ 停止',
    taskDefault: '请分析我当前打开的这位导师的主页：确认他的姓名、邮箱、研究方向（3-6 个关键词）和一两句研究总结，存入导师库，然后起草一封我确认后就能发的联系邮件。',
    taskDig: '请深入调研我当前打开这位导师：搜索他近两年的论文和课题组主页，找出 3 个我能具体切入的研究点，然后据此写一封更有说服力的邮件。',
    taskFaculty: '我当前打开的可能是院系师资列表页：先把页面上的导师逐个存入导师库（姓名 + 主页链接），读完再告诉我总共几位、哪些有邮箱。',
    pipelineLink: '📚 导师库', settings: '⚙ 设置', backToMain: '← 返回',
    exportBtn: '导出 JSON',
    toLabel: '收件人', subjectLabel: '邮件主题', bodyLabel: '邮件正文',
    back: '← 返回', sendEmail: '📨 打开邮件客户端', copyToClipboard: '📋 复制邮件', copied: '✓ 已复制',
    markContacted: '✓ 标记为已联系', markedContacted: '✓ 已标记',
    traceTitle: 'AGENT TRACE',
    thinking: (step) => `第 ${step} 步：思考中…`,
    running: 'agent 正在工作，过程见下方。',
    stopped: '已手动停止。',
    doneWithDraft: '完成，邮件草稿见下方，确认后发送。',
    doneNoDraft: '完成，本次没有生成邮件草稿。',
    errorApiKey: '请先设置 API Key',
    errorContent: '无法读取页面，请刷新后重试',
    aiError: 'AI 调用失败：',
    emptyPipeline: '导师库还是空的。在导师主页上跑一次任务，agent 会自动填进来。',
    pipelineCount: (n) => `共 ${n} 位导师`,
    status: { new: '待联系', drafted: '已起草', contacted: '已联系', replied: '已回复', meeting: '已约聊', offer: '有offer', declined: '已婉拒', archived: '归档' },
    observation: (len) => `观察结果 · ${len} 字`,
    noEmailAlert: '还没有收件人，请手动填写后再发送。'
  }
};

let currentLang = 'zh';
const t = (key) => i18n[currentLang]?.[key] ?? i18n.zh[key] ?? key;
const statusLabel = (status) => t('status')[status] || status;

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const views = {
  setup: $('setup-view'), info: $('info-section'), main: $('main-view'),
  result: $('result-view'), pipeline: $('pipeline-view'), settings: $('settings-view')
};

const setupProviderSel = $('setup-provider-selector');
const setupBaseUrl = $('setup-base-url');
const setupModel = $('setup-model');
const apiKeyInput = $('api-key-input');
const saveKeyBtn = $('save-key-btn');
const setupStatus = $('setup-status');

const myName = $('my-name');
const mySchool = $('my-school');
const myBackground = $('my-background');
const saveInfoBtn = $('save-info-btn');
const infoSavedTip = $('info-saved-tip');

const taskInput = $('task-input');
const taskChips = $('task-chips');
const runBtn = $('run-btn');
const stopBtn = $('stop-btn');
const statusArea = $('status-area');
const tracePanel = $('trace-panel');
const traceTitle = $('trace-title');
const traceBody = $('trace-body');

const profNameEl = $('prof-name-el');
const profEmailEl = $('prof-email-el');
const profTagsEl = $('prof-tags-el');
const profResearchEl = $('prof-research-el');
const emailTo = $('email-to');
const emailSubject = $('email-subject');
const emailBody = $('email-body');
const backBtn = $('back-btn');
const sendBtn = $('send-btn');
const copyBtn = $('copy-btn');
const markContactedBtn = $('mark-contacted-btn');

const pipelineCountEl = $('pipeline-count');
const pipelineList = $('pipeline-list');

const settingsProviderSel = $('settings-provider-selector');
const settingsBaseUrl = $('settings-base-url');
const settingsModel = $('settings-model');
const settingsKeyInput = $('settings-key-input');
const settingsMaxSteps = $('settings-max-steps');
const settingsName = $('settings-name');
const settingsSchool = $('settings-school');
const settingsBackground = $('settings-background');
const settingsSaveBtn = $('settings-save-btn');
const settingsBackBtn = $('settings-back-btn');
const settingsTip = $('settings-tip');
const headerSub = $('header-sub');
const langSwitch = $('lang-switch');

// ─── State ──────────────────────────────────────────────────────────────────
const store = new Store();
let settings = {};
let running = false;
let abortController = null;
let currentDraft = null;      // { professorId, professorName, to }
let lastAutoTask = '';        // 用来判断任务框里是不是还是默认文案
let stepCount = 0;

const TASK_KEYS = ['taskDefault', 'taskDig', 'taskFaculty'];

// ─── 基础工具 ───────────────────────────────────────────────────────────────
// 所有视图的显示/隐藏只走 .hidden 类，不再动内联 display（曾经因为 CSS 里写了
// display:none、内联 style 清空后依然不显示，导致结果面板和导师库打不开）
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const showOnly = (view) => Object.values(views).forEach((el) => (el === view ? show(el) : hide(el)));

function setStatus(type, msg) {
  const icons = { loading: '<div class="spinner"></div>', error: '⚠', success: '✓' };
  statusArea.innerHTML = `<div class="status-box status-${type}">${icons[type] || ''}<span>${escapeHtml(msg)}</span></div>`;
}
const clearStatus = () => (statusArea.innerHTML = '');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compactArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// ─── Trace 渲染 ─────────────────────────────────────────────────────────────
function resetTrace() {
  traceBody.innerHTML = '';
  stepCount = 0;
  traceTitle.textContent = t('traceTitle');
}

function appendTrace(html) {
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.innerHTML = html;
  traceBody.appendChild(row);
  traceBody.scrollIntoView?.({ block: 'nearest' });
  row.scrollIntoView?.({ block: 'nearest' });
}

function handleEvent(event) {
  switch (event.type) {
    case 'thinking':
      stepCount = event.step;
      setStatus('loading', t('thinking')(event.step));
      break;
    case 'thought':
      appendTrace(`<span class="trace-thought">💭 ${escapeHtml(event.content)}</span>`);
      break;
    case 'tool_start':
      appendTrace(
        `<span class="trace-tool">🔧 ${escapeHtml(event.name)}(${escapeHtml(compactArgs(event.args))})</span>`
      );
      break;
    case 'tool_end': {
      const len = event.result?.length || 0;
      const preview = escapeHtml(event.result?.slice(0, 1200) || '');
      const row = document.createElement('div');
      row.className = 'trace-row trace-obs';
      row.innerHTML = `<details><summary>${escapeHtml(t('observation')(len))}</summary><pre>${preview}</pre></details>`;
      traceBody.appendChild(row);
      row.scrollIntoView?.({ block: 'nearest' });
      break;
    }
    case 'final':
      appendTrace(`<span class="trace-final">✓ ${escapeHtml(event.content || '')}</span>`);
      break;
    case 'limit':
      appendTrace(`<span class="trace-error">⚠ ${escapeHtml(event.message)}</span>`);
      break;
    case 'error':
      appendTrace(`<span class="trace-error">⚠ ${escapeHtml(event.message)}</span>`);
      break;
  }
}

// ─── 运行状态 ───────────────────────────────────────────────────────────────
function setRunning(next) {
  running = next;
  runBtn.disabled = next;
  runBtn.classList.toggle('hidden', next);
  stopBtn.classList.toggle('hidden', !next);
  taskInput.disabled = next;
}

// ─── Agent 主流程 ───────────────────────────────────────────────────────────
async function startRun(task) {
  if (running) return;
  const text = (task || taskInput.value || '').trim();

  settings = await getSettings();
  if (!settings.apiKey) {
    setStatus('error', t('errorApiKey'));
    return;
  }
  const config = resolveConfig(settings);
  headerSub.textContent = describeProvider(config);

  await store.load();
  currentDraft = null;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageContext = tab?.url && !/^(chrome|edge|about|devtools):/i.test(tab.url)
    ? (currentLang === 'en'
        ? `Current tab the student is looking at: ${tab.title || ''} — ${tab.url}`
        : `学生当前正在浏览的页面：${tab.title || ''} — ${tab.url}`)
    : '';

  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        lang: currentLang,
        student: { name: settings.myName, school: settings.mySchool, background: settings.myBackground },
        storeBrief: store.brief(),
        pageContext
      })
    },
    { role: 'user', content: text || t('taskDefault') }
  ];

  const tools = createTools({
    store,
    ui: {
      onStoreChange: () => renderPipeline(),
      onDraft: (draft) => renderDraft(draft)
    }
  });

  resetTrace();
  show(tracePanel);
  clearStatus();
  setRunning(true);
  abortController = new AbortController();

  try {
    const result = await runAgent({
      config,
      tools,
      messages,
      maxSteps: Number(settings.maxSteps) || DEFAULT_MAX_STEPS,
      onEvent: handleEvent,
      signal: abortController.signal
    });

    if (result.stopped) setStatus('error', t('stopped'));
    else if (currentDraft) setStatus('success', t('doneWithDraft'));
    else setStatus('success', t('doneNoDraft'));
  } catch (e) {
    setStatus('error', t('aiError') + e.message);
  } finally {
    setRunning(false);
    abortController = null;
    renderPipeline();
    if (currentDraft) showOnly(views.result);
  }
}

runBtn.addEventListener('click', () => startRun());
stopBtn.addEventListener('click', () => abortController?.abort());

// 任务预设
function renderTaskChips() {
  taskChips.innerHTML = '';
  TASK_KEYS.forEach((key) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = t(key).slice(0, 18) + '…';
    chip.title = t(key);
    chip.addEventListener('click', () => {
      taskInput.value = t(key);
      lastAutoTask = t(key);
      taskInput.focus();
    });
    taskChips.appendChild(chip);
  });
}

// ─── 邮件草稿 ───────────────────────────────────────────────────────────────
function renderDraft({ to, subject, body, professorName }) {
  const rec = store.find({ name: professorName }) || null;
  currentDraft = {
    professorId: rec?.id || null,
    professorName: rec?.name || professorName || '',
    to: to || rec?.email || ''
  };

  profNameEl.textContent = rec?.name || professorName || '—';
  profEmailEl.textContent = to || rec?.email || '';
  profResearchEl.textContent = rec?.summary || '';
  profTagsEl.innerHTML = (rec?.tags || []).map((tag) => `<span class="research-tag">${escapeHtml(tag)}</span>`).join('');

  emailTo.value = to || rec?.email || '';
  emailSubject.value = subject || '';
  emailBody.value = body || '';
}

sendBtn.addEventListener('click', () => {
  const to = emailTo.value.trim();
  const subject = encodeURIComponent(emailSubject.value.trim());
  const body = encodeURIComponent(emailBody.value.trim());
  if (!to) {
    alert(t('noEmailAlert'));
    chrome.tabs.create({ url: `mailto:?subject=${subject}&body=${body}` });
    return;
  }
  chrome.tabs.create({ url: `mailto:${to}?subject=${subject}&body=${body}` });
});

copyBtn.addEventListener('click', async () => {
  const text = `Subject: ${emailSubject.value.trim()}\n\n${emailBody.value.trim()}`;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = t('copied');
    setTimeout(() => (copyBtn.textContent = t('copyToClipboard')), 1800);
  } catch {
    alert('复制失败，请手动复制');
  }
});

markContactedBtn.addEventListener('click', async () => {
  if (!currentDraft?.professorId) {
    alert('这条草稿没有对应的导师库记录');
    return;
  }
  store.upsert({ id: currentDraft.professorId, status: 'contacted', note: '已发送联系邮件' });
  await store.persist();
  renderPipeline();
  markContactedBtn.textContent = t('markedContacted');
  setTimeout(() => (markContactedBtn.textContent = t('markContacted')), 1800);
});

// ─── 导师库 ─────────────────────────────────────────────────────────────────
function renderPipeline() {
  const list = store.list();
  pipelineCountEl.textContent = t('pipelineCount')(list.length);

  if (!list.length) {
    pipelineList.innerHTML = `<div class="empty-hint">${escapeHtml(t('emptyPipeline'))}</div>`;
    return;
  }

  pipelineList.innerHTML = list
    .map((p) => {
      const meta = [p.school, p.email].filter(Boolean).join(' · ') || p.homepageUrl || '';
      const options = STATUSES.map(
        (s) => `<option value="${s}"${s === p.status ? ' selected' : ''}>${escapeHtml(statusLabel(s))}</option>`
      ).join('');
      return `<div class="prof-row" data-id="${p.id}">
        <div class="prof-row-main">
          <div class="prof-row-name" title="${escapeHtml(p.summary || '')}">${escapeHtml(p.name || '未命名')}</div>
          <div class="prof-row-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</div>
        </div>
        <select class="status-select" data-act="status">${options}</select>
        <button class="icon-btn" data-act="open" title="打开主页">↗</button>
        <button class="icon-btn" data-act="del" title="删除">✕</button>
      </div>`;
    })
    .join('');
}

pipelineList.addEventListener('click', async (event) => {
  const row = event.target.closest('.prof-row');
  if (!row) return;
  const id = row.dataset.id;
  const act = event.target.dataset?.act;

  if (act === 'open') {
    const rec = store.professors[id];
    if (rec?.homepageUrl) chrome.tabs.create({ url: rec.homepageUrl, active: true });
    else alert('这条记录没有保存主页链接');
    return;
  }
  if (act === 'del') {
    store.remove(id);
    await store.persist();
    renderPipeline();
  }
});

pipelineList.addEventListener('change', async (event) => {
  if (event.target.dataset?.act !== 'status') return;
  const row = event.target.closest('.prof-row');
  store.upsert({ id: row.dataset.id, status: event.target.value });
  await store.persist();
});

$('open-pipeline-btn').addEventListener('click', async () => {
  await store.load();
  renderPipeline();
  showOnly(views.pipeline);
});
$('pipeline-back-btn').addEventListener('click', () => showOnly(views.main));

$('export-btn').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    professors: store.list(),
    notes: store.notes
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `professors-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

backBtn.addEventListener('click', () => showOnly(views.main));

// ─── Provider 选择 ──────────────────────────────────────────────────────────
function renderProviderChips() {
  [setupProviderSel, settingsProviderSel].forEach((container) => {
    container.innerHTML = '';
    Object.entries(PRESETS).forEach(([key, preset]) => {
      const btn = document.createElement('button');
      btn.className = 'model-btn';
      btn.dataset.provider = key;
      btn.textContent = preset.label;
      if (preset.note) btn.title = preset.note;
      btn.addEventListener('click', () => {
        settings.provider = key;
        setupBaseUrl.value = settingsBaseUrl.value = preset.baseUrl;
        setupModel.value = settingsModel.value = preset.model;
        updateActiveProvider();
      });
      container.appendChild(btn);
    });
  });
}

function updateActiveProvider() {
  document.querySelectorAll('.model-btn[data-provider]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === settings.provider);
  });
}

// ─── 初始化 ─────────────────────────────────────────────────────────────────
async function init() {
  const stored = await getSettings();

  // 老版本（1.0）用的是 modelProvider，且没有 baseUrl/model 字段，这里做一次迁移
  if (!stored.provider && stored.modelProvider) {
    const preset = presetOf(stored.modelProvider);
    stored.provider = stored.modelProvider;
    stored.baseUrl = preset.baseUrl;
    stored.model = preset.model;
  }

  currentLang = stored.lang || 'zh';
  settings = {
    provider: stored.provider || 'deepseek',
    baseUrl: stored.baseUrl || '',
    model: stored.model || '',
    maxSteps: stored.maxSteps || DEFAULT_MAX_STEPS
  };

  langSwitch.checked = currentLang === 'en';
  renderProviderChips();
  updateTranslations();
  updateActiveProvider();

  const preset = presetOf(settings.provider);
  setupBaseUrl.value = settingsBaseUrl.value = settings.baseUrl || preset.baseUrl;
  setupModel.value = settingsModel.value = settings.model || preset.model;
  settingsMaxSteps.value = settings.maxSteps;
  headerSub.textContent = describeProvider(resolveConfig(settings));

  if (!stored.apiKey) {
    showOnly(views.setup);
  } else {
    myName.value = settingsName.value = stored.myName || '';
    mySchool.value = settingsSchool.value = stored.mySchool || '';
    myBackground.value = settingsBackground.value = stored.myBackground || '';
    show(views.info);
    show(views.main);
  }

  await store.load();
  renderPipeline();
}

function updateTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = t(el.dataset.i18n);
    if (typeof value === 'string') el.textContent = value;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const value = t(el.dataset.i18nPlaceholder);
    if (typeof value === 'string') el.placeholder = value;
  });

  traceTitle.textContent = t('traceTitle');
  renderTaskChips();

  const defaultTask = t('taskDefault');
  if (!taskInput.value.trim() || taskInput.value === lastAutoTask) {
    taskInput.value = defaultTask;
    lastAutoTask = defaultTask;
  }

  myName.placeholder = currentLang === 'zh' ? '张三' : 'Zhang San';
  mySchool.placeholder = currentLang === 'zh' ? 'XX大学' : 'XX University';
  myBackground.placeholder =
    currentLang === 'zh'
      ? '计算机科学 GPA 3.8/4.0，熟悉机器学习，参与过NLP项目…'
      : 'CS GPA 3.8/4.0, familiar with ML, participated in NLP projects...';

  runBtn.textContent = t('runBtn');
  stopBtn.textContent = t('stopBtn');
  copyBtn.textContent = t('copyToClipboard');
  markContactedBtn.textContent = t('markContacted');
  renderPipeline();
}

langSwitch.addEventListener('change', async () => {
  currentLang = langSwitch.checked ? 'en' : 'zh';
  await setSettings({ lang: currentLang });
  updateTranslations();
});

// ─── 事件绑定 ───────────────────────────────────────────────────────────────
saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const preset = presetOf(settings.provider);
  if (!key) return tipSetup('请填写 API Key', true);
  if (preset.apiKeyPrefix && !key.startsWith(preset.apiKeyPrefix)) {
    return tipSetup(`格式不对，应以 ${preset.apiKeyPrefix} 开头`, true);
  }

  settings.baseUrl = setupBaseUrl.value.trim();
  settings.model = setupModel.value.trim();
  await setSettings({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: key
  });
  tipSetup('✓ 已保存', false);

  const stored = await getSettings();
  myName.value = settingsName.value = stored.myName || '';
  mySchool.value = settingsSchool.value = stored.mySchool || '';
  myBackground.value = settingsBackground.value = stored.myBackground || '';
  show(views.info);
  show(views.main);
  hide(views.setup);
});

function tipSetup(message, isError) {
  setupStatus.innerHTML = `<div style="color:${isError ? '#b91c1c' : 'var(--green)'};font-size:11px;margin-top:4px">${escapeHtml(message)}</div>`;
}

saveInfoBtn.addEventListener('click', async () => {
  await setSettings({
    myName: myName.value.trim(),
    mySchool: mySchool.value.trim(),
    myBackground: myBackground.value.trim()
  });
  settingsName.value = myName.value;
  settingsSchool.value = mySchool.value;
  settingsBackground.value = myBackground.value;
  infoSavedTip.style.display = 'inline';
  setTimeout(() => (infoSavedTip.style.display = 'none'), 2000);
});

$('open-settings-btn').addEventListener('click', async () => {
  const stored = await getSettings();
  settingsKeyInput.value = stored.apiKey ? '••••••••' : '';
  settingsName.value = stored.myName || '';
  settingsSchool.value = stored.mySchool || '';
  settingsBackground.value = stored.myBackground || '';
  settingsMaxSteps.value = stored.maxSteps || DEFAULT_MAX_STEPS;
  updateActiveProvider();
  showOnly(views.settings);
});

settingsBackBtn.addEventListener('click', () => {
  showOnly(views.main);
  if (!myName.value.trim() && settingsName.value.trim()) {
    myName.value = settingsName.value;
    mySchool.value = settingsSchool.value;
    myBackground.value = settingsBackground.value;
  }
});

settingsSaveBtn.addEventListener('click', async () => {
  const patch = {
    provider: settings.provider,
    baseUrl: settingsBaseUrl.value.trim(),
    model: settingsModel.value.trim(),
    maxSteps: Number(settingsMaxSteps.value) || DEFAULT_MAX_STEPS,
    myName: settingsName.value.trim(),
    mySchool: settingsSchool.value.trim(),
    myBackground: settingsBackground.value.trim()
  };

  const key = settingsKeyInput.value.trim();
  if (key && !key.startsWith('••')) {
    const preset = presetOf(settings.provider);
    if (preset.apiKeyPrefix && !key.startsWith(preset.apiKeyPrefix)) {
      settingsTip.textContent = `格式不对，应以 ${preset.apiKeyPrefix} 开头`;
      settingsTip.style.color = '#b91c1c';
      settingsTip.style.display = 'block';
      setTimeout(() => (settingsTip.style.display = 'none'), 2000);
      return;
    }
    patch.apiKey = key;
  }

  await setSettings(patch);
  settings = { ...settings, ...patch };
  setupBaseUrl.value = settings.baseUrl;
  setupModel.value = settings.model;
  headerSub.textContent = describeProvider(resolveConfig(settings));

  myName.value = patch.myName;
  mySchool.value = patch.mySchool;
  myBackground.value = patch.myBackground;

  settingsTip.textContent = '✓ 已保存';
  settingsTip.style.color = 'var(--green)';
  settingsTip.style.display = 'block';
  setTimeout(() => (settingsTip.style.display = 'none'), 2000);
});

// ─── Boot ───────────────────────────────────────────────────────────────────
init();
