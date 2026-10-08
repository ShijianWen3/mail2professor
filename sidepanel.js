// sidepanel.js —— UI 层：页面路由、资料表单、模型设置、agent trace、邮件确认、导师库
//
// 分工：
//   lib/providers.js  各家 API → 统一工具调用
//   lib/agent.js      ReAct 循环（注入 chatFn 即可换成 Python 后端）
//   lib/tools.js      agent 的浏览器工具
//   lib/store.js      持久层（导师库 / 设置 / 资料）
//   sidepanel.js      只负责界面和状态
//
// 界面结构：一个侧边栏里分多个页面（主页 → 各功能页），主页刻意保持极简。
// 页面切换只改 .hidden 类，不碰内联 display —— 曾经因为 CSS 写了 display:none
// 而显示函数只清内联样式，导致结果页/导师库/设置页对用户完全不可见。

import { PRESETS, presetOf, resolveConfig, providerSettings, currentApiKey } from './lib/providers.js';
import {
  Store, loadState, saveLlm, saveProfile, saveLang,
  PROFILE_FIELDS, profileCompleteness, DEFAULT_MAX_STEPS, STATUSES
} from './lib/store.js';
import { runAgent, buildSystemPrompt, describeProvider } from './lib/agent.js';
import { createTools } from './lib/tools.js';

// ─── 文案 ───────────────────────────────────────────────────────────────────
const i18n = {
  en: {
    back: 'Back',
    titleTask: 'Generate Email', titleResult: 'Confirm Email', titleCrm: 'Professor CRM',
    titleProfile: 'My Profile', titleModel: 'Model Settings',
    runTitle: '✉️ Generate Email',
    runSub: 'read page → save to CRM → draft email',
    navCrm: 'Professor CRM', navProfile: 'My Profile', navModel: 'Model Settings',
    homeHint: 'Open this side panel on a professor page (or a faculty list page) and hit the button above.',
    notConfigured: 'not configured',
    modelNotSet: 'No API Key yet — click to configure',
    crmEmpty: 'empty',
    crmMeta: (total, pending) => `${total} saved · ${pending} not contacted`,
    profileMeta: (filled, total) => `${filled}/${total} filled`,
    missingCore: (labels) => `Missing: ${labels}`,
    needKey: 'Set your API Key first.',
    firstRun: 'First time here: pick a provider and paste your API Key. It is stored only in this browser.',
    keyHint: 'Each provider keeps its own key (switching providers will not overwrite it). Stored locally only.',
    clearKey: 'Clear this provider’s key',
    cleared: '✓ Key cleared for this provider',
    providerLabel: 'PROVIDER', modelLabel: 'MODEL', maxSteps: 'MAX STEPS PER TASK',
    saveBtn: 'Save', saving: 'saving…', autoSaved: '✓ auto-saved', saved: '✓ saved',
    saveFailed: 'Save failed: ', keyFormatError: (prefix) => `Key should start with ${prefix}`,
    keySaved: '✓ API Key saved',
    taskLabel: 'TASK FOR THE AGENT',
    taskEditableHint: 'You can rewrite this task; the agent will follow your wording.',
    runBtn: '▶ Run', stopBtn: '■ Stop',
    taskDefaultTitle: 'Analyze & draft',
    taskDigTitle: 'Dig into the research',
    taskFacultyTitle: 'Collect faculty list',
    taskDefault: 'Analyze the professor page I have open: confirm name, email, 3-6 research keywords and a short summary, save to the CRM, then draft a personalized email I can send after review.',
    taskDig: 'Research the professor on my current page: search their recent papers and lab homepage, find 3 concrete research angles I could contribute to, then rewrite a stronger email based on them.',
    taskFaculty: 'My current page may be a faculty listing: save each professor to the CRM (name + homepage link), then tell me how many there are and who has an email.',
    thinking: (step) => `Step ${step}: thinking…`,
    stopped: 'Stopped by user.',
    doneWithDraft: 'Done — review the draft and send it.',
    doneNoDraft: 'Done. No email draft was produced this time.',
    errorApiKey: 'Please set your API Key first',
    aiError: 'AI error: ',
    traceTitle: 'AGENT TRACE',
    observation: (len) => `observation · ${len} chars`,
    toLabel: 'TO', subjectLabel: 'SUBJECT', bodyLabel: 'BODY',
    sendEmail: '📨 Open Mail', copyToClipboard: '📋 Copy', copied: '✓ Copied!',
    markContacted: '✓ Mark contacted', markedContacted: '✓ Marked',
    backToTask: '← Back to task',
    noEmailAlert: 'No recipient yet — fill it in manually before sending.',
    exportBtn: 'Export JSON',
    emptyPipeline: 'No professors saved yet. Run a task on a professor page and the agent will fill this in.',
    pipelineCount: (n) => `${n} professor(s)`,
    status: { new: 'New', drafted: 'Drafted', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', offer: 'Offer', declined: 'Declined', archived: 'Archived' }
  },
  zh: {
    back: '返回',
    titleTask: '生成联系邮件', titleResult: '确认邮件', titleCrm: '导师库',
    titleProfile: '我的资料', titleModel: '模型设置',
    runTitle: '✉️ 生成联系邮件',
    runSub: '读当前页面 → 存导师库 → 起草邮件',
    navCrm: '导师库', navProfile: '我的资料', navModel: '模型设置',
    homeHint: '在导师主页（或院系师资列表页）上打开这个侧边栏，点上面的按钮即可。',
    notConfigured: '未配置',
    modelNotSet: '还没有填 API Key，点进去配置',
    crmEmpty: '还没有记录',
    crmMeta: (total, pending) => `已存 ${total} 位 · ${pending} 位待联系`,
    profileMeta: (filled, total) => `已填 ${filled}/${total} 项`,
    missingCore: (labels) => `还缺：${labels}`,
    needKey: '请先设置 API Key。',
    firstRun: '首次使用：选一个模型商并填入 API Key。Key 只保存在本机浏览器里。',
    keyHint: '每个厂商的 Key 分开保存（切厂商不会互相覆盖），只存在本机浏览器里。',
    clearKey: '清除本厂商的 Key',
    cleared: '✓ 已清除本厂商的 Key',
    providerLabel: '选择模型商', modelLabel: '模型', maxSteps: '单次任务最大步数',
    saveBtn: '保存', saving: '保存中…', autoSaved: '✓ 已自动保存', saved: '✓ 已保存',
    saveFailed: '保存失败：', keyFormatError: (prefix) => `格式不对，应以 ${prefix} 开头`,
    keySaved: '✓ API Key 已保存',
    taskLabel: '给 agent 的任务',
    taskEditableHint: '可以直接改写这段任务描述，agent 会按你的要求做。',
    runBtn: '▶ 开始', stopBtn: '■ 停止',
    taskDefaultTitle: '分析并写邮件',
    taskDigTitle: '深挖研究方向',
    taskFacultyTitle: '整理本页导师',
    taskDefault: '请分析我当前打开的这位导师的主页：确认他的姓名、邮箱、研究方向（3-6 个关键词）和一两句研究总结，存入导师库，然后起草一封我确认后就能发的联系邮件。',
    taskDig: '请深入调研我当前打开这位导师：搜索他近两年的论文和课题组主页，找出 3 个我能具体切入的研究点，然后据此写一封更有说服力的邮件。',
    taskFaculty: '我当前打开的可能是院系师资列表页：先把页面上的导师逐个存入导师库（姓名 + 主页链接），读完再告诉我总共几位、哪些有邮箱。',
    thinking: (step) => `第 ${step} 步：思考中…`,
    stopped: '已手动停止。',
    doneWithDraft: '完成，邮件草稿见下方，确认后发送。',
    doneNoDraft: '完成，本次没有生成邮件草稿。',
    errorApiKey: '请先设置 API Key',
    aiError: 'AI 调用失败：',
    traceTitle: 'AGENT TRACE',
    observation: (len) => `观察结果 · ${len} 字`,
    toLabel: '收件人', subjectLabel: '邮件主题', bodyLabel: '邮件正文',
    sendEmail: '📨 打开邮件客户端', copyToClipboard: '📋 复制邮件', copied: '✓ 已复制',
    markContacted: '✓ 标记为已联系', markedContacted: '✓ 已标记',
    backToTask: '← 返回任务',
    noEmailAlert: '还没有收件人，请手动填写后再发送。',
    exportBtn: '导出 JSON',
    emptyPipeline: '导师库还是空的。在导师主页上跑一次任务，agent 会自动填进来。',
    pipelineCount: (n) => `共 ${n} 位导师`,
    status: { new: '待联系', drafted: '已起草', contacted: '已联系', replied: '已回复', meeting: '已约聊', offer: '有offer', declined: '已婉拒', archived: '归档' }
  }
};

let lang = 'zh';
const t = (key) => i18n[lang]?.[key] ?? i18n.zh[key] ?? key;
const label = (map) => map?.[lang] ?? map?.zh ?? '';
const statusLabel = (status) => t('status')[status] || status;

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const headerBack = $('header-back');
const headerSub = $('header-sub');
const langSwitch = $('lang-switch');

const statusArea = $('status-area');
const homeNotice = $('home-notice');
const homeCrmMeta = $('home-crm-meta');
const homeProfileMeta = $('home-profile-meta');
const homeModelMeta = $('home-model-meta');

const taskStatusArea = $('task-status-area');
const taskInput = $('task-input');
const taskChips = $('task-chips');
const runBtn = $('run-btn');
const stopBtn = $('stop-btn');
const tracePanel = $('trace-panel');
const traceTitle = $('trace-title');
const traceBody = $('trace-body');

const resultNotice = $('result-notice');
const profNameEl = $('prof-name-el');
const profEmailEl = $('prof-email-el');
const profTagsEl = $('prof-tags-el');
const profResearchEl = $('prof-research-el');
const emailTo = $('email-to');
const emailSubject = $('email-subject');
const emailBody = $('email-body');

const pipelineCountEl = $('pipeline-count');
const pipelineList = $('pipeline-list');

const profileForm = $('profile-form');
const profileTip = $('profile-tip');

const modelNotice = $('model-notice');
const modelProviderSel = $('model-provider-selector');
const modelApiKey = $('model-api-key');
const modelBaseUrl = $('model-base-url');
const modelName = $('model-name');
const modelMaxSteps = $('model-max-steps');
const modelTip = $('model-tip');
const clearKeyLink = $('model-clear-key');

// ─── State ──────────────────────────────────────────────────────────────────
const store = new Store();
const state = { llm: null, profile: null };
let currentPage = 'home';
const pageStack = [];
let running = false;
let abortController = null;
let currentDraft = null;
let profileSaveTimer = null;
let lastAutoTask = '';

const TASK_KEYS = ['taskDefault', 'taskDig', 'taskFaculty'];
const MASK = '••••••••';

// ─── 基础工具 ───────────────────────────────────────────────────────────────
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(area, type, msg) {
  const icons = { loading: '<div class="spinner"></div>', error: '⚠', success: '✓', info: 'ℹ' };
  area.innerHTML = `<div class="status-box status-${type === 'info' ? 'loading' : type}">${icons[type] || ''}<span>${escapeHtml(msg)}</span></div>`;
}
const clearStatus = (area) => (area.innerHTML = '');

function setTip(el, text, kind = '') {
  el.textContent = text;
  el.className = `autosave-tip${kind ? ` ${kind}` : ''}`;
}

function compactArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// ─── 页面路由 ───────────────────────────────────────────────────────────────
const PAGES = ['home', 'task', 'result', 'crm', 'profile', 'model'];
const PAGE_TITLE = { task: 'titleTask', result: 'titleResult', crm: 'titleCrm', profile: 'titleProfile', model: 'titleModel' };

function go(page, { viaBack = false } = {}) {
  if (page === currentPage) return;
  if (!viaBack) pageStack.push(currentPage);
  renderPage(page);
}

function goBack() {
  renderPage(pageStack.pop() || 'home');
}

function renderPage(page) {
  currentPage = page;
  PAGES.forEach((p) => $(`page-${p}`).classList.toggle('hidden', p !== page));
  headerBack.classList.toggle('hidden', page === 'home');
  headerSub.textContent = headerSubText(page);
  window.scrollTo(0, 0);

  if (page === 'home') renderHome();
  if (page === 'task') autoGrowTaskInput();
  if (page === 'crm') renderCrm();
  if (page === 'profile') renderProfileForm();
  if (page === 'model') renderModelForm();
}

// 顶部副标题：主页显示当前模型，子页面显示页面名
function headerSubText(page) {
  if (page !== 'home') return t(PAGE_TITLE[page]);
  if (!currentApiKey(state.llm)) return t('notConfigured');
  return describeProvider(resolveConfig(state.llm));
}

headerBack.addEventListener('click', goBack);
document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => go(btn.dataset.goto));
});
$('go-task-btn').addEventListener('click', () => {
  if (!taskInput.value.trim()) taskInput.value = t('taskDefault');
  go('task');
});
$('result-back-btn').addEventListener('click', () => goBack());

// ─── 主页 ───────────────────────────────────────────────────────────────────
function renderHome() {
  const list = store.list();
  const pending = list.filter((p) => p.status === 'new' || p.status === 'drafted').length;
  homeCrmMeta.textContent = list.length ? t('crmMeta')(list.length, pending) : t('crmEmpty');

  const completeness = profileCompleteness(state.profile);
  const missingCore = completeness.missingCore
    .map((key) => label(PROFILE_FIELDS.find((f) => f.key === key)?.label))
    .filter(Boolean);
  homeProfileMeta.textContent = missingCore.length
    ? `${t('profileMeta')(completeness.filled, completeness.total)} · ${t('missingCore')(missingCore.join('、'))}`
    : t('profileMeta')(completeness.filled, completeness.total);

  const hasKey = Boolean(currentApiKey(state.llm));
  homeModelMeta.textContent = hasKey
    ? describeProvider(resolveConfig(state.llm))
    : t('modelNotSet');
  // 主页可能在别的页面停留时被重新渲染（自动保存、工具入库都会触发），
  // 所以只有在主页时才去改顶部副标题
  if (currentPage === 'home') headerSub.textContent = headerSubText('home');

  if (!hasKey) {
    notice(homeNotice, 'warn', `${t('needKey')} <span class="settings-link" data-goto="model">${escapeHtml(t('navModel'))} ›</span>`);
  } else if (missingCore.length) {
    notice(
      homeNotice,
      'warn',
      `${escapeHtml(t('missingCore')(missingCore.join('、')))} <span class="settings-link" data-goto="profile">${escapeHtml(t('navProfile'))} ›</span>`
    );
  } else {
    homeNotice.innerHTML = '';
  }
}

function notice(container, kind, html) {
  container.innerHTML = `<div class="notice notice-${kind}">${html}</div>`;
}

homeNotice.addEventListener('click', (e) => {
  const target = e.target.closest('[data-goto]');
  if (target) go(target.dataset.goto);
});

// ─── 模型设置页 ─────────────────────────────────────────────────────────────
function renderProviderChips() {
  modelProviderSel.innerHTML = '';
  Object.entries(PRESETS).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'model-btn';
    btn.dataset.provider = key;
    btn.textContent = preset.label;
    if (preset.note) btn.title = preset.note;
    btn.addEventListener('click', async () => {
      if (key === state.llm.provider) return;
      // 先把当前厂商表单里的改动存下来（存不上就不切，免得丢东西）
      if (!(await saveModelForm({ silent: true, refresh: false }))) return;
      state.llm.provider = key;
      renderModelForm();       // 载入这个厂商自己保存过的 Key / BASE URL / 模型
      scheduleLlmSave();
    });
    modelProviderSel.appendChild(btn);
  });
}

function updateActiveProvider() {
  modelProviderSel.querySelectorAll('.model-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === state.llm.provider);
  });
}

function renderModelForm() {
  const settings = providerSettings(state.llm, state.llm.provider);
  updateActiveProvider();
  modelApiKey.value = settings.apiKey ? MASK : '';
  modelBaseUrl.value = settings.baseUrl;
  modelName.value = settings.model;
  modelMaxSteps.value = state.llm.maxSteps || DEFAULT_MAX_STEPS;
  clearKeyLink.classList.toggle('hidden', !settings.apiKey);

  if (!settings.apiKey) notice(modelNotice, 'info', t('firstRun'));
  else modelNotice.innerHTML = '';
}

let llmSaveTimer = null;
function scheduleLlmSave() {
  clearTimeout(llmSaveTimer);
  setTip(modelTip, t('saving'));
  llmSaveTimer = setTimeout(() => saveModelForm({ silent: true }), 600);
}

// 表单 → state（只写当前厂商那一条）
function readModelForm() {
  const provider = state.llm.provider;
  const preset = presetOf(provider);
  const slot = { ...(state.llm.perProvider[provider] || {}) };
  const key = modelApiKey.value.trim();

  // 掩码值表示"沿用已保存的 key"，不要把 •••••• 存进去
  if (key && key !== MASK) {
    if (preset.apiKeyPrefix && !key.startsWith(preset.apiKeyPrefix)) {
      return { error: t('keyFormatError')(preset.apiKeyPrefix) };
    }
    slot.apiKey = key;
  }
  slot.baseUrl = modelBaseUrl.value.trim() || preset.baseUrl;
  slot.model = modelName.value.trim() || preset.model;
  state.llm.perProvider[provider] = slot;
  state.llm.maxSteps = Number(modelMaxSteps.value) || DEFAULT_MAX_STEPS;
  return { error: null };
}

async function saveModelForm({ silent = false, refresh = true } = {}) {
  // 必须在 readModelForm() 之前判断"之前有没有配置过"——它会把新 key 写进 state
  const wasConfigured = Boolean(currentApiKey(state.llm));
  const { error } = readModelForm();
  if (error) {
    setTip(modelTip, error, 'bad');
    if (!silent) setStatus(modelNotice, 'error', error);
    return false;
  }
  try {
    await saveLlm(state.llm);
    if (refresh) renderModelForm();
    modelBaseUrl.value = providerSettings(state.llm).baseUrl;
    modelName.value = providerSettings(state.llm).model;
    setTip(modelTip, t('saved'), 'ok');
    renderHome();
    // 首次配置成功（手动点保存）后回主页，让用户看到可以开始了
    if (!silent && !wasConfigured && currentApiKey(state.llm)) setTimeout(() => goBack(), 600);
    return true;
  } catch (e) {
    setTip(modelTip, t('saveFailed') + e.message, 'bad');
    setStatus(modelNotice, 'error', t('saveFailed') + e.message);
    return false;
  }
}

[modelBaseUrl, modelName, modelMaxSteps].forEach((el) => el.addEventListener('change', () => scheduleLlmSave()));
modelApiKey.addEventListener('change', () => {
  if (modelApiKey.value.trim()) scheduleLlmSave();
});
$('model-save-btn').addEventListener('click', async () => {
  const ok = await saveModelForm({ silent: false, refresh: false });
  if (ok && currentApiKey(state.llm)) setTip(modelTip, t('keySaved'), 'ok');
});

// 只清掉当前厂商的 Key，别的厂商不受影响
clearKeyLink.addEventListener('click', async () => {
  const provider = state.llm.provider;
  const slot = { ...(state.llm.perProvider[provider] || {}) };
  delete slot.apiKey;
  state.llm.perProvider[provider] = slot;
  try {
    await saveLlm(state.llm);
    renderModelForm();
    renderHome();
    setTip(modelTip, t('cleared'), 'ok');
  } catch (e) {
    setTip(modelTip, t('saveFailed') + e.message, 'bad');
  }
});

// ─── 我的资料页 ─────────────────────────────────────────────────────────────
// 表单由 PROFILE_FIELDS 生成，所以以后加字段只改 lib/store.js 里那张表
function renderProfileForm() {
  profileForm.innerHTML = PROFILE_FIELDS.map((field) => {
    const value = state.profile[field.key] ?? '';
    const hint = field.hint ? `<div class="field-hint">${escapeHtml(label(field.hint))}</div>` : '';
    const control =
      field.type === 'textarea'
        ? `<textarea class="field-input" data-field="${field.key}" rows="2" placeholder="${escapeHtml(label(field.placeholder))}">${escapeHtml(value)}</textarea>`
        : `<input class="field-input" type="text" data-field="${field.key}" placeholder="${escapeHtml(label(field.placeholder))}" value="${escapeHtml(value)}" />`;

    return `<div class="field-row${field.type === 'textarea' ? ' is-textarea' : ''}">
      <div class="field-label">${escapeHtml(label(field.label))}</div>
      ${control}
      ${hint}
    </div>`;
  }).join('');

  setTip(profileTip, '');
}

profileForm.addEventListener('input', (event) => {
  const key = event.target.dataset?.field;
  if (!key) return;
  state.profile[key] = event.target.value;
  clearTimeout(profileSaveTimer);
  setTip(profileTip, t('saving'));
  profileSaveTimer = setTimeout(() => saveProfileNow(), 700);
});

async function saveProfileNow() {
  try {
    await saveProfile(state.profile);
    setTip(profileTip, t('autoSaved'), 'ok');
    renderHome();
    return true;
  } catch (e) {
    setTip(profileTip, t('saveFailed') + e.message, 'bad');
    return false;
  }
}

$('profile-save-btn').addEventListener('click', saveProfileNow);

// ─── 任务页：跑 agent ───────────────────────────────────────────────────────
const TASK_TITLES = { taskDefault: 'taskDefaultTitle', taskDig: 'taskDigTitle', taskFaculty: 'taskFacultyTitle' };

// 推荐任务做成整段的列表（不是被截断的 chip），点一下填进上面的输入框
function renderTaskPresets() {
  taskChips.innerHTML = '';
  TASK_KEYS.forEach((key) => {
    const item = document.createElement('button');
    item.className = 'preset-item';
    item.dataset.task = key;
    item.innerHTML =
      `<span class="preset-title">${escapeHtml(t(TASK_TITLES[key]))}</span>` +
      `<span class="preset-text">${escapeHtml(t(key))}</span>`;
    item.addEventListener('click', () => {
      taskInput.value = t(key);
      lastAutoTask = t(key);
      autoGrowTaskInput();
      markActivePreset();
      taskInput.focus();
    });
    taskChips.appendChild(item);
  });
  markActivePreset();
}

function markActivePreset() {
  const current = taskInput.value.trim();
  taskChips.querySelectorAll('.preset-item').forEach((item) => {
    item.classList.toggle('active', t(item.dataset.task) === current);
  });
}

// 任务框按内容自适应高度：默认文案和较长的自定义任务都能一眼看全
function autoGrowTaskInput() {
  if (taskInput.offsetParent === null) return; // 页面没显示时量不出高度
  taskInput.style.height = 'auto';
  taskInput.style.height = `${Math.min(taskInput.scrollHeight + 2, 340)}px`;
}

taskInput.addEventListener('input', () => {
  autoGrowTaskInput();
  markActivePreset();
});

function resetTrace() {
  traceBody.innerHTML = '';
  traceTitle.textContent = t('traceTitle');
}

function appendTrace(html) {
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.innerHTML = html;
  traceBody.appendChild(row);
  row.scrollIntoView?.({ block: 'nearest' });
}

function handleEvent(event) {
  switch (event.type) {
    case 'thinking':
      setStatus(taskStatusArea, 'loading', t('thinking')(event.step));
      break;
    case 'thought':
      appendTrace(`<span class="trace-thought">💭 ${escapeHtml(event.content)}</span>`);
      break;
    case 'tool_start':
      appendTrace(`<span class="trace-tool">🔧 ${escapeHtml(event.name)}(${escapeHtml(compactArgs(event.args))})</span>`);
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
    case 'error':
      appendTrace(`<span class="trace-error">⚠ ${escapeHtml(event.message)}</span>`);
      break;
  }
}

function setRunning(next) {
  running = next;
  runBtn.disabled = next;
  runBtn.classList.toggle('hidden', next);
  stopBtn.classList.toggle('hidden', !next);
  taskInput.disabled = next;
}

async function startRun() {
  if (running) return;
  if (!currentApiKey(state.llm)) {
    setStatus(taskStatusArea, 'error', t('errorApiKey'));
    setStatus(modelNotice, 'info', t('firstRun'));
    renderModelForm();
    go('model');
    return;
  }

  const config = resolveConfig(state.llm);
  const task = (taskInput.value.trim() || t('taskDefault'));
  currentDraft = null;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageContext =
    tab?.url && !/^(chrome|edge|about|devtools):/i.test(tab.url)
      ? lang === 'en'
        ? `Current tab the student is looking at: ${tab.title || ''} — ${tab.url}`
        : `学生当前正在浏览的页面：${tab.title || ''} — ${tab.url}`
      : '';

  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        lang,
        profile: state.profile,
        storeBrief: store.brief(),
        pageContext
      })
    },
    { role: 'user', content: task }
  ];

  const tools = createTools({
    store,
    ui: {
      onStoreChange: () => renderHome(),
      onDraft: (draft) => renderDraft(draft)
    }
  });

  resetTrace();
  show(tracePanel);
  clearStatus(taskStatusArea);
  setRunning(true);
  abortController = new AbortController();

  try {
    const result = await runAgent({
      config,
      tools,
      messages,
      maxSteps: state.llm.maxSteps || DEFAULT_MAX_STEPS,
      onEvent: handleEvent,
      signal: abortController.signal
    });

    if (result.stopped) setStatus(taskStatusArea, 'error', t('stopped'));
    else if (currentDraft) {
      setStatus(taskStatusArea, 'success', t('doneWithDraft'));
      setStatus(resultNotice, 'success', t('doneWithDraft'));
    } else setStatus(taskStatusArea, 'success', t('doneNoDraft'));
  } catch (e) {
    setStatus(taskStatusArea, 'error', t('aiError') + e.message);
  } finally {
    setRunning(false);
    abortController = null;
    renderHome();
    if (currentDraft) go('result');
  }
}

runBtn.addEventListener('click', startRun);
stopBtn.addEventListener('click', () => abortController?.abort());

// ─── 邮件确认页 ─────────────────────────────────────────────────────────────
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

$('send-btn').addEventListener('click', () => {
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

$('copy-btn').addEventListener('click', async (event) => {
  const text = `Subject: ${emailSubject.value.trim()}\n\n${emailBody.value.trim()}`;
  try {
    await navigator.clipboard.writeText(text);
    const btn = event.currentTarget;
    btn.textContent = t('copied');
    setTimeout(() => (btn.textContent = t('copyToClipboard')), 1800);
  } catch {
    alert('复制失败，请手动复制');
  }
});

$('mark-contacted-btn').addEventListener('click', async (event) => {
  if (!currentDraft?.professorId) {
    alert('这条草稿没有对应的导师库记录');
    return;
  }
  store.upsert({ id: currentDraft.professorId, status: 'contacted', note: '已发送联系邮件' });
  await store.persist();
  renderHome();
  const btn = event.currentTarget;
  btn.textContent = t('markedContacted');
  setTimeout(() => (btn.textContent = t('markContacted')), 1800);
});

// ─── 导师库 ─────────────────────────────────────────────────────────────────
function renderCrm() {
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
    renderCrm();
    renderHome();
  }
});

pipelineList.addEventListener('change', async (event) => {
  if (event.target.dataset?.act !== 'status') return;
  const row = event.target.closest('.prof-row');
  store.upsert({ id: row.dataset.id, status: event.target.value });
  await store.persist();
  renderHome();
});

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

// ─── 翻译 ───────────────────────────────────────────────────────────────────
function updateTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = t(el.dataset.i18n);
    if (typeof value === 'string') el.textContent = value;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = t(el.dataset.i18nTitle);
    if (typeof value === 'string') el.title = value;
  });

  traceTitle.textContent = t('traceTitle');
  renderTaskPresets();

  const defaultTask = t('taskDefault');
  if (!taskInput.value.trim() || taskInput.value === lastAutoTask) {
    taskInput.value = defaultTask;
    lastAutoTask = defaultTask;
  }
  markActivePreset();
  autoGrowTaskInput();
  headerSub.textContent = headerSubText(currentPage);
}

langSwitch.addEventListener('change', async () => {
  lang = langSwitch.checked ? 'en' : 'zh';
  try {
    await saveLang(lang);
  } catch (e) {
    // 语言偏好存不上不致命，提示一下就好
    console.warn('语言偏好保存失败', e);
  }
  updateTranslations();
  if (currentPage === 'profile') renderProfileForm();
  renderHome();
});

// ─── 初始化 ─────────────────────────────────────────────────────────────────
async function init() {
  const raw = await loadState();          // 读取 + 迁移旧版本数据结构
  lang = raw.lang;
  state.llm = raw.llm;
  state.profile = raw.profile;
  store.hydrate({ professors: raw.professors, notes: raw.notes });

  langSwitch.checked = lang === 'en';
  renderProviderChips();
  updateTranslations();
  renderProfileForm();
  renderCrm();
  renderPage('home');

  // 还没配 key 就直接进模型设置页（主页那个警告条也能点进来）
  if (!currentApiKey(state.llm)) {
    renderModelForm();
    notice(modelNotice, 'info', t('firstRun'));
    go('model');
  }
}

init().catch((e) => {
  setStatus(statusArea, 'error', `初始化失败：${e.message}`);
});
