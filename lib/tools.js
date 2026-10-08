// lib/tools.js
// agent 的工具集：每个工具就是一个 { name, description, parameters, run } 对象。
// description 是模型决定调不调的唯一依据，所以要写清"什么时候用"。
//
// 这里全部是浏览器独有的能力（读标签页、后台访问页面、搜索），
// 也是这个 agent 留在插件里的根本原因。

const DEFAULT_TEXT_LIMIT = 6000;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// 导师主页上很常见的反爬写法：zhangwei (at) cs (dot) example (dot) edu
// 单条正则处理不了多级域名（会把 @cs.example 之后的 .edu 丢掉），所以先整体归一化再抽取。
const OBF_AT = /([A-Za-z0-9._%+-]+)\s*(?:\(|\[)?\s*(?:at|AT)\s*(?:\)|\])?\s*(?=[A-Za-z0-9-])/g;
const OBF_DOT = /([A-Za-z0-9-])\s*(?:\(|\[)?\s*(?:dot|DOT)\s*(?:\)|\])?\s*(?=[A-Za-z0-9])/g;

export function deobfuscate(text) {
  return String(text).replace(OBF_AT, '$1@').replace(OBF_DOT, '$1.');
}

function looksLikeEmail(email) {
  const lower = String(email).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(lower)) return false; // 图片文件名误伤
  if (lower.startsWith('@') || /\d+x\./.test(lower)) return false;    // @2x.png 之类
  if (/(^|\.)example\.(com|org|net)$/.test(lower)) return false;
  return lower.length <= 80 && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(lower);
}

// ─── 页面读取 ───────────────────────────────────────────────────────────────
function ensureContentScript(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
}

async function readTab(tabId, { includeLinks = true, includeText = true, maxChars = DEFAULT_TEXT_LIMIT } = {}) {
  const message = { action: 'getPageContent', includeLinks, includeText, maxChars };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res?.ok) return res.data;
  } catch {
    // content script 还没注入（刚装的扩展 / 页面是刷新前打开的）→ 注入后重试
    await ensureContentScript(tabId);
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res?.ok) return res.data;
    throw new Error(res?.error || '页面无响应');
  }
  throw new Error('页面读取失败');
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete' || Date.now() - start > timeout) return resolve(tab);
      } catch {
        return resolve(null); // 标签页被关掉了
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || [])));
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve) => chrome.tabs.remove(tabId, () => resolve()));
}

// ─── HTML → 文本 ────────────────────────────────────────────────────────────
export function extractEmails(text) {
  const raw = String(text ?? '');
  const normalized = deobfuscate(raw);

  const direct = new Set(raw.match(EMAIL_RE) || []);
  const decoded = new Set(normalized.match(EMAIL_RE) || []);

  const emails = [...direct].filter(looksLikeEmail);
  const deobfuscated = [...decoded].filter(looksLikeEmail).filter((e) => !emails.includes(e));
  return { emails, deobfuscated };
}

export function htmlToText(html) {
  const withBreaks = String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  doc
    .querySelectorAll('header,footer,nav,aside,form,button,select,[aria-hidden="true"]')
    .forEach((el) => el.remove());

  const main =
    doc.querySelector('main, article, #content, #main, .content, .main, #wrapper, .container') || doc.body;
  const title = (doc.title || '').trim();
  const text = (main?.textContent || '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  const links = [...doc.querySelectorAll('a[href]')]
    .map((a) => ({
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      href: a.getAttribute('href') || ''
    }))
    .filter((l) => l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:'));

  return { title, text, links };
}

// 师资列表页的信号：页面上出现大量"教授/老师/Prof."字样的链接
export function looksLikeFacultyList(links = []) {
  const re = /(教授|副教授|助理教授|研究员|副研究员|讲师|老师|博导|硕导|professor|associate prof|assistant prof|faculty|prof\.|dr\.)/i;
  return links.filter((l) => re.test(l.text)).length >= 5;
}

function guessPageType(url, emails, links) {
  if (/scholar\.google\./i.test(url)) return 'google_scholar';
  if (/(faculty|people|teachers|shizi|szll|teacher)/i.test(url) || looksLikeFacultyList(links)) return 'faculty_list';
  if (emails.length) return 'professor_page';
  return 'generic';
}

export function normalizeUrl(href, base) {
  if (!href) return '';
  try {
    const url = new URL(href, base);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true, fullLength: text.length };
}

// ─── 网页抓取（fetch，拿到的是原始 HTML，不含 JS 渲染结果）────────────────────
export async function fetchPageText(url, { maxChars = DEFAULT_TEXT_LIMIT } = {}) {
  const resp = await fetch(url, { redirect: 'follow' });
  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  if (/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url)) {
    return {
      url,
      isPdf: true,
      note: '这是一个 PDF，浏览器扩展里无法直接解析。请改用 visit_page 打开后让用户手动复制，或在总结里提醒学生。'
    };
  }
  if (!/html|text|xml/i.test(contentType)) {
    return { url, note: `不支持的内容类型：${contentType}` };
  }

  const html = await resp.text();
  const { title, text, links } = htmlToText(html);
  const { emails, deobfuscated } = extractEmails(text);
  const cut = truncate(text, maxChars);
  return {
    url,
    title,
    text: cut.text,
    truncated: cut.truncated || undefined,
    fullLength: cut.fullLength,
    emails,
    deobfuscatedEmails: deobfuscated,
    links: links
      .filter((l) => /^https?:|^\/|^\./.test(l.href))
      .slice(0, 80)
      .map((l) => ({ text: l.text, href: normalizeUrl(l.href, url) }))
      .filter((l) => l.href)
  };
}

// ─── 搜索（无需额外 key，多级兜底）──────────────────────────────────────────
// 首选 Bing 的 RSS 输出：纯 XML、没有反爬页面、结构稳定，比抓 HTML 可靠得多。
export function parseBingRss(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  return [...doc.querySelectorAll('item')]
    .map((item) => ({
      title: cleanText(item.querySelector('title')?.textContent),
      url: cleanText(item.querySelector('link')?.textContent),
      snippet: cleanText(item.querySelector('description')?.textContent)
    }))
    .filter((r) => r.title && /^https?:/.test(r.url));
}

function cleanText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function decodeSearchHref(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
    if (/bing\.com\/ck\/a/.test(url.href)) {
      const u = url.searchParams.get('u');
      if (u) return decodeURIComponent(u.replace(/^a1/, ''));
    }
    return url.href;
  } catch {
    return href || '';
  }
}

// 三家搜索引擎的结果区结构不同，但都是「一个链接 + 一段摘要」。
// 这里按"最可能命中"的顺序试多组选择器，全部失败就返回空数组交给下一个引擎。
export function parseResultAnchors(html, selectorGroups) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const { container, link, snippet } of selectorGroups) {
    const nodes = [...doc.querySelectorAll(container)];
    const results = nodes
      .map((node) => {
        const a = node.matches?.(link) ? node : node.querySelector(link);
        const text = node.matches?.(snippet) ? node : node.querySelector(snippet);
        const href = a?.getAttribute('href') || '';
        return {
          title: (a?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          url: decodeSearchHref(href),
          snippet: (text?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)
        };
      })
      .filter((r) => r.title && /^https?:/.test(r.url));
    if (results.length) return results;
  }
  return [];
}

const DDG_SELECTORS = [
  { container: '.result', link: '.result__a', snippet: '.result__snippet' },
  { container: '.web-result', link: 'a.result-link', snippet: '.result-snippet' },
  { container: 'tr', link: 'a.result-link', snippet: '.result-snippet' },
  { container: 'a.result-link', link: 'a.result-link', snippet: 'span' }
];

const BING_SELECTORS = [
  { container: 'li.b_algo', link: 'h2 a', snippet: '.b_caption p' },
  { container: 'li.b_algo', link: 'a', snippet: 'p' },
  { container: '.b_algo', link: 'h2 a', snippet: 'p' }
];

async function attempt(label, url, parse, attempts, options = {}) {
  try {
    const resp = await fetch(url, options);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const results = parse(await resp.text());
    if (results.length) return results;
    throw new Error('页面结构没匹配到结果');
  } catch (e) {
    attempts.push(`${label}: ${e.message}`);
    return null;
  }
}

export async function searchWeb(query, maxResults = 8) {
  const q = encodeURIComponent(query);
  const attempts = [];

  const engines = [
    ['bing-rss', `https://www.bing.com/search?q=${q}&format=rss`, parseBingRss],
    ['duckduckgo', `https://html.duckduckgo.com/html/?q=${q}`, (html) => parseResultAnchors(html, DDG_SELECTORS)],
    ['duckduckgo-lite', `https://lite.duckduckgo.com/lite/?q=${q}`, (html) => parseResultAnchors(html, DDG_SELECTORS)],
    ['bing', `https://www.bing.com/search?q=${q}&setlang=zh-CN`, (html) => parseResultAnchors(html, BING_SELECTORS)]
  ];

  for (const [label, url, parse] of engines) {
    const results = await attempt(label, url, parse, attempts);
    if (results) return { query, engine: label, results: results.slice(0, maxResults) };
  }

  return {
    query,
    error: '搜索失败，所有引擎都没返回结果。可以改用 visit_page 直接访问已知网址。',
    attempts
  };
}

// ─── 工具定义 ───────────────────────────────────────────────────────────────
export function createTools(ctx) {
  const { store, ui = {} } = ctx;

  // 把页面数据整理成模型友好的结构
  const pageResult = (data, maxChars) => {
    const cut = truncate(data.text || '', maxChars);
    const { emails, deobfuscated } = extractEmails(`${data.text || ''}\n${(data.emails || []).join(' ')}`);
    const links = data.links || [];
    return {
      url: data.url,
      title: data.title,
      pageType: guessPageType(data.url, emails, links),
      emails,
      deobfuscatedEmails: deobfuscated,
      text: cut.text,
      truncated: cut.truncated || undefined,
      fullLength: cut.fullLength,
      links: links.length ? links : undefined
    };
  };

  return [
    {
      name: 'read_current_page',
      description:
        '读取学生当前正在浏览的那个标签页（通常是导师主页、师资列表页或课题组页面），返回标题、URL、正文、页面上的邮箱和链接。任务开始时优先调用它。',
      parameters: {
        type: 'object',
        properties: {
          max_chars: { type: 'integer', description: '正文最多返回多少字符，默认 6000' },
          include_links: { type: 'boolean', description: '是否返回页面链接列表，默认 true' }
        }
      },
      run: async ({ max_chars = DEFAULT_TEXT_LIMIT, include_links = true } = {}) => {
        const [tab] = await tabsQuery({ active: true, currentWindow: true });
        if (!tab) throw new Error('没有找到当前标签页');
        if (/^(chrome|edge|about|devtools):/i.test(tab.url || '')) {
          throw new Error(`当前标签页是浏览器内部页面（${tab.url}），无法读取。请让用户打开导师主页后再试。`);
        }
        const data = await readTab(tab.id, {
          includeLinks: include_links,
          maxChars: Number.MAX_SAFE_INTEGER // 先取全文，截断交给下面统一处理
        });
        return pageResult(data, max_chars);
      }
    },

    {
      name: 'visit_page',
      description:
        '在后台标签页打开一个网址并读取正文。适合需要 JS 渲染的页面（Google Scholar、课题组主页、学校师资页），也适合点进子页面看细节。不会改变学生当前正在看的页面。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址，必须带 http:// 或 https://' },
          max_chars: { type: 'integer', description: '正文最多返回多少字符，默认 6000' },
          keep_open: { type: 'boolean', description: '读完是否保留这个标签页给学生看，默认 false（读完关掉）' }
        },
        required: ['url']
      },
      run: async ({ url, max_chars = DEFAULT_TEXT_LIMIT, keep_open = false } = {}) => {
        if (!/^https?:\/\//i.test(url)) return { error: `不是合法网址：${url}` };
        let tab;
        try {
          tab = await tabsCreate({ url, active: false });
        } catch (e) {
          throw new Error(`无法打开标签页：${e.message}`);
        }
        try {
          await waitForTabComplete(tab.id);
          const data = await readTab(tab.id, { includeLinks: true, maxChars: Number.MAX_SAFE_INTEGER });
          if (!data.text) {
            return { url, note: '页面正文为空（可能是 PDF 或纯 JS 加载）。可尝试 fetch 版本或让用户手动查看。' };
          }
          const result = pageResult(data, max_chars);
          return keep_open ? { ...result, note: '已保留该标签页' } : result;
        } finally {
          if (!keep_open && tab?.id) await tabsRemove(tab.id);
        }
      }
    },

    {
      name: 'search_web',
      description:
        '用搜索引擎检索网页。适合查导师的近期论文、课题组主页、招生信息、学校院系页面，或确认姓名/单位的正确写法。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，建议同时带上姓名和学校/研究方向' },
          max_results: { type: 'integer', description: '返回结果条数，默认 8' }
        },
        required: ['query']
      },
      run: async ({ query, max_results = 8 } = {}) => {
        if (!query) throw new Error('query 不能为空');
        return searchWeb(query, max_results);
      }
    },

    {
      name: 'save_professor',
      description:
        '把一位导师存入导师库（按姓名/邮箱自动去重合并）。写邮件之前必须先调用。姓名、邮箱、研究方向必须来自你实际读到的页面或搜索结果。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '导师姓名，尽量带职称写法（如"张伟 教授"只写"张伟"）' },
          email: { type: 'string', description: '邮箱，页面上确实有才填' },
          school: { type: 'string', description: '学校/院系' },
          homepage_url: { type: 'string', description: '主页网址' },
          tags: { type: 'array', items: { type: 'string' }, description: '研究方向关键词，3-6 个' },
          summary: { type: 'string', description: '一两句话总结他的研究方向' },
          status: {
            type: 'string',
            enum: ['new', 'drafted', 'contacted', 'replied', 'meeting', 'offer', 'declined', 'archived'],
            description: '跟进状态，默认 new'
          },
          note: { type: 'string', description: '值得记一笔的细节（招生要求、论文方向、实验室名等）' }
        },
        required: ['name']
      },
      run: async (args) => {
        const rec = store.upsert(args);
        await store.persist();
        ui.onStoreChange?.();
        return {
          saved: {
            id: rec.id, name: rec.name, email: rec.email, school: rec.school,
            status: rec.status, tags: rec.tags
          },
          note: '已存入导师库'
        };
      }
    },

    {
      name: 'list_professors',
      description: '列出导师库里已保存的导师（姓名、邮箱、状态、研究方向），用于避免重复劳动、确认谁还没联系。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '只看某个状态，可选' },
          query: { type: 'string', description: '按姓名/学校关键词过滤，可选' }
        }
      },
      run: async ({ status, query } = {}) => {
        let list = store.list();
        if (status) list = list.filter((p) => p.status === status);
        if (query) {
          const q = String(query).toLowerCase();
          list = list.filter((p) =>
            `${p.name} ${p.school} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q)
          );
        }
        return {
          total: store.list().length,
          professors: list.slice(0, 50).map((p) => ({
            id: p.id, name: p.name, email: p.email, school: p.school,
            status: p.status, tags: p.tags, summary: p.summary,
            lastNote: p.notes?.[p.notes.length - 1]?.text
          }))
        };
      }
    },

    {
      name: 'update_professor_status',
      description: '更新某位导师的跟进状态或补充备注（按 id 或姓名定位，二选一即可）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: '不确定 id 时用姓名' },
          status: {
            type: 'string',
            enum: ['new', 'drafted', 'contacted', 'replied', 'meeting', 'offer', 'declined', 'archived']
          },
          note: { type: 'string', description: '要追加的备注' }
        }
      },
      run: async ({ id, name, status, note } = {}) => {
        const rec = store.find({ id, name });
        if (!rec) return { error: `导师库里没有找到 ${name || id}，可以用 save_professor 先保存。` };
        const updated = store.upsert({ id: rec.id, status, note });
        await store.persist();
        ui.onStoreChange?.();
        return { updated: { id: updated.id, name: updated.name, status: updated.status, notes: updated.notes.length } };
      }
    },

    {
      name: 'save_email_draft',
      description:
        '把最终邮件提交到学生的确认面板（收件人、主题、正文）。这是收尾动作：调用之后用文字总结即可，不要再改邮件内容。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱；确实没找到就留空，由学生手动填' },
          subject: { type: 'string' },
          body: { type: 'string', description: '邮件正文全文，含称呼、正文、落款和联系方式' },
          professor_name: { type: 'string', description: '写给哪位导师，用于存入导师库' },
          professor_id: { type: 'string' }
        },
        required: ['subject', 'body']
      },
      run: async ({ to = '', subject, body, professor_name, professor_id } = {}) => {
        if (!subject || !body) throw new Error('subject 和 body 都不能为空');
        const rec = store.find({ id: professor_id, name: professor_name });
        if (rec) {
          store.addDraft(rec.id, { subject, body, to: to || rec.email || '' });
          // 草稿里的收件人优先用页面上读到的邮箱
          if (!rec.email && to) store.upsert({ id: rec.id, email: to });
          await store.persist();
          ui.onStoreChange?.();
        }
        ui.onDraft?.({ to: to || rec?.email || '', subject, body, professorName: rec?.name || professor_name || '' });
        return {
          delivered: true,
          recipient: to || rec?.email || '',
          note: rec ? `已写入确认面板，并记在导师库「${rec.name}」名下` : '已写入确认面板（未匹配到导师库记录）'
        };
      }
    },

    {
      name: 'open_url',
      description: '在学生浏览器里打开一个网址（前台新标签页），用于把导师主页或论文页展示给他看。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      },
      run: async ({ url } = {}) => {
        if (!/^https?:\/\//i.test(url)) return { error: `不是合法网址：${url}` };
        await tabsCreate({ url, active: true });
        return { opened: url };
      }
    }
  ];
}
