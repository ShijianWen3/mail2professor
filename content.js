// content.js - 注入到页面中，提取文本内容

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageContent') {
    const content = extractPageContent();
    sendResponse({ content });
  }
  return true;
});

function extractPageContent() {
  // 移除无用标签
  const cloned = document.body.cloneNode(true);
  ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript'].forEach(tag => {
    cloned.querySelectorAll(tag).forEach(el => el.remove());
  });

  // 提取主要文本，清理多余空白
  let text = cloned.innerText || cloned.textContent || '';
  text = text.replace(/\s+/g, ' ').trim();

  // 截取前8000字符，避免超出token限制
  return text.substring(0, 8000);
}
