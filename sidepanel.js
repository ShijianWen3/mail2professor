// sidepanel.js

// ─── Translations ────────────────────────────────────────────────────────────
const i18n = {
  en: {
    setupDesc: 'Select model provider and enter API Key to analyze pages and generate emails.',
    apiKeyLabel: 'API KEY',
    saveBtn: 'Save',
    yourName: 'Your Name',
    yourSchool: 'Your School',
    background: 'Major / GPA / Background',
    saveInfo: 'Save Info',
    saved: '✓ Saved',
    analyze: '📄 Analyze & Generate Email',
    settings: '⚙ Settings',
    emailSubject: 'Subject',
    emailBody: 'Email Body',
    back: '← Back',
    sendEmail: '📨 Open Mail',
    copyToClipboard: '📋 Copy Email',
    copied: '✓ Copied!',
    profName: 'Professor',
    noEmail: 'No email detected',
    errorApiKey: 'Please enter API Key',
    errorFormat: 'Invalid format, should start with',
    errorContent: 'Cannot read page, please refresh and retry',
    errorTooShort: 'Page content too short, may not be a professor page',
    loadingRead: 'Reading page content...',
    loadingAnalyze: 'Analyzing professor info with AI...',
    aiError: 'AI error:',
    noEmailAlert: 'No email detected, please fill in recipient manually.',
  },
  zh: {
    setupDesc: '选择模型商并填写 API Key 来分析页面并生成邮件。',
    apiKeyLabel: 'API KEY',
    saveBtn: '保存',
    yourName: '你的姓名',
    yourSchool: '本科院校',
    background: '专业 / GPA / 简要背景',
    saveInfo: '保存个人信息',
    saved: '✓ 已保存',
    analyze: '📄 分析当前页面并生成邮件',
    settings: '⚙ 修改设置',
    emailSubject: '邮件主题',
    emailBody: '邮件正文',
    back: '← 重新分析',
    sendEmail: '📨 打开邮件客户端',
    copyToClipboard: '📋 复制邮件内容',
    copied: '✓ 已复制到剪切板',
    profName: '导师姓名',
    noEmail: '未检测到邮箱',
    errorApiKey: '请先设置 API Key',
    errorFormat: '格式不对，应以',
    errorContent: '无法读取页面，请刷新后重试',
    errorTooShort: '页面内容太少，可能不是导师主页',
    loadingRead: '正在读取页面内容…',
    loadingAnalyze: '正在用 AI 分析导师信息并起草邮件…',
    aiError: 'AI 调用失败：',
    noEmailAlert: '未检测到邮箱地址，请手动填写收件人后发送。',
  }
};

let currentLang = 'zh';

// Translation helper
function t(key) {
  return i18n[currentLang]?.[key] || i18n['zh'][key] || key;
}

// ─── DOM refs ───────────────────────────────────────────────────────────────
const setupView      = document.getElementById('setup-view');
const infoSection    = document.getElementById('info-section');
const mainView       = document.getElementById('main-view');
const resultView     = document.getElementById('result-view');
const settingsView   = document.getElementById('settings-view');

const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');
const setupStatus    = document.getElementById('setup-status');
const modelSelector  = document.querySelectorAll('.model-btn[data-model]');
const settingsModelSelector = document.querySelectorAll('#settings-model-selector .model-btn[data-model]');

const myName         = document.getElementById('my-name');
const mySchool       = document.getElementById('my-school');
const myBackground   = document.getElementById('my-background');
const saveInfoBtn    = document.getElementById('save-info-btn');
const infoSavedTip   = document.getElementById('info-saved-tip');

const analyzeBtn     = document.getElementById('analyze-btn');
const statusArea     = document.getElementById('status-area');
const openSettingsBtn= document.getElementById('open-settings-btn');

const profNameEl     = document.getElementById('prof-name-el');
const profEmailEl    = document.getElementById('prof-email-el');
const profTagsEl     = document.getElementById('prof-tags-el');
const profResearchEl = document.getElementById('prof-research-el');
const emailSubject   = document.getElementById('email-subject');
const emailBody      = document.getElementById('email-body');
const backBtn        = document.getElementById('back-btn');
const sendBtn        = document.getElementById('send-btn');
const copyBtn        = document.getElementById('copy-btn');

const settingsKeyInput     = document.getElementById('settings-key-input');
const settingsSaveKeyBtn   = document.getElementById('settings-save-key-btn');
const settingsName         = document.getElementById('settings-name');
const settingsSchool       = document.getElementById('settings-school');
const settingsBackground   = document.getElementById('settings-background');
const settingsSaveInfoBtn  = document.getElementById('settings-save-info-btn');
const settingsBackBtn      = document.getElementById('settings-back-btn');
const settingsTip          = document.getElementById('settings-tip');

// ─── State ──────────────────────────────────────────────────────────────────
let currentEmail = '';
let currentModel = 'anthropic';

// Escape control characters for JSON string safety (used on prompt inputs)
function escapeControlChars(str) {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // Remove control chars
    .replace(/[\r\n]+/g, '\n')  // Normalize line endings
    .replace(/[\u2018\u2019]/g, "'")  // Smart quotes to regular
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\t/g, ' ')
    .replace(/  +/g, ' ')  // Multiple spaces to single
    .trim();
}

// Fix AI-returned JSON string that may contain literal newlines / control chars
// inside string values — which is valid text but invalid raw JSON.
function sanitizeJsonString(str) {
  // Strategy: inside every JSON string value (between unescaped quotes),
  // replace literal control characters with their proper escape sequences.
  // This handles models like MiniMax that embed real \n/\r/\t in JSON values.
  return str.replace(
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

// Model configurations
const modelConfigs = {
  anthropic: {
    name: 'Anthropic',
    apiKeyPrefix: 'sk-ant-',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
    headers: {
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    buildRequest: (apiKey, prompt) => ({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    }),
    parseResponse: (data) => {
      const text = data.content?.[0]?.text || '';
      return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    }
  },
  minimax: {
    name: 'Minimax',
    apiKeyPrefix: '',  // 多种格式
    apiUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    model: 'abab6.5s-chat',
    headers: {},
    buildRequest: (apiKey, prompt) => ({
      model: 'abab6.5s-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      mask_Enabled: true
    }),
    parseResponse: (data) => {
      const text = data.choices?.[0]?.message?.content || '';
      return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    }
  },
  openai: {
    name: 'OpenAI 兼容',
    apiKeyPrefix: 'sk-',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    headers: {},
    buildRequest: (apiKey, prompt) => ({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200
    }),
    parseResponse: (data) => {
      const text = data.choices?.[0]?.message?.content || '';
      return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    }
  }
};

// ─── Init ───────────────────────────────────────────────────────────────────
const langSwitch = document.getElementById('lang-switch');

async function init() {
  // Load language preference
  const data = await chrome.storage.local.get(['apiKey', 'myName', 'mySchool', 'myBackground', 'modelProvider', 'lang']);
  currentLang = data.lang || 'zh';
  langSwitch.checked = currentLang === 'en';
  updateTranslations();

  currentModel = data.modelProvider || 'anthropic';
  updateModelButtons(currentModel);

  if (!data.apiKey) {
    show(setupView);
  } else {
    myName.value       = data.myName       || '';
    mySchool.value     = data.mySchool     || '';
    myBackground.value = data.myBackground || '';
    show(infoSection);
    show(mainView);
  }
}

// Language switch handler
langSwitch.addEventListener('change', async () => {
  currentLang = langSwitch.checked ? 'en' : 'zh';
  await chrome.storage.local.set({ lang: currentLang });
  updateTranslations();
});

// Update all UI translations
function updateTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (i18n[currentLang][key]) {
      el.textContent = i18n[currentLang][key];
    }
  });
  // Update placeholders
  document.getElementById('my-name').placeholder = currentLang === 'zh' ? '张三' : 'Zhang San';
  document.getElementById('my-school').placeholder = currentLang === 'zh' ? 'XX大学' : 'XX University';
  document.getElementById('my-background').placeholder = currentLang === 'zh' ? '计算机科学 GPA 3.8/4.0，熟悉机器学习，参与过NLP项目…' : 'CS GPA 3.8/4.0, familiar with ML, participated in NLP projects...';
}

function show(el)  { el.classList.remove('hidden'); el.style.display = ''; }
function hide(el)  { el.classList.add('hidden'); }

function updateModelButtons(model) {
  document.querySelectorAll('.model-btn[data-model]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.model === model);
  });
}

// ─── Model selector ─────────────────────────────────────────────────────────
modelSelector.forEach(btn => {
  btn.addEventListener('click', () => {
    currentModel = btn.dataset.model;
    updateModelButtons(currentModel);
  });
});

// Setup: save API key
saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const config = modelConfigs[currentModel];

  if (!key) {
    setupStatus.innerHTML = '<div style="color:#b91c1c;font-size:11px;margin-top:4px">请填写 API Key</div>';
    return;
  }

  if (config.apiKeyPrefix && !key.startsWith(config.apiKeyPrefix)) {
    setupStatus.innerHTML = `<div style="color:#b91c1c;font-size:11px;margin-top:4px">格式不对，应以 ${config.apiKeyPrefix} 开头</div>`;
    return;
  }

  await chrome.storage.local.set({ apiKey: key, modelProvider: currentModel });
  setupStatus.innerHTML = '<div style="color:#2e7d52;font-size:11px;margin-top:4px">✓ 已保存，请填写个人信息</div>';
  setTimeout(() => {
    hide(setupView);
    show(infoSection);
    show(mainView);
  }, 800);
});

// ─── Info: save personal info ───────────────────────────────────────────────
saveInfoBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    myName:       myName.value.trim(),
    mySchool:     mySchool.value.trim(),
    myBackground: myBackground.value.trim()
  });
  infoSavedTip.style.display = 'inline';
  setTimeout(() => { infoSavedTip.style.display = 'none'; }, 2000);
});

// ─── Settings panel ─────────────────────────────────────────────────────────
openSettingsBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['apiKey', 'myName', 'mySchool', 'myBackground', 'modelProvider']);
  settingsKeyInput.value     = data.apiKey       ? '••••••••' : '';
  settingsName.value         = data.myName       || '';
  settingsSchool.value       = data.mySchool     || '';
  settingsBackground.value   = data.myBackground || '';
  currentModel = data.modelProvider || 'anthropic';
  updateModelButtons(currentModel);

  hide(infoSection);
  hide(mainView);
  show(settingsView);
});

settingsBackBtn.addEventListener('click', () => {
  hide(settingsView);
  show(infoSection);
  show(mainView);
});

// Settings model selector
settingsModelSelector.forEach(btn => {
  btn.addEventListener('click', () => {
    currentModel = btn.dataset.model;
    updateModelButtons(currentModel);
  });
});

settingsSaveKeyBtn.addEventListener('click', async () => {
  const key = settingsKeyInput.value.trim();
  const config = modelConfigs[currentModel];

  if (key && !key.startsWith('••')) {
    if (config.apiKeyPrefix && !key.startsWith(config.apiKeyPrefix)) {
      settingsTip.textContent = `格式不对，应以 ${config.apiKeyPrefix} 开头`;
      settingsTip.style.color = '#b91c1c';
    } else {
      await chrome.storage.local.set({ apiKey: key, modelProvider: currentModel });
      settingsTip.textContent = '✓ API Key 已更新';
      settingsTip.style.color = '#2e7d52';
    }
    settingsTip.style.display = 'block';
    setTimeout(() => { settingsTip.style.display = 'none'; }, 2000);
  }
});

settingsSaveInfoBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    myName:       settingsName.value.trim(),
    mySchool:     settingsSchool.value.trim(),
    myBackground: settingsBackground.value.trim()
  });
  // Sync back to main info section
  myName.value       = settingsName.value.trim();
  mySchool.value     = settingsSchool.value.trim();
  myBackground.value = settingsBackground.value.trim();
  settingsTip.textContent = '✓ 个人信息已保存';
  settingsTip.style.color = '#2e7d52';
  settingsTip.style.display = 'block';
  setTimeout(() => { settingsTip.style.display = 'none'; }, 2000);
});

// ─── Analyze button ─────────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['apiKey', 'myName', 'mySchool', 'myBackground']);
  if (!data.apiKey) {
    setStatus('error', t('errorApiKey'));
    return;
  }

  setStatus('loading', t('loadingRead'));
  analyzeBtn.disabled = true;

  // Get page content via message to content script
  let pageContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('Current tab:', tab);
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageContent' });
    console.log('Message response:', response);
    pageContent = response?.content || '';
  } catch (e) {
    console.error('Page content error:', e);
    setStatus('error', t('errorContent') + ': ' + e.message);
    analyzeBtn.disabled = false;
    return;
  }

  if (!pageContent || pageContent.length < 100) {
    setStatus('error', t('errorTooShort'));
    analyzeBtn.disabled = false;
    return;
  }

  setStatus('loading', t('loadingAnalyze'));

  try {
    const result = await callAI(data.apiKey, pageContent, {
      name:       data.myName       || (currentLang === 'zh' ? '（未填写姓名）' : '(Name not provided)'),
      school:     data.mySchool     || (currentLang === 'zh' ? '（未填写院校）' : '(School not provided)'),
      background: data.myBackground || (currentLang === 'zh' ? '（未填写背景）' : '(Background not provided)')
    });
    renderResult(result);
  } catch (e) {
    setStatus('error', t('aiError') + e.message);
    analyzeBtn.disabled = false;
  }
});

// ─── Content extractor (injected into page) ─────────────────────────────────
function extractPageContent() {
  const cloned = document.body.cloneNode(true);
  ['script','style','nav','footer','header','iframe','noscript'].forEach(tag => {
    cloned.querySelectorAll(tag).forEach(el => el.remove());
  });
  let text = (cloned.innerText || cloned.textContent || '').replace(/\s+/g, ' ').trim();
  return text.substring(0, 8000);
}

// ─── AI API call ────────────────────────────────────────────────────────────
async function callAI(apiKey, pageContent, student) {
  const config = modelConfigs[currentModel];

  // Escape control characters to prevent JSON parse errors
  const safePageContent = escapeControlChars(pageContent);
  const safeName = escapeControlChars(student.name);
  const safeSchool = escapeControlChars(student.school);
  const safeBackground = escapeControlChars(student.background);

  const isChinese = currentLang === 'zh';
  const langInstruction = isChinese
    ? '请用简体中文回复。邮件内容应该亲切、真诚，200-350字左右。'
    : 'Please reply in English. The email should be sincere and concise, 200-350 words.';

  const prompt = `You are an assistant helping students contact professors for graduate school applications. ${langInstruction}

Analyze the professor's homepage content below and complete two tasks:

1. Extract professor information (name, email, research keywords, one-sentence research summary)
2. Write a concise, sincere, personalized contact email for the student

Student information:
- Name: ${safeName}
- School: ${safeSchool}
- Background: ${safeBackground}

Professor homepage content:
---
${safePageContent}
---

Return strictly in the following JSON format, no additional text:
{
  "prof_name": "Professor full name (or unknown if not found)",
  "prof_email": "Email address (or empty string if not found)",
  "research_tags": ["keyword1", "keyword2", "keyword3"],
  "research_summary": "One or two sentences summarizing main research focus",
  "email_subject": "Email subject",
  "email_body": "Email body (sincere tone, specific to professor's research, end with contact info)"
}`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...config.headers
  };

  const body = config.buildRequest(apiKey, prompt);

  console.log('Request body:', JSON.stringify(body).substring(0, 500));

  const resp = await fetch(config.apiUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('API Error Response:', errText);
    let err;
    try {
      err = JSON.parse(errText);
    } catch {
      err = { error: { message: errText } };
    }
    const errorMsg = err?.error?.message || err?.message || `HTTP ${resp.status}`;
    throw new Error(errorMsg);
  }

  const respText = await resp.text();
  console.log('API Response:', respText.substring(0, 500));

  let data;
  try {
    data = JSON.parse(respText);
  } catch (e) {
    throw new Error('响应 JSON 解析失败: ' + e.message + '\n响应内容: ' + respText.substring(0, 200));
  }

  const cleaned = config.parseResponse(data);
  // Sanitize literal control characters inside JSON string values (MiniMax etc.)
  const sanitized = sanitizeJsonString(cleaned);
  try {
    return JSON.parse(sanitized);
  } catch (e) {
    // Try to extract JSON block from response if it contains extra surrounding text
    const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(sanitizeJsonString(jsonMatch[0]));
    }
    throw new Error('JSON 解析失败: ' + e.message);
  }
}

// ─── Render result ───────────────────────────────────────────────────────────
function renderResult(r) {
  profNameEl.textContent     = r.prof_name     || '未知';
  profEmailEl.textContent    = r.prof_email    || '未检测到邮箱';
  profResearchEl.textContent = r.research_summary || '';
  currentEmail               = r.prof_email    || '';

  profTagsEl.innerHTML = (r.research_tags || [])
    .map(t => `<span class="research-tag">${t}</span>`)
    .join('');

  emailSubject.value = r.email_subject || '';
  emailBody.value    = r.email_body    || '';

  hide(mainView);
  hide(infoSection);
  resultView.style.display = 'block';
  clearStatus();
  analyzeBtn.disabled = false;
}

// ─── Back button ─────────────────────────────────────────────────────────────
backBtn.addEventListener('click', () => {
  resultView.style.display = 'none';
  show(infoSection);
  show(mainView);
  clearStatus();
});

// ─── Send button: open mailto ────────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const to      = currentEmail;
  const subject = encodeURIComponent(emailSubject.value.trim());
  const body    = encodeURIComponent(emailBody.value.trim());

  if (!to) {
    alert('未检测到邮箱地址，请手动填写收件人后发送。');
    const mailto = `mailto:?subject=${subject}&body=${body}`;
    chrome.tabs.create({ url: mailto });
    return;
  }

  const mailto = `mailto:${to}?subject=${subject}&body=${body}`;
  chrome.tabs.create({ url: mailto });
});

// ─── Copy button: copy email to clipboard ───────────────────────────────────
copyBtn.addEventListener('click', async () => {
  const subject = emailSubject.value.trim();
  const body = emailBody.value.trim();
  const emailText = `Subject: ${subject}\n\n${body}`;

  try {
    await navigator.clipboard.writeText(emailText);
    copyBtn.textContent = t('copied');
    copyBtn.style.background = 'var(--green)';
    setTimeout(() => {
      copyBtn.textContent = t('copyToClipboard');
      copyBtn.style.background = '';
    }, 2000);
  } catch (e) {
    console.error('Copy failed:', e);
    alert('复制失败，请手动复制');
  }
});

// ─── Status helpers ──────────────────────────────────────────────────────────
function setStatus(type, msg) {
  const icons = { loading: '<div class="spinner"></div>', error: '⚠', success: '✓' };
  statusArea.innerHTML = `
    <div class="status-box status-${type}">
      ${icons[type]}
      <span>${msg}</span>
    </div>`;
}
function clearStatus() { statusArea.innerHTML = ''; }

// ─── Boot ────────────────────────────────────────────────────────────────────
init();