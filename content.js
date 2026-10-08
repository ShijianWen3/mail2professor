// content.js - 注入到页面里，负责把页面内容结构化地交给 sidepanel
// 只在需要时注入一次；重复注入会注册多个监听器，所以用全局标记挡掉。
(() => {
  if (window.__mpContentReady) return;
  window.__mpContentReady = true;

  const HARD_MAX = 60000; // 单页正文硬上限，避免超大页面撑爆消息通道

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== 'getPageContent') return;

    try {
      sendResponse({ ok: true, data: extractPageContent(request) });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });

  function extractPageContent({ includeLinks = true, includeText = true, maxChars = HARD_MAX } = {}) {
    const limit = Math.min(Number(maxChars) || HARD_MAX, HARD_MAX);

    const cloned = document.body.cloneNode(true);
    ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'svg'].forEach((tag) => {
      cloned.querySelectorAll(tag).forEach((el) => el.remove());
    });

    // 优先取主体区域，避开侧栏和免责声明（很多学校主页正文会被淹没）
    const main =
      cloned.querySelector('main, article, #content, #main, .content, .main, #wrapper, .container') || cloned;

    let text = main.innerText || main.textContent || '';
    text = text
      .replace(/[ \t\u00a0\u3000]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    const truncated = text.length > limit;
    if (truncated) text = text.slice(0, limit);

    return {
      url: location.href,
      title: document.title || '',
      text: includeText ? text : '',
      truncated: truncated || undefined,
      fullLength: truncated ? text.length : undefined,
      emails: scrapeEmails(),
      links: includeLinks ? scrapeLinks() : []
    };
  }

  // 正文里抽邮箱；同时处理 "name (at) xxx (dot) edu" 这类反爬写法
  // 注意 content script 不能用 ESM import，所以这里的逻辑和 lib/tools.js 的 extractEmails 是重复实现的，改一处要同步改另一处
  function scrapeEmails() {
    const html = document.body?.innerHTML || '';
    const text = document.body?.innerText || '';
    const source = `${text}\n${html.replace(/<[^>]+>/g, ' ')}`;

    // 先整体归一化，再统一抽取 —— 单条正则处理不了 "a (dot) b (dot) edu" 这种多级域名
    const normalized = source
      .replace(/([A-Za-z0-9._%+-]+)\s*(?:\(|\[)?\s*(?:at|AT)\s*(?:\)|\])?\s*(?=[A-Za-z0-9-])/g, '$1@')
      .replace(/([A-Za-z0-9-])\s*(?:\(|\[)?\s*(?:dot|DOT)\s*(?:\)|\])?\s*(?=[A-Za-z0-9])/g, '$1.');

    const found = new Set();
    for (const match of `${source}\n${normalized}`.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) {
      found.add(match[0].replace(/[.,;:]+$/, ''));
    }

    return [...found]
      .filter((email) => {
        const lower = email.toLowerCase();
        if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(lower)) return false;
        if (lower.startsWith('@') || /\d+x\./.test(lower)) return false;
        return lower.length <= 80;
      })
      .slice(0, 30);
  }

  function scrapeLinks() {
    const seen = new Set();
    const links = [];

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.href;
      if (!/^https?:/i.test(href)) continue;
      if (href.startsWith(location.href.split('#')[0]) && href.includes('#')) continue;
      if (/\.(css|js|png|jpe?g|gif|svg|ico|zip)$/i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      links.push({
        text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        href
      });
      if (links.length >= 150) break;
    }
    return links;
  }
})();
